//! `promql(query, start, end, step[, source])` and `promql_instant(query, at[, source])`
//! (CONTRACTS §1.1): a Prometheus `query_range` or instant `query` as a table of
//! `timestamp timestamptz, value float8, labels json, series text`, one row per sample.
//!
//! The arguments are constants evaluated when the statement is planned, so a bad argument fails
//! before anything is sent. The query goes to the source unchanged when the table is scanned
//! (at execution, not at Parse or Describe); SQL on top of it runs in DataFusion.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use datafusion::arrow::array::{
    ArrayRef, Float64Builder, StringBuilder, TimestampMicrosecondBuilder,
};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::catalog::memory::MemorySourceConfig;
use datafusion::catalog::{Session, TableFunctionArgs, TableFunctionImpl, TableProvider};
use datafusion::common::ScalarValue;
use datafusion::error::DataFusionError;
use datafusion::logical_expr::simplify::SimplifyContext;
use datafusion::logical_expr::{Expr, TableType};
use datafusion::optimizer::simplify_expressions::ExprSimplifier;
use datafusion::physical_plan::ExecutionPlan;
use engine_config::{Config, SourceKind, SourceSettings};
use serde_json::Value;

use crate::session::sqlstate;

/// Arrow field metadata that marks a Utf8 column as Postgres `json` (OID 114).
pub const EXTENSION_NAME_KEY: &str = "ARROW:extension:name";
/// The canonical Arrow JSON extension type name.
pub const JSON_EXTENSION: &str = "arrow.json";

/// The zone result timestamps carry (sent as timestamptz).
const UTC: &str = "+00:00";

const RANGE_SIGNATURE: &str = "promql(query, start, end, step[, source])";
const INSTANT_SIGNATURE: &str = "promql_instant(query, at[, source])";

/// The result columns shared by the PromQL-shaped functions.
pub fn sample_schema() -> SchemaRef {
    let json = HashMap::from([(EXTENSION_NAME_KEY.to_string(), JSON_EXTENSION.to_string())]);
    Arc::new(Schema::new(vec![
        Field::new(
            "timestamp",
            DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())),
            false,
        ),
        Field::new("value", DataType::Float64, true),
        Field::new("labels", DataType::Utf8, false).with_metadata(json),
        Field::new("series", DataType::Utf8, false),
    ]))
}

/// The configured Prometheus sources and the HTTP client that queries them, as `promql` (a
/// range query) or, after [`Promql::instant`], as `promql_instant`.
#[derive(Debug, Clone)]
pub struct Promql {
    /// Base URL by source name, for every `prometheus` source.
    urls: HashMap<String, String>,
    /// Kind by source name, for every source (to name a kind mismatch).
    kinds: HashMap<String, SourceKind>,
    /// Restricted sources need an identity, which this engine doesn't check yet.
    restricted: Vec<String>,
    default: Option<String>,
    http: reqwest::Client,
    instant: bool,
}

impl Promql {
    pub fn new(config: &Config, http: reqwest::Client) -> Promql {
        let urls = config
            .sources
            .iter()
            .filter_map(|s| match &s.settings {
                SourceSettings::Prometheus { url } => {
                    Some((s.name.clone(), url.trim_end_matches('/').to_string()))
                }
                _ => None,
            })
            .collect();
        Promql {
            urls,
            kinds: config
                .sources
                .iter()
                .map(|s| (s.name.clone(), s.kind()))
                .collect(),
            restricted: config
                .sources
                .iter()
                .filter(|s| s.restricted)
                .map(|s| s.name.clone())
                .collect(),
            default: config
                .default_source(SourceKind::Prometheus)
                .map(|s| s.name.clone()),
            http,
            instant: false,
        }
    }

    /// The same sources as `promql_instant(query, at[, source])`.
    pub fn instant(self) -> Promql {
        Promql {
            instant: true,
            ..self
        }
    }

    fn signature(&self) -> &'static str {
        if self.instant {
            INSTANT_SIGNATURE
        } else {
            RANGE_SIGNATURE
        }
    }

    /// The source a call names, or the default Prometheus source.
    fn source(&self, name: Option<String>) -> Result<(String, String), DataFusionError> {
        let name = match name {
            Some(name) => name,
            None => self.default.clone().ok_or_else(|| {
                sqlstate(
                    "42704",
                    "there is no default prometheus source; name one as the source argument"
                        .to_string(),
                )
            })?,
        };
        let Some(url) = self.urls.get(&name) else {
            return Err(match self.kinds.get(&name) {
                Some(kind) => sqlstate(
                    "42809",
                    format!(
                        "source \"{name}\" is a {} source, not prometheus",
                        kind.as_str()
                    ),
                ),
                None => sqlstate("42704", format!("source \"{name}\" does not exist")),
            });
        };
        if self.restricted.contains(&name) {
            // Fail closed until identity tokens are verified (CONTRACTS §1.2).
            return Err(sqlstate(
                "42501",
                format!("source \"{name}\" is Restricted Telemetry and needs telemetry_restricted"),
            ));
        }
        Ok((name, url.clone()))
    }
}

impl TableFunctionImpl for Promql {
    fn call_with_args(
        &self,
        args: TableFunctionArgs,
    ) -> datafusion::error::Result<Arc<dyn TableProvider>> {
        let sig = self.signature();
        let exprs = args.exprs();
        let required = if self.instant { 2 } else { 4 };
        if !(required..=required + 1).contains(&exprs.len()) {
            return Err(sqlstate(
                "42883",
                format!(
                    "{sig} takes {required} or {} arguments, not {}",
                    required + 1,
                    exprs.len()
                ),
            ));
        }
        let session = args.session();
        let arg = |i: usize| constant(&exprs[i], session, sig);
        let query = text_argument(arg(0)?, "query", sig)?;
        let form = if self.instant {
            let at = time_argument(arg(1)?, "at", sig)?;
            vec![("query", query), ("time", seconds_text(at))]
        } else {
            let start = time_argument(arg(1)?, "start", sig)?;
            let end = time_argument(arg(2)?, "end", sig)?;
            let step = text_argument(arg(3)?, "step", sig)?;
            let step = parse_duration(&step).ok_or_else(|| {
                sqlstate(
                    "22023",
                    format!(
                        "invalid step \"{step}\": expected a positive duration such as 30s, 5m or 1h"
                    ),
                )
            })?;
            vec![
                ("query", query),
                ("start", seconds_text(start)),
                ("end", seconds_text(end)),
                ("step", seconds_text(step)),
            ]
        };
        let source = match exprs.get(required) {
            Some(_) => Some(text_argument(arg(required)?, "source", sig)?),
            None => None,
        };
        let (source, url) = self.source(source)?;
        Ok(Arc::new(PromqlQuery {
            http: self.http.clone(),
            source,
            url,
            instant: self.instant,
            form,
        }))
    }
}

/// Evaluates a table-function argument, which must be a constant expression.
fn constant(expr: &Expr, session: &dyn Session, sig: &str) -> Result<ScalarValue, DataFusionError> {
    let start = session
        .execution_props()
        .query_execution_start_time
        .unwrap_or_else(chrono::Utc::now);
    let context = SimplifyContext::builder()
        .with_config_options(Arc::new(session.config_options().clone()))
        .with_query_execution_start_time(Some(start))
        .build();
    match ExprSimplifier::new(context).simplify(expr.clone())? {
        Expr::Literal(value, _) => Ok(value),
        _ => Err(sqlstate(
            "0A000",
            format!("{sig}: arguments must be constants, not {expr}"),
        )),
    }
}

/// A non-NULL text argument.
fn text_argument(value: ScalarValue, name: &str, sig: &str) -> Result<String, DataFusionError> {
    match value {
        ScalarValue::Utf8(Some(s))
        | ScalarValue::LargeUtf8(Some(s))
        | ScalarValue::Utf8View(Some(s)) => Ok(s),
        v if v.is_null() => Err(sqlstate("22004", format!("{sig}: {name} is NULL"))),
        v => Err(sqlstate(
            "42804",
            format!("{sig}: {name} must be text, not {}", v.data_type()),
        )),
    }
}

/// A time argument (timestamptz, a timestamp read as UTC, or an ISO-8601 string) as µs since
/// the Unix epoch.
fn time_argument(value: ScalarValue, name: &str, sig: &str) -> Result<i64, DataFusionError> {
    if value.is_null() {
        return Err(sqlstate("22004", format!("{sig}: {name} is NULL")));
    }
    let shown = value.to_string();
    let target = DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into()));
    let micros = match value.data_type() {
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View | DataType::Timestamp(..) => {
            value.cast_to(&target).ok()
        }
        _ => None,
    };
    match micros {
        Some(ScalarValue::TimestampMicrosecond(Some(us), _)) => Ok(us),
        _ => Err(sqlstate(
            "22007",
            format!("{sig}: invalid {name} \"{shown}\": expected an ISO-8601 time or timestamptz"),
        )),
    }
}

/// A Prometheus duration (`30s`, `1h30m`, `500ms`) or a plain number of seconds, in µs.
/// `None` unless it is well-formed and positive.
pub fn parse_duration(s: &str) -> Option<i64> {
    if let Ok(secs) = s.parse::<f64>() {
        let us = (secs * 1e6).round();
        return (secs.is_finite() && us >= 1.0 && us < i64::MAX as f64).then_some(us as i64);
    }
    let mut total: i64 = 0;
    let mut rest = s;
    while !rest.is_empty() {
        let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 {
            return None;
        }
        let n: i64 = rest[..digits].parse().ok()?;
        rest = &rest[digits..];
        let (unit_us, len): (i64, usize) = if rest.starts_with("ms") {
            (1_000, 2)
        } else {
            let us = match rest.chars().next()? {
                's' => 1_000_000,
                'm' => 60_000_000,
                'h' => 3_600_000_000,
                'd' => 86_400_000_000,
                'w' => 604_800_000_000,
                'y' => 31_536_000_000_000,
                _ => return None,
            };
            (us, 1)
        };
        rest = &rest[len..];
        total = total.checked_add(n.checked_mul(unit_us)?)?;
    }
    (total > 0).then_some(total)
}

/// µs as decimal Unix seconds (`1762560000`, `1762560000.5`), which Prometheus accepts for
/// times and steps.
fn seconds_text(us: i64) -> String {
    let (secs, frac) = (us.div_euclid(1_000_000), us.rem_euclid(1_000_000));
    if frac == 0 {
        return secs.to_string();
    }
    format!("{secs}.{frac:06}")
        .trim_end_matches('0')
        .to_string()
}

/// One `promql()` or `promql_instant()` call: the request to send and where.
#[derive(Debug)]
struct PromqlQuery {
    http: reqwest::Client,
    source: String,
    url: String,
    /// `/api/v1/query` rather than `/api/v1/query_range`.
    instant: bool,
    form: Vec<(&'static str, String)>,
}

impl PromqlQuery {
    async fn fetch(&self) -> Result<Value, DataFusionError> {
        let source = &self.source;
        let path = if self.instant { "query" } else { "query_range" };
        let response = self
            .http
            .post(format!("{}/api/v1/{path}", self.url))
            .form(&self.form)
            .send()
            .await
            .map_err(|e| {
                DataFusionError::Execution(format!(
                    "prometheus source \"{source}\" is unreachable: {e}"
                ))
            })?;
        let status = response.status();
        let body = response.bytes().await.map_err(|e| {
            DataFusionError::Execution(format!(
                "prometheus source \"{source}\": reading the response failed: {e}"
            ))
        })?;
        prometheus_data(source, status.as_u16(), &body)
    }
}

/// The `data` of a Prometheus API answer, or an error naming the source and what it said.
fn prometheus_data(source: &str, status: u16, body: &[u8]) -> Result<Value, DataFusionError> {
    let fail = |what: String| {
        DataFusionError::Execution(format!("prometheus source \"{source}\": {what}"))
    };
    let Ok(mut answer) = serde_json::from_slice::<Value>(body) else {
        return Err(fail(format!(
            "HTTP {status} with a response that is not Prometheus JSON"
        )));
    };
    if answer["status"] != "success" {
        let kind = answer["errorType"].as_str().unwrap_or("error");
        let error = answer["error"].as_str().unwrap_or("no error message");
        return Err(fail(format!("HTTP {status}: {kind}: {error}")));
    }
    if !(200..300).contains(&status) {
        return Err(fail(format!("HTTP {status}")));
    }
    Ok(answer["data"].take())
}

/// The rows of a Prometheus answer's `data`. A range query must answer a matrix; an instant
/// query may answer a vector, a scalar (one row, labels `{}`), a string (one row, value NULL,
/// labels `{}`, series = the string; a contract assumption) or a matrix (e.g. `up[5m]`).
fn result_batch(source: &str, data: &Value, instant: bool) -> Result<RecordBatch, DataFusionError> {
    let fail =
        |what: &str| DataFusionError::Execution(format!("prometheus source \"{source}\": {what}"));
    let mut rows = Rows::default();
    let result = &data["result"];
    match data["resultType"].as_str() {
        Some("matrix") => {
            for s in result
                .as_array()
                .ok_or_else(|| fail("the matrix has no result list"))?
            {
                let metric = s["metric"]
                    .as_object()
                    .ok_or_else(|| fail("a series has no metric labels"))?;
                let samples = s["values"]
                    .as_array()
                    .ok_or_else(|| fail("a series has no values"))?;
                for sample in samples {
                    let (t, v) =
                        parse_sample(sample).ok_or_else(|| fail("a sample is malformed"))?;
                    rows.push(t, Some(v), metric, None);
                }
            }
        }
        _ if !instant => return Err(fail("query_range did not answer a matrix")),
        Some("vector") => {
            for s in result
                .as_array()
                .ok_or_else(|| fail("the vector has no result list"))?
            {
                let metric = s["metric"]
                    .as_object()
                    .ok_or_else(|| fail("a series has no metric labels"))?;
                let (t, v) =
                    parse_sample(&s["value"]).ok_or_else(|| fail("a sample is malformed"))?;
                rows.push(t, Some(v), metric, None);
            }
        }
        Some("scalar") => {
            let (t, v) = parse_sample(result).ok_or_else(|| fail("the scalar is malformed"))?;
            rows.push(t, Some(v), &serde_json::Map::new(), None);
        }
        Some("string") => {
            let t = result.get(0).and_then(Value::as_f64);
            let text = result.get(1).and_then(Value::as_str);
            let (Some(t), Some(text)) = (t, text) else {
                return Err(fail("the string is malformed"));
            };
            rows.push(micros(t), None, &serde_json::Map::new(), Some(text));
        }
        _ => return Err(fail("the answer has an unknown resultType")),
    }
    rows.finish()
}

/// Builds the columns of [`sample_schema`].
struct Rows {
    timestamps: TimestampMicrosecondBuilder,
    values: Float64Builder,
    labels: StringBuilder,
    series: StringBuilder,
    /// The last metric seen and its (labels json, series name), as a series' samples repeat it.
    last: Option<(serde_json::Map<String, Value>, String, String)>,
}

impl Default for Rows {
    fn default() -> Rows {
        Rows {
            timestamps: TimestampMicrosecondBuilder::new().with_timezone(UTC),
            values: Float64Builder::new(),
            labels: StringBuilder::new(),
            series: StringBuilder::new(),
            last: None,
        }
    }
}

impl Rows {
    /// One row. `series` overrides the name derived from the labels (a string answer).
    fn push(
        &mut self,
        t: i64,
        value: Option<f64>,
        metric: &serde_json::Map<String, Value>,
        series: Option<&str>,
    ) {
        if self.last.as_ref().is_none_or(|(m, _, _)| m != metric) {
            let json = Value::Object(metric.clone()).to_string();
            self.last = Some((metric.clone(), json, series_name(metric)));
        }
        let (_, json, name) = self.last.as_ref().expect("set above");
        self.timestamps.append_value(t);
        self.values.append_option(value);
        self.labels.append_value(json);
        self.series.append_value(series.unwrap_or(name));
    }

    fn finish(mut self) -> Result<RecordBatch, DataFusionError> {
        let columns: Vec<ArrayRef> = vec![
            Arc::new(self.timestamps.finish()),
            Arc::new(self.values.finish()),
            Arc::new(self.labels.finish()),
            Arc::new(self.series.finish()),
        ];
        Ok(RecordBatch::try_new(sample_schema(), columns)?)
    }
}

/// Unix seconds as µs.
fn micros(t: f64) -> i64 {
    (t * 1e6).round() as i64
}

/// `[<unix seconds>, "<value>"]` as (µs, value). Values may be `NaN`, `+Inf` or `-Inf`.
fn parse_sample(sample: &Value) -> Option<(i64, f64)> {
    let t = sample.get(0)?.as_f64()?;
    let v = sample.get(1)?.as_str()?;
    let v = match v {
        "NaN" => f64::NAN,
        "+Inf" | "Inf" => f64::INFINITY,
        "-Inf" => f64::NEG_INFINITY,
        v => v.parse().ok()?,
    };
    Some((micros(t), v))
}

/// The canonical series name `{k="v",...}`: keys sorted, values escaped as Prometheus prints
/// them (Go `strconv.Quote`).
pub fn series_name(labels: &serde_json::Map<String, Value>) -> String {
    let mut keys: Vec<&String> = labels.keys().collect();
    keys.sort();
    let pairs: Vec<String> = keys
        .into_iter()
        .map(|k| {
            let v = match &labels[k] {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            format!("{k}={}", quote(&v))
        })
        .collect();
    format!("{{{}}}", pairs.join(","))
}

fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{7}' => out.push_str("\\a"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\u{b}' => out.push_str("\\v"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\x{:02x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[async_trait]
impl TableProvider for PromqlQuery {
    fn schema(&self) -> SchemaRef {
        sample_schema()
    }

    fn table_type(&self) -> TableType {
        TableType::Temporary
    }

    async fn scan(
        &self,
        _state: &dyn Session,
        projection: Option<&Vec<usize>>,
        _filters: &[Expr],
        _limit: Option<usize>,
    ) -> datafusion::error::Result<Arc<dyn ExecutionPlan>> {
        let data = self.fetch().await?;
        let batch = result_batch(&self.source, &data, self.instant)?;
        Ok(MemorySourceConfig::try_new_exec(
            &[vec![batch]],
            sample_schema(),
            projection.cloned(),
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::arrow::array::{Array, AsArray};
    use datafusion::arrow::datatypes::{Float64Type, TimestampMicrosecondType};
    use serde_json::json;

    #[test]
    fn durations_follow_prometheus() {
        assert_eq!(parse_duration("30s"), Some(30_000_000));
        assert_eq!(parse_duration("1h30m"), Some(5_400_000_000));
        assert_eq!(parse_duration("500ms"), Some(500_000));
        assert_eq!(parse_duration("2d"), Some(172_800_000_000));
        assert_eq!(parse_duration("15"), Some(15_000_000));
        assert_eq!(parse_duration("0.5"), Some(500_000));
        for bad in ["", "abc", "0s", "0", "-5", "5x", "s", "1.5m", "NaN"] {
            assert_eq!(parse_duration(bad), None, "{bad}");
        }
    }

    #[test]
    fn seconds_are_decimal_text() {
        assert_eq!(seconds_text(1_762_560_000_000_000), "1762560000");
        assert_eq!(seconds_text(1_762_560_000_500_000), "1762560000.5");
        assert_eq!(seconds_text(30_000_000), "30");
    }

    #[test]
    fn series_names_sort_keys_and_escape_values() {
        let labels = json!({"pod": "a\"b\\c\nd", "__name__": "up", "job": "api"});
        assert_eq!(
            series_name(labels.as_object().unwrap()),
            r#"{__name__="up",job="api",pod="a\"b\\c\nd"}"#
        );
        assert_eq!(series_name(&serde_json::Map::new()), "{}");
    }

    #[test]
    fn a_matrix_becomes_one_row_per_sample() {
        let data = json!({"resultType": "matrix", "result": [
            {"metric": {"job": "api", "__name__": "x"},
             "values": [[1762560000, "1"], [1762560030.5, "NaN"], [1762560060, "+Inf"]]},
            {"metric": {}, "values": [[1762560000, "-Inf"]]},
        ]});
        let batch = result_batch("p", &data, false).unwrap();
        assert_eq!(batch.num_rows(), 4);
        let t = batch.column(0).as_primitive::<TimestampMicrosecondType>();
        assert_eq!(t.value(1), 1_762_560_030_500_000);
        let v = batch.column(1).as_primitive::<Float64Type>();
        assert_eq!(v.value(0), 1.0);
        assert!(v.value(1).is_nan());
        assert_eq!(v.value(2), f64::INFINITY);
        assert_eq!(v.value(3), f64::NEG_INFINITY);
        let labels = batch.column(2).as_string::<i32>();
        assert_eq!(labels.value(0), r#"{"__name__":"x","job":"api"}"#);
        assert_eq!(labels.value(3), "{}");
        let series = batch.column(3).as_string::<i32>();
        assert_eq!(series.value(0), r#"{__name__="x",job="api"}"#);
        assert_eq!(series.value(3), "{}");
        assert_eq!(batch.column(2).null_count(), 0);

        let empty = json!({"resultType": "matrix", "result": []});
        assert_eq!(result_batch("p", &empty, false).unwrap().num_rows(), 0);
        let vector = json!({"resultType": "vector", "result": []});
        assert!(result_batch("p", &vector, false).is_err());
    }

    #[test]
    fn instant_answers_of_every_type_become_rows() {
        let vector = json!({"resultType": "vector", "result": [
            {"metric": {"job": "api"}, "value": [1762560600, "3"]},
            {"metric": {"job": "worker"}, "value": [1762560600, "0.25"]},
        ]});
        let batch = result_batch("p", &vector, true).unwrap();
        assert_eq!(batch.num_rows(), 2);
        let t = batch.column(0).as_primitive::<TimestampMicrosecondType>();
        assert_eq!(t.value(0), 1_762_560_600_000_000);
        assert_eq!(batch.column(1).as_primitive::<Float64Type>().value(1), 0.25);
        assert_eq!(
            batch.column(3).as_string::<i32>().value(1),
            r#"{job="worker"}"#
        );

        let scalar = json!({"resultType": "scalar", "result": [1762560600, "42"]});
        let batch = result_batch("p", &scalar, true).unwrap();
        assert_eq!(batch.num_rows(), 1);
        assert_eq!(batch.column(1).as_primitive::<Float64Type>().value(0), 42.0);
        assert_eq!(batch.column(2).as_string::<i32>().value(0), "{}");
        assert_eq!(batch.column(3).as_string::<i32>().value(0), "{}");

        let string = json!({"resultType": "string", "result": [1762560600, "hello"]});
        let batch = result_batch("p", &string, true).unwrap();
        assert_eq!(batch.num_rows(), 1);
        assert!(batch.column(1).is_null(0));
        assert_eq!(batch.column(2).as_string::<i32>().value(0), "{}");
        assert_eq!(batch.column(3).as_string::<i32>().value(0), "hello");

        let matrix = json!({"resultType": "matrix", "result": [
            {"metric": {}, "values": [[1762560000, "1"], [1762560030, "2"]]},
        ]});
        assert_eq!(result_batch("p", &matrix, true).unwrap().num_rows(), 2);
        let odd = json!({"resultType": "histogram", "result": []});
        assert!(result_batch("p", &odd, true).is_err());
    }

    #[test]
    fn upstream_errors_name_the_source() {
        let body = br#"{"status":"error","errorType":"bad_data","error":"parse error"}"#;
        let e = prometheus_data("prom-a", 400, body)
            .unwrap_err()
            .to_string();
        assert!(
            e.contains("prom-a") && e.contains("bad_data: parse error"),
            "{e}"
        );
        let e = prometheus_data("prom-a", 503, b"<html>")
            .unwrap_err()
            .to_string();
        assert!(e.contains("HTTP 503"), "{e}");
        let ok = br#"{"status":"success","data":{"resultType":"matrix","result":[]}}"#;
        assert_eq!(
            prometheus_data("p", 200, ok).unwrap()["resultType"],
            "matrix"
        );
    }
}
