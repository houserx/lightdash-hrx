//! BigQuery REST mock (one project, a few synthetic Ops Mart tables) plus the GCP workload identity
//! federation endpoints (STS token exchange and IAM Credentials `generateAccessToken`).
//!
//! BigQuery routes (all under `/bigquery/v2`):
//! - `GET  /projects/{p}/datasets/{d}/tables/{t}`            tables.get (schema)
//! - `POST /projects/{p}/queries`                             jobs.query: answers with the whole
//!   table named in the SQL (the first known table name found in the text), `PAGE_SIZE` rows per
//!   page; columns are always the full table schema, so map result columns by name
//! - `GET  /projects/{p}/queries/{jobId}?pageToken=`          jobs.getQueryResults (next pages)
//! - `GET  /projects/{p}/datasets/{d}/tables/{t}/data`        tabledata.list (`PAGE_SIZE` per page)
//!
//! TIMESTAMP cells are float epoch seconds (e.g. "1.7625888E9") unless the request asks for
//! `formatOptions.useInt64Timestamp` (then int64 microseconds). Every BigQuery call must carry
//! `Authorization: Bearer <expected token>`, else 401.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::mock_http::{MockServer, Recorded, Reply};

pub const PROJECT: &str = "hrx-test-dataplatform";
pub const PAGE_SIZE: usize = 2;
pub const STATIC_TOKEN: &str = "test-bigquery-token-not-real";
pub const FEDERATED_TOKEN: &str = "test-federated-token-not-real";
pub const SA_TOKEN: &str = "test-service-account-token-not-real";
pub const SERVICE_ACCOUNT: &str = "federation-engine@hrx-test-dataplatform.iam.gserviceaccount.com";
pub const WIF_AUDIENCE: &str = "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/test-pool/providers/test-aws";

#[derive(Clone)]
pub struct BqTable {
    pub dataset: &'static str,
    pub table: &'static str,
    /// (name, BigQuery type)
    pub schema: Vec<(&'static str, &'static str)>,
    /// Cells as BigQuery would render them (TIMESTAMP as epoch seconds).
    pub rows: Vec<Vec<Option<String>>>,
}

/// Synthetic Ops Marts: `ops_marts.fills_hourly` (5 rows), `ops_marts.queue_depth` (3 rows),
/// and `ops_marts.not_allowlisted` (exists in BigQuery but is never in the engine's allowlist).
pub fn tables() -> Vec<BqTable> {
    let ts = |s: i64| Some(s.to_string());
    vec![
        BqTable {
            dataset: "ops_marts",
            table: "fills_hourly",
            schema: vec![
                ("hour", "TIMESTAMP"),
                ("pharmacy", "STRING"),
                ("fills", "INTEGER"),
                ("avg_minutes", "FLOAT"),
                ("late", "BOOLEAN"),
            ],
            rows: vec![
                vec![
                    ts(1_762_588_800),
                    Some("pharmacy-a".into()),
                    Some("10".into()),
                    Some("12.5".into()),
                    Some("false".into()),
                ],
                vec![
                    ts(1_762_592_400),
                    Some("pharmacy-a".into()),
                    Some("14".into()),
                    Some("11".into()),
                    Some("false".into()),
                ],
                vec![
                    ts(1_762_588_800),
                    Some("pharmacy-b".into()),
                    Some("7".into()),
                    Some("20.25".into()),
                    Some("true".into()),
                ],
                vec![
                    ts(1_762_592_400),
                    Some("pharmacy-b".into()),
                    Some("9".into()),
                    None,
                    Some("true".into()),
                ],
                vec![
                    ts(1_762_596_000),
                    Some("pharmacy-b".into()),
                    Some("3".into()),
                    Some("30".into()),
                    Some("false".into()),
                ],
            ],
        },
        BqTable {
            dataset: "ops_marts",
            table: "queue_depth",
            schema: vec![("ts", "TIMESTAMP"), ("queue", "STRING"), ("depth", "INT64")],
            rows: vec![
                vec![ts(1_762_588_800), Some("intake".into()), Some("4".into())],
                vec![ts(1_762_588_860), Some("intake".into()), Some("6".into())],
                vec![ts(1_762_588_800), Some("review".into()), Some("1".into())],
            ],
        },
        BqTable {
            dataset: "ops_marts",
            table: "not_allowlisted",
            schema: vec![("secret_value", "STRING")],
            rows: vec![vec![Some("must-never-be-read".into())]],
        },
    ]
}

pub struct BigQueryMock {
    pub server: MockServer,
    pub expected_token: Arc<Mutex<String>>,
}

impl BigQueryMock {
    /// `expected_token` is the bearer every BigQuery call must carry.
    pub async fn start(expected_token: &str) -> BigQueryMock {
        let expected = Arc::new(Mutex::new(expected_token.to_string()));
        let e = expected.clone();
        let server = MockServer::start(move |r| handle(r, &e.lock().unwrap())).await;
        BigQueryMock {
            server,
            expected_token: expected,
        }
    }
    pub fn url(&self) -> String {
        self.server.url()
    }
    /// BigQuery API requests (excluding the WIF token endpoints).
    pub fn bq_requests(&self) -> Vec<Recorded> {
        self.server.requests_to("/bigquery/")
    }
}

fn schema_json(t: &BqTable) -> Value {
    json!({"fields": t.schema.iter().map(|(n, ty)| json!({"name": n, "type": ty, "mode": "NULLABLE"})).collect::<Vec<_>>()})
}

fn render_rows(t: &BqTable, rows: &[Vec<Option<String>>], int64_ts: bool) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| {
                json!({"f": row.iter().zip(t.schema.iter()).map(|(c, (_, ty))| match c {
                    None => json!({"v": null}),
                    Some(v) if *ty == "TIMESTAMP" => {
                        let secs: i64 = v.parse().unwrap();
                        if int64_ts { json!({"v": (secs * 1_000_000).to_string()}) } else { json!({"v": format!("{:E}", secs as f64)}) }
                    }
                    Some(v) => json!({"v": v}),
                }).collect::<Vec<_>>()})
            })
            .collect(),
    )
}

fn page(t: &BqTable, token: Option<&str>, int64_ts: bool) -> (Value, Option<String>) {
    let start: usize = token
        .and_then(|s| s.strip_prefix("page-"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let end = (start + PAGE_SIZE).min(t.rows.len());
    let next = (end < t.rows.len()).then(|| format!("page-{end}"));
    (render_rows(t, &t.rows[start..end], int64_ts), next)
}

fn find_table(dataset: &str, table: &str) -> Option<BqTable> {
    tables()
        .into_iter()
        .find(|t| t.dataset == dataset && t.table == table)
}

fn handle(r: &Recorded, expected: &str) -> Reply {
    // GCP STS token exchange (workload identity federation).
    if r.method == "POST" && r.path == "/v1/token" {
        return Reply::json(
            &json!({"access_token": FEDERATED_TOKEN, "issued_token_type": "urn:ietf:params:oauth:token-type:access_token", "token_type": "Bearer", "expires_in": 3600}),
        );
    }
    // IAM Credentials generateAccessToken.
    if r.method == "POST" && r.path.ends_with(":generateAccessToken") {
        if r.header("authorization") != Some(&format!("Bearer {FEDERATED_TOKEN}")) {
            return Reply::json_status(
                401,
                &json!({"error": {"code": 401, "message": "federated token required"}}),
            );
        }
        return Reply::json(
            &json!({"accessToken": SA_TOKEN, "expireTime": "2099-01-01T00:00:00Z"}),
        );
    }
    let Some(rest) = r
        .path
        .strip_prefix(&format!("/bigquery/v2/projects/{PROJECT}/"))
    else {
        return Reply::text(200, "ok");
    };
    if r.header("authorization") != Some(&format!("Bearer {expected}")) {
        return Reply::json_status(
            401,
            &json!({"error": {"code": 401, "message": "Request is missing required authentication credential.", "status": "UNAUTHENTICATED"}}),
        );
    }
    let parts: Vec<&str> = rest.split('/').collect();
    let int64_ts_param = r.param("formatOptions.useInt64Timestamp") == Some("true");
    match parts.as_slice() {
        ["datasets", d, "tables", t] if r.method == "GET" => match find_table(d, t) {
            Some(tb) => Reply::json(
                &json!({"kind": "bigquery#table", "id": format!("{PROJECT}:{d}.{t}"),
                "tableReference": {"projectId": PROJECT, "datasetId": d, "tableId": t},
                "schema": schema_json(&tb), "numRows": tb.rows.len().to_string(), "type": "TABLE"}),
            ),
            None => Reply::json_status(
                404,
                &json!({"error": {"code": 404, "message": format!("Not found: Table {PROJECT}:{d}.{t}"), "status": "NOT_FOUND"}}),
            ),
        },
        ["datasets", d, "tables", t, "data"] if r.method == "GET" => match find_table(d, t) {
            Some(tb) => {
                let (rows, next) = page(&tb, r.param("pageToken"), int64_ts_param);
                let mut out = json!({"kind": "bigquery#tableDataList", "totalRows": tb.rows.len().to_string(), "rows": rows});
                if let Some(n) = next {
                    out["pageToken"] = json!(n);
                }
                Reply::json(&out)
            }
            None => Reply::json_status(
                404,
                &json!({"error": {"code": 404, "message": "Not found", "status": "NOT_FOUND"}}),
            ),
        },
        ["queries"] if r.method == "POST" => {
            let body = r.json();
            let sql = body["query"].as_str().unwrap_or("").to_string();
            let int64_ts = body["formatOptions"]["useInt64Timestamp"] == json!(true);
            let Some(tb) = tables().into_iter().find(|t| sql.contains(t.table)) else {
                return Reply::json_status(
                    400,
                    &json!({"error": {"code": 400, "message": "mock: query names no known table", "status": "INVALID_ARGUMENT"}}),
                );
            };
            let (rows, next) = page(&tb, None, int64_ts);
            let job = format!("job-{}-{}", tb.table, if int64_ts { "i" } else { "f" });
            let mut out = json!({"kind": "bigquery#queryResponse", "schema": schema_json(&tb),
                "jobReference": {"projectId": PROJECT, "jobId": job, "location": "US"},
                "totalRows": tb.rows.len().to_string(), "rows": rows, "jobComplete": true, "cacheHit": false});
            if let Some(n) = next {
                out["pageToken"] = json!(n);
            }
            Reply::json(&out)
        }
        ["queries", job] if r.method == "GET" => {
            let Some(rest) = job.strip_prefix("job-") else {
                return Reply::not_found();
            };
            let (name, fmt) = rest.rsplit_once('-').unwrap_or((rest, "f"));
            let Some(tb) = tables().into_iter().find(|t| t.table == name) else {
                return Reply::not_found();
            };
            let (rows, next) = page(&tb, r.param("pageToken"), fmt == "i" || int64_ts_param);
            let mut out = json!({"kind": "bigquery#getQueryResultsResponse", "schema": schema_json(&tb),
                "jobReference": {"projectId": PROJECT, "jobId": job, "location": "US"},
                "totalRows": tb.rows.len().to_string(), "rows": rows, "jobComplete": true});
            if let Some(n) = next {
                out["pageToken"] = json!(n);
            }
            Reply::json(&out)
        }
        _ => Reply::json_status(
            404,
            &json!({"error": {"code": 404, "message": format!("mock: no route for {} {}", r.method, r.path)}}),
        ),
    }
}
