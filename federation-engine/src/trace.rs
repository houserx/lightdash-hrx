//! `trace(trace_id[, source])` (CONTRACTS §1.1): one Tempo trace (`GET /api/traces/<id>`) as a
//! table of `trace_id text, span_id text, parent_span_id text, service text, name text, start
//! timestamptz, duration_ms float8, status text, attributes json`, one row per span in Tempo's
//! order.
//!
//! Tempo answers with OTLP JSON in the protobuf JSON mapping: `{"batches": [...]}` (newer
//! versions: `resourceSpans`, or `{"trace": {"resourceSpans": ...}}`), ids as base64 and
//! zero values left out. Ids come back as lowercase hex; a missing, empty or all-zero parent is
//! NULL (a root span). `service` is the resource's `service.name`. `status` is `unset`, `ok` or
//! `error`. `attributes` is the span's own attributes as one flat JSON object, each OTLP
//! `AnyValue` as its JSON value (`intValue` as a number). An unknown trace (Tempo's 404) is zero
//! rows, not an error.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use datafusion::arrow::array::{ArrayRef, Float64Builder, StringBuilder, TimestampMicrosecondBuilder};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::catalog::memory::MemorySourceConfig;
use datafusion::catalog::{Session, TableFunctionArgs, TableFunctionImpl, TableProvider};
use datafusion::error::DataFusionError;
use datafusion::logical_expr::{Expr, TableType};
use datafusion::physical_plan::ExecutionPlan;
use engine_config::{Config, SourceKind};
use serde_json::{Map, Value};

use crate::promql::{EXTENSION_NAME_KEY, JSON_EXTENSION, UTC, constant, text_argument};
use crate::session::sqlstate;
use crate::sources::{HttpSource, HttpSources};
use crate::traceql::{tempo_answer, trace_id};

const SIGNATURE: &str = "trace(trace_id[, source])";

/// The columns of `trace`.
pub fn trace_schema() -> SchemaRef {
    let json = HashMap::from([(EXTENSION_NAME_KEY.to_string(), JSON_EXTENSION.to_string())]);
    Arc::new(Schema::new(vec![
        Field::new("trace_id", DataType::Utf8, false),
        Field::new("span_id", DataType::Utf8, false),
        Field::new("parent_span_id", DataType::Utf8, true),
        Field::new("service", DataType::Utf8, true),
        Field::new("name", DataType::Utf8, false),
        Field::new(
            "start",
            DataType::Timestamp(TimeUnit::Microsecond, Some(UTC.into())),
            true,
        ),
        Field::new("duration_ms", DataType::Float64, true),
        Field::new("status", DataType::Utf8, false),
        Field::new("attributes", DataType::Utf8, false).with_metadata(json),
    ]))
}

/// The configured Tempo sources and the HTTP client that queries them.
#[derive(Debug, Clone)]
pub struct Trace {
    sources: HttpSources,
    http: reqwest::Client,
}

impl Trace {
    pub fn new(config: &Config, http: reqwest::Client) -> Trace {
        Trace {
            sources: HttpSources::new(config, SourceKind::Tempo),
            http,
        }
    }
}

impl TableFunctionImpl for Trace {
    fn call_with_args(
        &self,
        args: TableFunctionArgs,
    ) -> datafusion::error::Result<Arc<dyn TableProvider>> {
        let exprs = args.exprs();
        if !(1..=2).contains(&exprs.len()) {
            return Err(sqlstate(
                "42883",
                format!("{SIGNATURE} takes 1 or 2 arguments, not {}", exprs.len()),
            ));
        }
        let session = args.session();
        let arg = |i: usize| constant(&exprs[i], session, SIGNATURE);
        let given = text_argument(arg(0)?, "trace_id", SIGNATURE)?;
        let id = trace_id(given.trim())
            .filter(|id| id.len() == 32)
            .ok_or_else(|| {
                sqlstate(
                    "22023",
                    format!(
                        "{SIGNATURE}: invalid trace_id {given:?}: expected up to 32 hex digits"
                    ),
                )
            })?;
        let source = match exprs.get(1) {
            Some(_) => Some(text_argument(arg(1)?, "source", SIGNATURE)?),
            None => None,
        };
        Ok(Arc::new(TraceQuery {
            http: self.http.clone(),
            source: self.sources.resolve(source, session)?,
            trace_id: id,
        }))
    }
}

/// One `trace()` call: the trace to fetch and where.
#[derive(Debug)]
struct TraceQuery {
    http: reqwest::Client,
    source: HttpSource,
    /// Lowercase hex, 32 digits.
    trace_id: String,
}

impl TraceQuery {
    /// Tempo's trace JSON, or `None` when Tempo doesn't know the trace (404).
    async fn fetch(&self) -> Result<Option<Value>, DataFusionError> {
        let source = &self.source.name;
        let response = self
            .http
            .get(format!("{}/api/traces/{}", self.source.url, self.trace_id))
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| {
                DataFusionError::Execution(format!("tempo source \"{source}\" is unreachable: {e}"))
            })?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let body = response.bytes().await.map_err(|e| {
            DataFusionError::Execution(format!(
                "tempo source \"{source}\": reading the response failed: {e}"
            ))
        })?;
        tempo_answer(source, status.as_u16(), &body).map(Some)
    }
}

/// The resource spans of a trace answer: `batches`, `resourceSpans` or `trace.resourceSpans`.
fn resource_spans(answer: &Value) -> Option<&[Value]> {
    [
        &answer["batches"],
        &answer["resourceSpans"],
        &answer["trace"]["resourceSpans"],
    ]
    .into_iter()
    .find(|v| !v.is_null())
    .map_or(Some(&[][..]), |v| v.as_array().map(Vec::as_slice))
}

/// One row per span of a trace answer, in Tempo's order. More than `max_rows` spans fails with
/// SQLSTATE 54000.
fn trace_batch(
    source: &str,
    answer: &Value,
    max_rows: usize,
) -> Result<RecordBatch, DataFusionError> {
    let fail =
        |what: &str| DataFusionError::Execution(format!("tempo source \"{source}\": {what}"));
    let resources =
        resource_spans(answer).ok_or_else(|| fail("the trace's batches are not a list"))?;
    let mut spans: Vec<(Option<&str>, &Value)> = vec![];
    for resource in resources {
        let service = resource["resource"]["attributes"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|kv| kv["key"] == "service.name")
            .and_then(|kv| kv["value"]["stringValue"].as_str());
        // `instrumentationLibrarySpans` is the pre-1.0 OTLP name of `scopeSpans`.
        let scopes = match (&resource["scopeSpans"], &resource["instrumentationLibrarySpans"]) {
            (Value::Array(s), _) | (Value::Null, Value::Array(s)) => s.as_slice(),
            (Value::Null, Value::Null) => &[],
            _ => return Err(fail("a batch's scopeSpans are not a list")),
        };
        for scope in scopes {
            match &scope["spans"] {
                Value::Array(list) => spans.extend(list.iter().map(|s| (service, s))),
                Value::Null => {}
                _ => return Err(fail("a scope's spans are not a list")),
            }
        }
    }
    if spans.len() > max_rows {
        return Err(sqlstate(
            "54000",
            format!("result exceeds max_rows ({max_rows}) for source \"{source}\""),
        ));
    }
    let mut trace_ids = StringBuilder::new();
    let mut span_ids = StringBuilder::new();
    let mut parents = StringBuilder::new();
    let mut services = StringBuilder::new();
    let mut names = StringBuilder::new();
    let mut starts = TimestampMicrosecondBuilder::new().with_timezone(UTC);
    let mut durations = Float64Builder::new();
    let mut statuses = StringBuilder::new();
    let mut attributes = StringBuilder::new();
    for (service, span) in spans {
        let id = |key: &str, bytes: usize| match &span[key] {
            Value::Null => Ok(None),
            v => v
                .as_str()
                .and_then(|s| hex_id(s, bytes))
                .map(Some)
                .ok_or_else(|| fail(&format!("a span has a malformed {key}"))),
        };
        trace_ids.append_value(id("traceId", 16)?.ok_or_else(|| fail("a span has no traceId"))?);
        span_ids.append_value(id("spanId", 8)?.ok_or_else(|| fail("a span has no spanId"))?);
        parents.append_option(id("parentSpanId", 8)?.filter(|p| p.bytes().any(|b| b != b'0')));
        services.append_option(service);
        names.append_value(span["name"].as_str().unwrap_or(""));
        let nanos = |key: &str| match &span[key] {
            Value::Null => Ok(None),
            v => unix_nanos(v)
                .map(Some)
                .ok_or_else(|| fail(&format!("a span has a malformed {key}"))),
        };
        let start = nanos("startTimeUnixNano")?;
        let end = nanos("endTimeUnixNano")?;
        starts.append_option(start.map(|ns| ns.div_euclid(1000)));
        durations.append_option(match (start, end) {
            (Some(s), Some(e)) => Some((e - s) as f64 / 1_000_000.0),
            _ => None,
        });
        statuses.append_value(status(&span["status"]["code"]));
        let mut flat = Map::new();
        for kv in span["attributes"].as_array().into_iter().flatten() {
            if let Some(key) = kv["key"].as_str() {
                flat.insert(key.to_string(), any_value(&kv["value"]));
            }
        }
        attributes.append_value(Value::Object(flat).to_string());
    }
    let columns: Vec<ArrayRef> = vec![
        Arc::new(trace_ids.finish()),
        Arc::new(span_ids.finish()),
        Arc::new(parents.finish()),
        Arc::new(services.finish()),
        Arc::new(names.finish()),
        Arc::new(starts.finish()),
        Arc::new(durations.finish()),
        Arc::new(statuses.finish()),
        Arc::new(attributes.finish()),
    ];
    Ok(RecordBatch::try_new(trace_schema(), columns)?)
}

/// A `bytes`-long id as lowercase hex. Tempo's JSON carries ids as base64 (protobuf JSON); OTLP
/// JSON files carry them as hex, which is accepted too (the two never have the same length).
fn hex_id(id: &str, bytes: usize) -> Option<String> {
    if id.len() == bytes * 2 && id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(id.to_ascii_lowercase());
    }
    let raw = BASE64.decode(id).ok().filter(|raw| raw.len() == bytes)?;
    Some(raw.iter().map(|b| format!("{b:02x}")).collect())
}

/// Nanoseconds since the Unix epoch, as uint64 text (protobuf JSON) or a number.
fn unix_nanos(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => s.parse().ok(),
        n => n.as_i64(),
    }
}

/// An OTLP status code (enum name or number; missing is UNSET) as `unset`, `ok` or `error`.
fn status(code: &Value) -> &'static str {
    match code {
        Value::String(s) if s == "STATUS_CODE_OK" => "ok",
        Value::String(s) if s == "STATUS_CODE_ERROR" => "error",
        Value::Number(n) if n.as_i64() == Some(1) => "ok",
        Value::Number(n) if n.as_i64() == Some(2) => "error",
        _ => "unset",
    }
}

/// An OTLP `AnyValue` as plain JSON: strings, booleans and numbers as themselves (`intValue`,
/// int64 text in protobuf JSON, as a number), arrays and key-value lists as JSON arrays and
/// objects, bytes as their base64 text, and an empty value as null.
fn any_value(v: &Value) -> Value {
    if let Some(s) = v.get("stringValue") {
        return s.clone();
    }
    if let Some(b) = v.get("boolValue") {
        return b.clone();
    }
    if let Some(i) = v.get("intValue") {
        return match i {
            Value::String(s) => s.parse::<i64>().map_or_else(|_| i.clone(), Value::from),
            other => other.clone(),
        };
    }
    if let Some(d) = v.get("doubleValue") {
        // Non-finite doubles are "NaN"/"Infinity" text in protobuf JSON; JSON has no number for
        // them, so they stay text.
        return d.clone();
    }
    if let Some(a) = v.get("arrayValue") {
        let values = a["values"].as_array().into_iter().flatten();
        return Value::Array(values.map(any_value).collect());
    }
    if let Some(kv) = v.get("kvlistValue") {
        let mut object = Map::new();
        for entry in kv["values"].as_array().into_iter().flatten() {
            if let Some(key) = entry["key"].as_str() {
                object.insert(key.to_string(), any_value(&entry["value"]));
            }
        }
        return Value::Object(object);
    }
    if let Some(b) = v.get("bytesValue") {
        return b.clone();
    }
    Value::Null
}

#[async_trait]
impl TableProvider for TraceQuery {
    fn schema(&self) -> SchemaRef {
        trace_schema()
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
        let batch = match self.fetch().await? {
            Some(answer) => trace_batch(&self.source.name, &answer, self.source.max_rows)?,
            None => RecordBatch::new_empty(self.schema()),
        };
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
    use datafusion::arrow::datatypes::{Float64Type, TimestampMicrosecondType};
    use serde_json::json;

    fn b64(hex: &str) -> String {
        let raw: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        BASE64.encode(raw)
    }

    #[test]
    fn spans_become_one_row_each() {
        let tid = "0af7651916cd43dd8448eb211c80319c";
        let answer = json!({"batches": [
            {"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "web"}}]},
             "scopeSpans": [{"spans": [
                {"traceId": b64(tid), "spanId": b64("b7ad6b7169203331"), "name": "GET /",
                 "startTimeUnixNano": "1762560000000000000", "endTimeUnixNano": "1762560000250000000",
                 "status": {}},
                {"traceId": b64(tid), "spanId": b64("00f067aa0ba902b7"),
                 "parentSpanId": b64("b7ad6b7169203331"),
                 "startTimeUnixNano": "1762560000010000000", "endTimeUnixNano": "1762560000110500000",
                 "status": {"code": 2},
                 "attributes": [
                    {"key": "n", "value": {"intValue": "500"}},
                    {"key": "l", "value": {"arrayValue": {"values": [{"stringValue": "a"}, {"boolValue": false}]}}},
                    {"key": "m", "value": {"kvlistValue": {"values": [{"key": "k", "value": {"doubleValue": 1.5}}]}}},
                    {"key": "e", "value": {}}]}]}]},
            {"resource": {"attributes": []},
             "instrumentationLibrarySpans": [{"spans": [
                {"traceId": tid.to_uppercase(), "spanId": "1111111111111111",
                 "parentSpanId": b64("0000000000000000"), "status": {"code": "STATUS_CODE_OK"}}]}]},
        ]});
        let batch = trace_batch("t", &answer, usize::MAX).unwrap();
        assert_eq!(batch.num_rows(), 3);
        let text = |c: usize| batch.column(c).as_string::<i32>().clone();
        assert!((0..3).all(|i| text(0).value(i) == tid));
        assert_eq!(text(1).value(1), "00f067aa0ba902b7");
        assert_eq!(text(1).value(2), "1111111111111111");
        assert!(batch.column(2).is_null(0));
        assert_eq!(text(2).value(1), "b7ad6b7169203331");
        assert!(batch.column(2).is_null(2), "an all-zero parent is a root");
        assert_eq!(text(3).value(1), "web");
        assert!(batch.column(3).is_null(2));
        assert_eq!((text(4).value(0), text(4).value(1)), ("GET /", ""));
        let t = batch.column(5).as_primitive::<TimestampMicrosecondType>();
        assert_eq!(t.value(1), 1_762_560_000_010_000);
        assert!(t.is_null(2));
        let d = batch.column(6).as_primitive::<Float64Type>();
        assert_eq!((d.value(0), d.value(1)), (250.0, 100.5));
        assert!(d.is_null(2));
        assert_eq!(
            (text(7).value(0), text(7).value(1), text(7).value(2)),
            ("unset", "error", "ok")
        );
        let attrs: Value = serde_json::from_str(text(8).value(1)).unwrap();
        assert_eq!(
            attrs,
            json!({"n": 500, "l": ["a", false], "m": {"k": 1.5}, "e": null})
        );
        assert_eq!(text(8).value(0), "{}");
    }

    #[test]
    fn answer_shapes_and_limits() {
        let span = json!({"traceId": b64(&"ab".repeat(16)), "spanId": b64(&"cd".repeat(8))});
        let rs = json!([{"scopeSpans": [{"spans": [span]}]}]);
        for answer in [
            json!({"resourceSpans": rs}),
            json!({"trace": {"resourceSpans": rs}}),
        ] {
            assert_eq!(trace_batch("t", &answer, 1).unwrap().num_rows(), 1);
        }
        assert_eq!(trace_batch("t", &json!({}), 0).unwrap().num_rows(), 0);
        let e = trace_batch("t", &json!({"batches": rs}), 0)
            .unwrap_err()
            .to_string();
        assert!(e.contains("result exceeds max_rows (0)"), "{e}");
        for bad in [
            json!({"batches": {}}),
            json!({"batches": [{"scopeSpans": [{"spans": [{"spanId": b64(&"cd".repeat(8))}]}]}]}),
            json!({"batches": [{"scopeSpans": [{"spans": [{"traceId": "short", "spanId": "x"}]}]}]}),
        ] {
            let e = trace_batch("tempo-a", &bad, usize::MAX)
                .unwrap_err()
                .to_string();
            assert!(e.contains("tempo source \"tempo-a\""), "{e}");
        }
    }
}
