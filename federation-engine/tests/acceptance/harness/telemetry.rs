//! Response builders for Telemetry Source mocks: Prometheus, Loki, Tempo, CloudWatch Logs Insights.
//! Request parameters may arrive in the query string or a form body (`Recorded::param_or_form`).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde_json::{Value, json};

use super::aws::{self, AwsCall};
use super::mock_http::{MockServer, Recorded, Reply};

/// One Prometheus/Loki matrix series: labels and (unix seconds, value string) samples.
pub type Series = (Value, Vec<(f64, String)>);

pub fn prom_ok(result_type: &str, result: Value) -> Value {
    json!({"status": "success", "data": {"resultType": result_type, "result": result}})
}

pub fn prom_matrix(series: &[Series]) -> Value {
    prom_ok(
        "matrix",
        Value::Array(
            series
                .iter()
                .map(|(m, vals)| {
                    json!({"metric": m, "values": vals.iter().map(|(t, v)| json!([t, v])).collect::<Vec<_>>()})
                })
                .collect(),
        ),
    )
}

pub fn prom_vector(samples: &[(Value, f64, &str)]) -> Value {
    prom_ok(
        "vector",
        Value::Array(
            samples
                .iter()
                .map(|(m, t, v)| json!({"metric": m, "value": [t, v]}))
                .collect(),
        ),
    )
}

pub fn prom_scalar(t: f64, v: &str) -> Value {
    prom_ok("scalar", json!([t, v]))
}

pub fn prom_string(t: f64, v: &str) -> Value {
    prom_ok("string", json!([t, v]))
}

pub fn prom_error(error_type: &str, msg: &str) -> Value {
    json!({"status": "error", "errorType": error_type, "error": msg})
}

/// A Prometheus mock: `/api/v1/query_range` answers `range`, `/api/v1/query` answers `instant`,
/// anything else (health probes such as `/-/ready`) answers 200.
pub async fn prometheus_mock(range: Value, instant: Value) -> MockServer {
    MockServer::start(move |r| match r.path.as_str() {
        "/api/v1/query_range" => Reply::json(&range),
        "/api/v1/query" => Reply::json(&instant),
        _ => Reply::text(200, "Prometheus Server is Ready."),
    })
    .await
}

/// Loki `streams` result. Entries are (unix nanoseconds as string, line).
pub fn loki_streams(streams: &[(Value, Vec<(&str, &str)>)]) -> Value {
    json!({"status": "success", "data": {"resultType": "streams", "result":
        streams.iter().map(|(labels, entries)| json!({
            "stream": labels,
            "values": entries.iter().map(|(ns, line)| json!([ns, line])).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "stats": {}}})
}

/// Loki `matrix` result (same shape as Prometheus).
pub fn loki_matrix(series: &[Series]) -> Value {
    let mut v = prom_matrix(series);
    v["data"]["stats"] = json!({});
    v
}

/// Tempo search result trace.
pub struct TempoTrace<'a> {
    pub trace_id: &'a str,
    pub root_service: &'a str,
    pub root_name: &'a str,
    pub start_ns: &'a str,
    pub duration_ms: u64,
    pub matched: u64,
}

pub fn tempo_search(traces: &[TempoTrace]) -> Value {
    json!({"traces": traces.iter().map(|t| json!({
        "traceID": t.trace_id, "rootServiceName": t.root_service, "rootTraceName": t.root_name,
        "startTimeUnixNano": t.start_ns, "durationMs": t.duration_ms,
        "spanSet": {"spans": [], "matched": t.matched},
        "spanSets": [{"spans": [], "matched": t.matched}],
    })).collect::<Vec<_>>(), "metrics": {"inspectedTraces": traces.len(), "inspectedBytes": "1"}})
}

/// Hex trace/span id -> base64, as Tempo's JSON (protobuf JSON mapping) encodes them.
pub fn hex_to_b64(h: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(hex::decode(h).unwrap())
}

/// One OTLP span for `tempo_trace`.
pub struct OtlpSpan<'a> {
    pub service: &'a str,
    pub span_id: &'a str,
    pub parent_span_id: &'a str,
    pub name: &'a str,
    pub start_ns: u64,
    pub end_ns: u64,
    /// "STATUS_CODE_UNSET" | "STATUS_CODE_OK" | "STATUS_CODE_ERROR", or "" for no status.
    pub status: &'a str,
    pub attributes: Value,
}

/// Tempo `GET /api/traces/<id>` body: OTLP JSON `{"batches": [...]}` with base64 ids, one batch per
/// span (each with its own `service.name` resource attribute).
pub fn tempo_trace_batches(trace_id_hex: &str, spans: &[OtlpSpan]) -> Value {
    json!({"batches": spans.iter().map(|s| {
        let mut span = json!({
            "traceId": hex_to_b64(trace_id_hex), "spanId": hex_to_b64(s.span_id),
            "name": s.name, "kind": "SPAN_KIND_SERVER",
            "startTimeUnixNano": s.start_ns.to_string(), "endTimeUnixNano": s.end_ns.to_string(),
            "attributes": s.attributes,
            "status": if s.status.is_empty() { json!({}) } else { json!({"code": s.status}) },
        });
        if !s.parent_span_id.is_empty() {
            span["parentSpanId"] = json!(hex_to_b64(s.parent_span_id));
        }
        json!({"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": s.service}}]},
               "scopeSpans": [{"scope": {"name": "mock"}, "spans": [span]}]})
    }).collect::<Vec<_>>()})
}

/// A Tempo mock serving one trace on `/api/traces/<id>` (v1, `batches`) and `/api/v2/traces/<id>`
/// (`{"trace": {"resourceSpans": ...}}`), and `search` on `/api/search`.
pub async fn tempo_mock(search: Value, trace_id_hex: String, trace: Value) -> MockServer {
    MockServer::start(move |r| {
        if r.path == "/api/search" {
            return Reply::json(&search);
        }
        for prefix in ["/api/traces/", "/api/v2/traces/"] {
            if let Some(id) = r.path.strip_prefix(prefix) {
                if !id.eq_ignore_ascii_case(&trace_id_hex) {
                    return Reply::not_found();
                }
                if prefix == "/api/traces/" {
                    return Reply::json(&trace);
                }
                return Reply::json(&json!({"trace": {"resourceSpans": trace["batches"].clone()}}));
            }
        }
        Reply::text(200, "ready")
    })
    .await
}

/// CloudWatch Logs Insights mock state: StartQuery returns `query-1`; GetQueryResults answers
/// `Running` for the first `running_polls` calls, then `final_status` with `results`.
pub struct LogsInsights {
    pub server: MockServer,
    pub polls: Arc<AtomicUsize>,
    pub calls: Arc<Mutex<Vec<AwsCall>>>,
}

/// One result row: (field, value) pairs.
pub type LogsRow = Vec<(&'static str, String)>;

pub async fn logs_insights_mock(
    running_polls: usize,
    final_status: &'static str,
    results: Vec<LogsRow>,
) -> LogsInsights {
    let polls = Arc::new(AtomicUsize::new(0));
    let calls: Arc<Mutex<Vec<AwsCall>>> = Arc::new(Mutex::new(vec![]));
    let (p, c) = (polls.clone(), calls.clone());
    let results_json: Vec<Value> = results
        .iter()
        .map(|row| {
            Value::Array(
                row.iter()
                    .map(|(f, v)| json!({"field": f, "value": v}))
                    .collect(),
            )
        })
        .collect();
    let server = MockServer::start(move |r: &Recorded| {
        if let Some(reply) = aws::sts_reply(r) {
            return reply;
        }
        let Some(call) = aws::decode(r) else {
            return Reply::text(200, "ok");
        };
        c.lock().unwrap().push(call.clone());
        match call.operation.as_str() {
            "StartQuery" => aws::reply(&call, &json!({"queryId": "query-1"})),
            "GetQueryResults" => {
                let n = p.fetch_add(1, Ordering::SeqCst);
                if n < running_polls {
                    aws::reply(
                        &call,
                        &json!({"status": "Running", "results": [], "statistics": {"recordsMatched": 0.0, "recordsScanned": 0.0, "bytesScanned": 0.0}}),
                    )
                } else {
                    aws::reply(
                        &call,
                        &json!({"status": final_status, "results": results_json, "statistics": {"recordsMatched": results_json.len() as f64, "recordsScanned": 10.0, "bytesScanned": 100.0}}),
                    )
                }
            }
            "StopQuery" => aws::reply(&call, &json!({"success": true})),
            "DescribeLogGroups" => aws::reply(&call, &json!({"logGroups": []})),
            other => aws::error_reply(&call, 400, "InvalidOperationException", &format!("mock does not implement {other}")),
        }
    })
    .await;
    LogsInsights {
        server,
        polls,
        calls,
    }
}

impl LogsInsights {
    pub fn calls(&self, op: &str) -> Vec<AwsCall> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.operation == op)
            .cloned()
            .collect()
    }
}
