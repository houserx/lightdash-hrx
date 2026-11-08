//! `traceql(query, start, end[, limit = 20, source])` (CONTRACTS §1.1): a Tempo TraceQL search
//! (`GET /api/search`) as a table of `trace_id text, root_service text, root_name text, start
//! timestamptz, duration_ms float8, span_count int8`, one row per trace Tempo returns.
//!
//! As with `promql`, the arguments are constants checked when the statement is planned, and the
//! query goes to Tempo unchanged (`q`) when the table is scanned, with `start` and `end` as Unix
//! seconds (start rounded down, end rounded up, so the range is never narrowed) and `limit`.
//!
//! Tempo's search JSON is the protobuf JSON mapping, which leaves out zero values: a missing
//! `durationMs` is 0 ms and a missing `matched` is 0 spans. `span_count` is the number of spans
//! that matched the query, summed over the trace's span sets (`spanSets`, else the older single
//! `spanSet`); the search answer carries no total span count. Trace ids are lowercase hex padded
//! to 32 digits (Tempo drops leading zeros), the form `trace()` takes.

use std::sync::Arc;

use async_trait::async_trait;
use datafusion::arrow::array::{
    ArrayRef, Float64Builder, Int64Builder, StringBuilder, TimestampMicrosecondBuilder,
};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::catalog::memory::MemorySourceConfig;
use datafusion::catalog::{Session, TableFunctionArgs, TableFunctionImpl, TableProvider};
use datafusion::common::ScalarValue;
use datafusion::error::DataFusionError;
use datafusion::logical_expr::{Expr, TableType};
use datafusion::physical_plan::ExecutionPlan;
use engine_config::{Config, SourceKind};
use serde_json::Value;

use crate::promql::{UTC, constant, text_argument, time_argument};
use crate::session::sqlstate;
use crate::sources::{HttpSource, HttpSources};

const SIGNATURE: &str = "traceql(query, start, end[, limit, source])";
const DEFAULT_LIMIT: i64 = 20;
/// How much of a Tempo error body goes into the SQL error.
const ERROR_BODY_CHARS: usize = 500;

/// The columns of `traceql`.
pub fn search_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("trace_id", DataType::Utf8, false),
        Field::new("root_service", DataType::Utf8, true),
        Field::new("root_name", DataType::Utf8, true),
        Field::new(
            "start",
            DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())),
            true,
        ),
        Field::new("duration_ms", DataType::Float64, true),
        Field::new("span_count", DataType::Int64, true),
    ]))
}

/// The configured Tempo sources and the HTTP client that queries them.
#[derive(Debug, Clone)]
pub struct Traceql {
    sources: HttpSources,
    http: reqwest::Client,
}

impl Traceql {
    pub fn new(config: &Config, http: reqwest::Client) -> Traceql {
        Traceql {
            sources: HttpSources::new(config, SourceKind::Tempo),
            http,
        }
    }
}

impl TableFunctionImpl for Traceql {
    fn call_with_args(
        &self,
        args: TableFunctionArgs,
    ) -> datafusion::error::Result<Arc<dyn TableProvider>> {
        let exprs = args.exprs();
        if !(3..=5).contains(&exprs.len()) {
            return Err(sqlstate(
                "42883",
                format!("{SIGNATURE} takes 3 to 5 arguments, not {}", exprs.len()),
            ));
        }
        let session = args.session();
        let arg = |i: usize| constant(&exprs[i], session, SIGNATURE);
        let query = text_argument(arg(0)?, "query", SIGNATURE)?;
        let start = time_argument(arg(1)?, "start", SIGNATURE)?;
        let end = time_argument(arg(2)?, "end", SIGNATURE)?;
        if end < start {
            return Err(sqlstate("22023", format!("{SIGNATURE}: end is before start")));
        }
        let limit = match exprs.get(3) {
            Some(_) => limit_argument(arg(3)?)?,
            None => DEFAULT_LIMIT,
        };
        let source = match exprs.get(4) {
            Some(_) => Some(text_argument(arg(4)?, "source", SIGNATURE)?),
            None => None,
        };
        Ok(Arc::new(TraceqlQuery {
            http: self.http.clone(),
            source: self.sources.resolve(source, session)?,
            params: vec![
                ("q", query),
                ("start", start.div_euclid(1_000_000).to_string()),
                ("end", (end + 999_999).div_euclid(1_000_000).to_string()),
                ("limit", limit.to_string()),
            ],
        }))
    }
}

/// A positive integer `limit`.
fn limit_argument(value: ScalarValue) -> Result<i64, DataFusionError> {
    if value.is_null() {
        return Err(sqlstate("22004", format!("{SIGNATURE}: limit is NULL")));
    }
    if !value.data_type().is_integer() {
        return Err(sqlstate(
            "42804",
            format!(
                "{SIGNATURE}: limit must be an integer, not {}",
                value.data_type()
            ),
        ));
    }
    let shown = value.to_string();
    match value.cast_to(&DataType::Int64) {
        Ok(ScalarValue::Int64(Some(n))) if n > 0 => Ok(n),
        _ => Err(sqlstate(
            "22023",
            format!("{SIGNATURE}: invalid limit {shown}: expected a positive integer"),
        )),
    }
}

/// One `traceql()` call: the search to send and where.
#[derive(Debug)]
struct TraceqlQuery {
    http: reqwest::Client,
    source: HttpSource,
    params: Vec<(&'static str, String)>,
}

impl TraceqlQuery {
    async fn fetch(&self) -> Result<Value, DataFusionError> {
        let source = &self.source.name;
        let response = self
            .http
            .get(format!("{}/api/search", self.source.url))
            .query(&self.params)
            .send()
            .await
            .map_err(|e| {
                DataFusionError::Execution(format!("tempo source \"{source}\" is unreachable: {e}"))
            })?;
        let status = response.status();
        let body = response.bytes().await.map_err(|e| {
            DataFusionError::Execution(format!(
                "tempo source \"{source}\": reading the response failed: {e}"
            ))
        })?;
        tempo_answer(source, status.as_u16(), &body)
    }
}

/// A Tempo JSON answer (search or trace), or an error naming the source and what it said. Tempo answers query
/// errors (a TraceQL parse error, a range too long) with a plain-text body, which is quoted
/// (shortened).
pub(crate) fn tempo_answer(source: &str, status: u16, body: &[u8]) -> Result<Value, DataFusionError> {
    let fail =
        |what: String| DataFusionError::Execution(format!("tempo source \"{source}\": {what}"));
    if !(200..300).contains(&status) {
        let text: String = String::from_utf8_lossy(body)
            .trim()
            .chars()
            .take(ERROR_BODY_CHARS)
            .collect();
        return Err(fail(format!("HTTP {status}: {text}")));
    }
    serde_json::from_slice::<Value>(body)
        .ok()
        .filter(|answer| answer.is_object())
        .ok_or_else(|| {
            fail(format!(
                "HTTP {status} with a response that is not Tempo JSON"
            ))
        })
}

/// One row per trace of a search answer, in Tempo's order. More than `max_rows` traces fails
/// with SQLSTATE 54000.
fn search_batch(
    source: &str,
    answer: &Value,
    max_rows: usize,
) -> Result<RecordBatch, DataFusionError> {
    let fail =
        |what: &str| DataFusionError::Execution(format!("tempo source \"{source}\": {what}"));
    let traces: &[Value] = match &answer["traces"] {
        Value::Null => &[],
        Value::Array(traces) => traces,
        _ => return Err(fail("the search answer's traces are not a list")),
    };
    if traces.len() > max_rows {
        return Err(sqlstate(
            "54000",
            format!("result exceeds max_rows ({max_rows}) for source \"{source}\""),
        ));
    }
    let mut ids = StringBuilder::new();
    let mut services = StringBuilder::new();
    let mut names = StringBuilder::new();
    let mut starts = TimestampMicrosecondBuilder::new().with_timezone(UTC);
    let mut durations = Float64Builder::new();
    let mut counts = Int64Builder::new();
    for t in traces {
        let id = t["traceID"]
            .as_str()
            .and_then(trace_id)
            .ok_or_else(|| fail("a trace has no hex traceID"))?;
        ids.append_value(id);
        services.append_option(t["rootServiceName"].as_str());
        names.append_option(t["rootTraceName"].as_str());
        let start = match &t["startTimeUnixNano"] {
            Value::Null => None,
            v => Some(unix_nanos(v).ok_or_else(|| fail("a trace has a malformed start"))?),
        };
        starts.append_option(start.map(|ns| ns.div_euclid(1000)));
        let duration = match &t["durationMs"] {
            Value::Null => 0.0,
            v => v
                .as_f64()
                .ok_or_else(|| fail("a trace has a malformed durationMs"))?,
        };
        durations.append_value(duration);
        counts.append_option(matched_spans(t));
    }
    let columns: Vec<ArrayRef> = vec![
        Arc::new(ids.finish()),
        Arc::new(services.finish()),
        Arc::new(names.finish()),
        Arc::new(starts.finish()),
        Arc::new(durations.finish()),
        Arc::new(counts.finish()),
    ];
    Ok(RecordBatch::try_new(search_schema(), columns)?)
}

/// A hex trace id, lowercase and padded to 32 digits.
pub(crate) fn trace_id(id: &str) -> Option<String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("{:0>32}", id.to_ascii_lowercase()))
}

/// Nanoseconds since the Unix epoch, as uint64 text (protobuf JSON) or a number.
fn unix_nanos(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => s.parse().ok(),
        n => n.as_i64(),
    }
}

/// Spans that matched, summed over `spanSets` (else the single `spanSet`); `None` when the
/// answer has neither.
fn matched_spans(trace: &Value) -> Option<i64> {
    let matched = |set: &Value| set["matched"].as_i64().unwrap_or(0);
    match (&trace["spanSets"], &trace["spanSet"]) {
        (Value::Array(sets), _) => Some(sets.iter().map(matched).sum()),
        (_, set @ Value::Object(_)) => Some(matched(set)),
        _ => None,
    }
}

#[async_trait]
impl TableProvider for TraceqlQuery {
    fn schema(&self) -> SchemaRef {
        search_schema()
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
        let answer = self.fetch().await?;
        let batch = search_batch(&self.source.name, &answer, self.source.max_rows)?;
        Ok(MemorySourceConfig::try_new_exec(
            &[vec![batch]],
            self.schema(),
            projection.cloned(),
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::arrow::array::{Array, AsArray};
    use datafusion::arrow::datatypes::{Float64Type, Int64Type, TimestampMicrosecondType};
    use serde_json::json;

    #[test]
    fn traces_become_one_row_each() {
        let answer = json!({"traces": [
            {"traceID": "2F3E0CEE77AE5DC9C17ADE3689EB2E54", "rootServiceName": "web",
             "rootTraceName": "GET /orders", "startTimeUnixNano": "1762560000500000000",
             "durationMs": 557, "spanSet": {"spans": [], "matched": 3},
             "spanSets": [{"spans": [], "matched": 3}, {"spans": [], "matched": 2}]},
            {"traceID": "af7651916cd43dd8448eb211c80319c", "startTimeUnixNano": "1762560010000000000",
             "spanSet": {"spans": []}},
            {"traceID": "1"},
        ], "metrics": {"inspectedTraces": 3}});
        let batch = search_batch("t", &answer, usize::MAX).unwrap();
        assert_eq!(batch.num_rows(), 3);
        let ids = batch.column(0).as_string::<i32>();
        assert_eq!(ids.value(0), "2f3e0cee77ae5dc9c17ade3689eb2e54");
        assert_eq!(ids.value(1), "0af7651916cd43dd8448eb211c80319c");
        assert_eq!(ids.value(2), format!("{:0>32}", "1"));
        assert_eq!(batch.column(1).as_string::<i32>().value(0), "web");
        assert!(batch.column(1).is_null(1));
        assert_eq!(batch.column(2).as_string::<i32>().value(0), "GET /orders");
        let t = batch.column(3).as_primitive::<TimestampMicrosecondType>();
        assert_eq!(t.value(0), 1_762_560_000_500_000);
        assert!(t.is_null(2));
        let d = batch.column(4).as_primitive::<Float64Type>();
        assert_eq!((d.value(0), d.value(1)), (557.0, 0.0));
        let n = batch.column(5).as_primitive::<Int64Type>();
        assert_eq!((n.value(0), n.value(1)), (5, 0));
        assert!(n.is_null(2));
        assert_eq!(search_batch("t", &json!({}), usize::MAX).unwrap().num_rows(), 0);
    }

    #[test]
    fn malformed_answers_and_too_many_traces_are_errors() {
        let two = json!({"traces": [{"traceID": "a"}, {"traceID": "b"}]});
        assert_eq!(search_batch("t", &two, 2).unwrap().num_rows(), 2);
        let e = search_batch("t", &two, 1).unwrap_err().to_string();
        assert!(e.contains("result exceeds max_rows (1)"), "{e}");
        for bad in [
            json!({"traces": {}}),
            json!({"traces": [{"rootServiceName": "web"}]}),
            json!({"traces": [{"traceID": "not hex"}]}),
            json!({"traces": [{"traceID": "a", "startTimeUnixNano": "soon"}]}),
        ] {
            let e = search_batch("tempo-a", &bad, usize::MAX).unwrap_err().to_string();
            assert!(e.contains("tempo source \"tempo-a\""), "{e}");
        }
    }

    #[test]
    fn tempo_errors_name_the_source() {
        let e = tempo_answer("tempo-a", 400, b"invalid TraceQL query: parse error at line 1")
            .unwrap_err()
            .to_string();
        assert!(e.contains("tempo-a") && e.contains("HTTP 400: invalid TraceQL"), "{e}");
        assert!(tempo_answer("t", 200, b"<html>").is_err());
        assert!(tempo_answer("t", 200, br#"{"traces": []}"#).is_ok());
    }

    #[test]
    fn limit_is_a_positive_integer() {
        assert_eq!(limit_argument(ScalarValue::Int64(Some(5))).unwrap(), 5);
        assert_eq!(limit_argument(ScalarValue::Int32(Some(7))).unwrap(), 7);
        for bad in [
            ScalarValue::Int64(Some(0)),
            ScalarValue::Int64(Some(-1)),
            ScalarValue::Int64(None),
            ScalarValue::Utf8(Some("5".into())),
        ] {
            assert!(limit_argument(bad.clone()).is_err(), "{bad:?}");
        }
    }
}
