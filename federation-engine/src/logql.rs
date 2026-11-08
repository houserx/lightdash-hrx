//! `logql(query, start, end[, limit, direction, source])` (CONTRACTS §1.1): a Loki `query_range`
//! for log streams as a table of `timestamp timestamptz, line text, labels json, stream text`,
//! one row per log line.
//!
//! As with `promql`, the arguments are constants checked when the statement is planned, and the
//! query goes to Loki unchanged when the table is scanned. Loki's nanosecond timestamps are kept
//! to the microsecond (timestamptz precision), truncated.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use datafusion::arrow::array::{ArrayRef, StringBuilder, TimestampMicrosecondBuilder};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::catalog::memory::MemorySourceConfig;
use datafusion::catalog::{Session, TableFunctionArgs, TableFunctionImpl, TableProvider};
use datafusion::common::ScalarValue;
use datafusion::error::DataFusionError;
use datafusion::logical_expr::{Expr, TableType};
use datafusion::physical_plan::ExecutionPlan;
use engine_config::{Config, SourceKind};
use serde_json::{Map, Value};

use crate::promql::{
    EXTENSION_NAME_KEY, JSON_EXTENSION, UTC, constant, series_name, text_argument, time_argument,
};
use crate::session::sqlstate;
use crate::sources::{HttpSource, HttpSources};

const SIGNATURE: &str = "logql(query, start, end[, limit, direction, source])";
const DEFAULT_LIMIT: i64 = 1000;
const DEFAULT_DIRECTION: &str = "backward";
/// How much of a non-JSON Loki error body goes into the SQL error.
const ERROR_BODY_CHARS: usize = 500;

/// The columns of `logql`.
pub fn stream_schema() -> SchemaRef {
    let json = HashMap::from([(EXTENSION_NAME_KEY.to_string(), JSON_EXTENSION.to_string())]);
    Arc::new(Schema::new(vec![
        Field::new(
            "timestamp",
            DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())),
            false,
        ),
        Field::new("line", DataType::Utf8, false),
        Field::new("labels", DataType::Utf8, false).with_metadata(json),
        Field::new("stream", DataType::Utf8, false),
    ]))
}

/// The configured Loki sources and the HTTP client that queries them, as `logql`.
#[derive(Debug, Clone)]
pub struct Logql {
    sources: HttpSources,
    http: reqwest::Client,
}

impl Logql {
    pub fn new(config: &Config, http: reqwest::Client) -> Logql {
        Logql {
            sources: HttpSources::new(config, SourceKind::Loki),
            http,
        }
    }
}

impl TableFunctionImpl for Logql {
    fn call_with_args(
        &self,
        args: TableFunctionArgs,
    ) -> datafusion::error::Result<Arc<dyn TableProvider>> {
        let exprs = args.exprs();
        if !(3..=6).contains(&exprs.len()) {
            return Err(sqlstate(
                "42883",
                format!("{SIGNATURE} takes 3 to 6 arguments, not {}", exprs.len()),
            ));
        }
        let session = args.session();
        let arg = |i: usize| constant(&exprs[i], session, SIGNATURE);
        let query = text_argument(arg(0)?, "query", SIGNATURE)?;
        let start = time_argument(arg(1)?, "start", SIGNATURE)?;
        let end = time_argument(arg(2)?, "end", SIGNATURE)?;
        let limit = match exprs.get(3) {
            Some(_) => limit_argument(arg(3)?)?,
            None => DEFAULT_LIMIT,
        };
        let direction = match exprs.get(4) {
            Some(_) => direction_argument(text_argument(arg(4)?, "direction", SIGNATURE)?)?,
            None => DEFAULT_DIRECTION.to_string(),
        };
        let source = match exprs.get(5) {
            Some(_) => Some(text_argument(arg(5)?, "source", SIGNATURE)?),
            None => None,
        };
        let source = self.sources.resolve(source)?;
        Ok(Arc::new(LogqlQuery {
            http: self.http.clone(),
            source,
            form: vec![
                ("query", query),
                ("start", nanos_text(start)),
                ("end", nanos_text(end)),
                ("limit", limit.to_string()),
                ("direction", direction),
            ],
        }))
    }
}

/// A positive integer `limit`.
fn limit_argument(value: ScalarValue) -> Result<i64, DataFusionError> {
    if value.is_null() {
        return Err(sqlstate("22004", format!("{SIGNATURE}: limit is NULL")));
    }
    let shown = value.to_string();
    let limit = match value.data_type() {
        t if t.is_integer() => match value.cast_to(&DataType::Int64) {
            Ok(ScalarValue::Int64(Some(n))) => Some(n),
            _ => None,
        },
        _ => {
            return Err(sqlstate(
                "42804",
                format!(
                    "{SIGNATURE}: limit must be an integer, not {}",
                    value.data_type()
                ),
            ));
        }
    };
    match limit {
        Some(n) if n > 0 => Ok(n),
        _ => Err(sqlstate(
            "22023",
            format!("{SIGNATURE}: invalid limit {shown}: expected a positive integer"),
        )),
    }
}

/// `forward` or `backward`, in any case, sent in lower case.
fn direction_argument(direction: String) -> Result<String, DataFusionError> {
    let lower = direction.to_ascii_lowercase();
    if lower == "forward" || lower == "backward" {
        return Ok(lower);
    }
    Err(sqlstate(
        "22023",
        format!("{SIGNATURE}: invalid direction \"{direction}\": expected 'forward' or 'backward'"),
    ))
}

/// µs since the Unix epoch as Loki's nanosecond integer text.
fn nanos_text(us: i64) -> String {
    (i128::from(us) * 1000).to_string()
}

/// One `logql()` call: the request to send and where.
#[derive(Debug)]
struct LogqlQuery {
    http: reqwest::Client,
    source: HttpSource,
    form: Vec<(&'static str, String)>,
}

impl LogqlQuery {
    async fn fetch(&self) -> Result<Value, DataFusionError> {
        let source = &self.source.name;
        let response = self
            .http
            .post(format!("{}/loki/api/v1/query_range", self.source.url))
            .form(&self.form)
            .send()
            .await
            .map_err(|e| {
                DataFusionError::Execution(format!("loki source \"{source}\" is unreachable: {e}"))
            })?;
        let status = response.status();
        let body = response.bytes().await.map_err(|e| {
            DataFusionError::Execution(format!(
                "loki source \"{source}\": reading the response failed: {e}"
            ))
        })?;
        loki_data(source, status.as_u16(), &body)
    }
}

/// The `data` of a Loki answer, or an error naming the source and what it said. Loki answers
/// query errors with a plain-text body, so a non-JSON error body is quoted (shortened).
fn loki_data(source: &str, status: u16, body: &[u8]) -> Result<Value, DataFusionError> {
    let fail =
        |what: String| DataFusionError::Execution(format!("loki source \"{source}\": {what}"));
    let ok = (200..300).contains(&status);
    let Ok(mut answer) = serde_json::from_slice::<Value>(body) else {
        if ok {
            return Err(fail(format!(
                "HTTP {status} with a response that is not Loki JSON"
            )));
        }
        let text: String = String::from_utf8_lossy(body)
            .trim()
            .chars()
            .take(ERROR_BODY_CHARS)
            .collect();
        return Err(fail(format!("HTTP {status}: {text}")));
    };
    if answer["status"] != "success" {
        let error = answer["error"]
            .as_str()
            .or_else(|| answer["message"].as_str())
            .unwrap_or("no error message");
        return Err(fail(format!("HTTP {status}: {error}")));
    }
    if !ok {
        return Err(fail(format!("HTTP {status}")));
    }
    Ok(answer["data"].take())
}

/// One row per log line of a `streams` answer, streams in Loki's order and lines in each
/// stream's order. A metric query (a `matrix` answer) belongs in `logql_metric`. More than
/// `max_rows` lines fails with SQLSTATE 54000.
fn stream_batch(
    source: &str,
    data: &Value,
    max_rows: usize,
) -> Result<RecordBatch, DataFusionError> {
    let fail =
        |what: &str| DataFusionError::Execution(format!("loki source \"{source}\": {what}"));
    match data["resultType"].as_str() {
        Some("streams") => {}
        Some("matrix") | Some("vector") => {
            return Err(sqlstate(
                "42809",
                format!(
                    "loki source \"{source}\" answered a metric query; use logql_metric for it"
                ),
            ));
        }
        _ => return Err(fail("the answer has an unknown resultType")),
    }
    let streams = data["result"]
        .as_array()
        .ok_or_else(|| fail("the streams have no result list"))?;
    let mut timestamps = TimestampMicrosecondBuilder::new().with_timezone(UTC);
    let mut lines = StringBuilder::new();
    let mut labels = StringBuilder::new();
    let mut names = StringBuilder::new();
    let mut count = 0;
    for s in streams {
        let stream: &Map<String, Value> = s["stream"]
            .as_object()
            .ok_or_else(|| fail("a stream has no labels"))?;
        let entries = s["values"]
            .as_array()
            .ok_or_else(|| fail("a stream has no values"))?;
        let json = Value::Object(stream.clone()).to_string();
        let name = series_name(stream);
        for entry in entries {
            let (t, line) = parse_entry(entry).ok_or_else(|| fail("a log entry is malformed"))?;
            if count == max_rows {
                return Err(sqlstate(
                    "54000",
                    format!("result exceeds max_rows ({max_rows}) for source \"{source}\""),
                ));
            }
            count += 1;
            timestamps.append_value(t);
            lines.append_value(line);
            labels.append_value(&json);
            names.append_value(&name);
        }
    }
    let columns: Vec<ArrayRef> = vec![
        Arc::new(timestamps.finish()),
        Arc::new(lines.finish()),
        Arc::new(labels.finish()),
        Arc::new(names.finish()),
    ];
    Ok(RecordBatch::try_new(stream_schema(), columns)?)
}

/// `["<unix ns>", "<line>"(, metadata)]` as (µs, line). The ns are truncated to µs.
fn parse_entry(entry: &Value) -> Option<(i64, &str)> {
    let ns: i64 = match entry.get(0)? {
        Value::String(s) => s.parse().ok()?,
        n => n.as_i64()?,
    };
    let line = entry.get(1)?.as_str()?;
    Some((ns.div_euclid(1000), line))
}

#[async_trait]
impl TableProvider for LogqlQuery {
    fn schema(&self) -> SchemaRef {
        stream_schema()
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
        let batch = stream_batch(&self.source.name, &data, self.source.max_rows)?;
        Ok(MemorySourceConfig::try_new_exec(
            &[vec![batch]],
            stream_schema(),
            projection.cloned(),
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::arrow::array::AsArray;
    use datafusion::arrow::datatypes::TimestampMicrosecondType;
    use serde_json::json;

    #[test]
    fn streams_become_one_row_per_line() {
        let data = json!({"resultType": "streams", "result": [
            {"stream": {"level": "error", "app": "api"},
             "values": [["1762560000123456789", "boom 1"], ["1762560001000000000", "boom 2"]]},
            {"stream": {"app": "api", "level": "warn"},
             "values": [["1762560002000000000", "careful", {"structuredMetadata": {}}]]},
        ]});
        let batch = stream_batch("l", &data, usize::MAX).unwrap();
        assert_eq!(batch.num_rows(), 3);
        let t = batch.column(0).as_primitive::<TimestampMicrosecondType>();
        assert_eq!(t.value(0), 1_762_560_000_123_456);
        assert_eq!(batch.column(1).as_string::<i32>().value(2), "careful");
        assert_eq!(
            batch.column(2).as_string::<i32>().value(0),
            r#"{"app":"api","level":"error"}"#
        );
        assert_eq!(
            batch.column(3).as_string::<i32>().value(1),
            r#"{app="api",level="error"}"#
        );
        let empty = json!({"resultType": "streams", "result": []});
        assert_eq!(stream_batch("l", &empty, usize::MAX).unwrap().num_rows(), 0);
    }

    #[test]
    fn metric_answers_and_too_many_lines_are_errors() {
        let matrix = json!({"resultType": "matrix", "result": []});
        let e = stream_batch("l", &matrix, usize::MAX).unwrap_err().to_string();
        assert!(e.contains("logql_metric"), "{e}");
        let data = json!({"resultType": "streams", "result": [
            {"stream": {}, "values": [["1", "a"], ["2", "b"]]},
        ]});
        assert_eq!(stream_batch("l", &data, 2).unwrap().num_rows(), 2);
        let e = stream_batch("l", &data, 1).unwrap_err().to_string();
        assert!(e.contains("result exceeds max_rows (1)"), "{e}");
    }

    #[test]
    fn arguments_are_checked() {
        assert_eq!(limit_argument(ScalarValue::Int64(Some(50))).unwrap(), 50);
        assert_eq!(limit_argument(ScalarValue::Int32(Some(7))).unwrap(), 7);
        for bad in [
            ScalarValue::Int64(Some(0)),
            ScalarValue::Int64(Some(-1)),
            ScalarValue::Int64(None),
            ScalarValue::Utf8(Some("50".into())),
        ] {
            assert!(limit_argument(bad.clone()).is_err(), "{bad:?}");
        }
        assert_eq!(direction_argument("FORWARD".into()).unwrap(), "forward");
        assert!(direction_argument("sideways".into()).is_err());
        assert_eq!(nanos_text(1_762_560_000_000_000), "1762560000000000000");
    }

    #[test]
    fn loki_errors_name_the_source() {
        let e = loki_data("loki-a", 400, b"parse error at line 1, col 2: syntax error")
            .unwrap_err()
            .to_string();
        assert!(e.contains("loki-a") && e.contains("HTTP 400: parse error"), "{e}");
        let ok = br#"{"status":"success","data":{"resultType":"streams","result":[]}}"#;
        assert_eq!(loki_data("l", 200, ok).unwrap()["resultType"], "streams");
        assert!(loki_data("l", 200, b"<html>").is_err());
    }
}
