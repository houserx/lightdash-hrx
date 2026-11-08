//! Loki, CloudWatch, CloudWatch Logs Insights and Tempo table functions (§1.1), each against a mock.

use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};

use crate::harness::aws::{self, CwResult};
use crate::harness::telemetry::*;
use crate::harness::*;
use crate::promql::secs;

const T0: f64 = 1_762_560_000.0; // 2026-11-08T00:00:00Z
const RANGE: &str = "'2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z'";

fn oids(stmt: &tokio_postgres::Statement) -> Vec<u32> {
    stmt.columns().iter().map(|c| c.type_().oid()).collect()
}
fn names(stmt: &tokio_postgres::Statement) -> Vec<String> {
    stmt.columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect()
}
fn p(r: &Recorded, k: &str) -> String {
    r.param_or_form(k)
        .unwrap_or_else(|| panic!("{} has no {k}", r.raw_target))
}

/// eng-logql-streams
#[tokio::test]
async fn eng_logql_streams() {
    let body = loki_streams(&[
        (
            json!({"app": "api", "level": "error"}),
            vec![
                ("1762560000123456789", "boom 1"),
                ("1762560001000000000", "boom 2"),
            ],
        ),
        (
            json!({"app": "api", "level": "warn"}),
            vec![("1762560002000000000", "careful")],
        ),
    ]);
    let mock = MockServer::start(move |r| {
        if r.path == "/loki/api/v1/query_range" {
            Reply::json(&body)
        } else {
            Reply::text(200, "ready")
        }
    })
    .await;
    let engine = Engine::start(Cfg::new().loki("loki-a", &mock.url(), "")).await;
    let c = engine.connect().await;
    let q = r#"{app="api"} |= "boom" or "careful""#;
    let stmt = c
        .prepare(&format!(
            "SELECT * FROM logql({}, {RANGE}) ORDER BY \"timestamp\"",
            sql_lit(q)
        ))
        .await
        .unwrap();
    assert_eq!(names(&stmt), ["timestamp", "line", "labels", "stream"]);
    assert_eq!(oids(&stmt), vec![1184, 25, 114, 25]);
    let rows = c.query(&stmt, &[]).await.unwrap();
    assert_eq!(rows.len(), 3);
    assert!((secs(rows[0].get::<_, SystemTime>(0)) - 1_762_560_000.123_456).abs() < 2e-6);
    assert_eq!(rows[0].get::<_, String>(1), "boom 1");
    assert_eq!(
        rows[0].get::<_, Value>(2),
        json!({"app": "api", "level": "error"})
    );
    assert_eq!(rows[0].get::<_, String>(3), "{app=\"api\",level=\"error\"}");
    assert_eq!(rows[2].get::<_, String>(1), "careful");
    let r = mock.requests_to("/loki/api/v1/query_range").pop().unwrap();
    assert_eq!(p(&r, "query"), q);
    assert_eq!(parse_time_param(&p(&r, "start")), T0);
    assert_eq!(parse_time_param(&p(&r, "end")), T0 + 3600.0);
    assert_eq!(p(&r, "limit"), "1000", "default limit");
    assert_eq!(p(&r, "direction"), "backward", "default direction");

    c.query(
        &format!(
            "SELECT * FROM logql({}, {RANGE}, 50, 'forward')",
            sql_lit(q)
        ),
        &[],
    )
    .await
    .unwrap();
    let r = mock.requests_to("/loki/api/v1/query_range").pop().unwrap();
    assert_eq!(p(&r, "limit"), "50");
    assert_eq!(p(&r, "direction"), "forward");
    // SQL over log lines.
    let n: i64 = c
        .query_one(
            &format!(
                "SELECT count(*) FROM logql({}, {RANGE}) WHERE label(labels, 'level') = 'error'",
                sql_lit(q)
            ),
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(n, 2);
}

/// eng-logql-metric
#[tokio::test]
async fn eng_logql_metric() {
    let body = loki_matrix(&[
        (
            json!({"app": "api"}),
            vec![(T0, "3".into()), (T0 + 60.0, "5".into())],
        ),
        (json!({"app": "web"}), vec![(T0, "1".into())]),
    ]);
    let mock = MockServer::start(move |r| {
        if r.path == "/loki/api/v1/query_range" {
            Reply::json(&body)
        } else {
            Reply::text(200, "ready")
        }
    })
    .await;
    let engine = Engine::start(Cfg::new().loki("loki-a", &mock.url(), "")).await;
    let c = engine.connect().await;
    let q = r#"sum by (app) (count_over_time({namespace="web"} |= "error" [1m]))"#;
    let stmt = c
        .prepare(&format!(
            "SELECT * FROM logql_metric({}, {RANGE}, '1m') ORDER BY series, \"timestamp\"",
            sql_lit(q)
        ))
        .await
        .unwrap();
    assert_eq!(names(&stmt), ["timestamp", "value", "labels", "series"]);
    assert_eq!(oids(&stmt), vec![1184, 701, 114, 25]);
    let rows = c.query(&stmt, &[]).await.unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].get::<_, String>(3), "{app=\"api\"}");
    assert_eq!(rows[1].get::<_, f64>(1), 5.0);
    assert_eq!(secs(rows[1].get::<_, SystemTime>(0)), T0 + 60.0);
    let r = mock.requests_to("/loki/api/v1/query_range").pop().unwrap();
    assert_eq!(p(&r, "query"), q);
    assert_eq!(parse_duration_param(&p(&r, "step")), 60.0);
}

fn cw_source(name: &str, endpoint: &str, extra: &str) -> String {
    format!(
        "[[sources]]\nname = \"{name}\"\nkind = \"cloudwatch\"\nregion = \"us-east-2\"\nendpoint_url = \"{endpoint}\"\n{extra}\n"
    )
}

/// A CloudWatch mock: answers GetMetricData via `f(call)`, AssumeRole with fixed credentials.
async fn cloudwatch_mock(f: impl Fn(&aws::AwsCall) -> Reply + Send + Sync + 'static) -> MockServer {
    MockServer::start(move |r| {
        if let Some(rep) = aws::sts_reply(r) {
            return rep;
        }
        match aws::decode(r) {
            Some(call) if call.operation == "GetMetricData" => f(&call),
            Some(call) => aws::error_reply(&call, 400, "InvalidAction", "mock"),
            None => Reply::text(200, "ok"),
        }
    })
    .await
}

fn cw_calls(mock: &MockServer) -> Vec<aws::AwsCall> {
    mock.requests()
        .iter()
        .filter_map(aws::decode)
        .filter(|c| c.operation == "GetMetricData")
        .collect()
}

/// eng-cloudwatch-metric-stat
#[tokio::test]
async fn eng_cloudwatch_metric_stat() {
    let mock = cloudwatch_mock(|call| {
        let q = &call.input["MetricDataQueries"][0];
        let id = q["Id"].as_str().unwrap_or("m1").to_string();
        let label = q["Label"].as_str().unwrap_or("CPUUtilization").to_string();
        if call.input.get("NextToken").is_none() {
            aws::cloudwatch_reply(
                call,
                &[CwResult {
                    id,
                    label,
                    timestamps: vec![T0 as i64, T0 as i64 + 300],
                    values: vec![10.5, 20.0],
                }],
                Some("page-2"),
            )
        } else {
            aws::cloudwatch_reply(
                call,
                &[CwResult {
                    id,
                    label,
                    timestamps: vec![T0 as i64 + 600],
                    values: vec![30.25],
                }],
                None,
            )
        }
    })
    .await;
    let engine = Engine::start(Cfg::new().table(&cw_source("cw-a", &mock.url(), ""))).await;
    let c = engine.connect().await;
    // The target model Grafana's CloudWatch datasource stores (metric stat, builder mode).
    let grafana = json!({"refId": "A", "id": "", "datasource": {"type": "cloudwatch", "uid": "x"},
        "namespace": "AWS/RDS", "metricName": "CPUUtilization",
        "dimensions": {"DBInstanceIdentifier": ["db-1"], "Role": "writer"},
        "statistic": "Average", "period": "300", "metricQueryType": 0, "metricEditorMode": 0,
        "matchExact": true, "expression": "", "label": "cpu-db-1", "region": "default", "queryMode": "Metrics"});
    let stmt = c
        .prepare(&format!(
            "SELECT * FROM cloudwatch({}, {RANGE}) ORDER BY \"timestamp\"",
            sql_lit(&grafana.to_string())
        ))
        .await
        .unwrap();
    assert_eq!(names(&stmt), ["timestamp", "value", "labels", "series"]);
    assert_eq!(oids(&stmt), vec![1184, 701, 114, 25]);
    let rows = c.query(&stmt, &[]).await.unwrap();
    let got: Vec<(f64, f64, String)> = rows
        .iter()
        .map(|r| (secs(r.get(0)), r.get(1), r.get(3)))
        .collect();
    assert_eq!(
        got,
        vec![
            (T0, 10.5, "cpu-db-1".into()),
            (T0 + 300.0, 20.0, "cpu-db-1".into()),
            (T0 + 600.0, 30.25, "cpu-db-1".into())
        ],
        "both NextToken pages, series = the query label"
    );
    assert!(
        rows[0].get::<_, Value>(2).is_object(),
        "labels is a JSON object"
    );

    let calls = cw_calls(&mock);
    assert_eq!(calls.len(), 2, "two pages");
    let input = &calls[0].input;
    assert_eq!(aws::ts_secs(&input["StartTime"]), T0);
    assert_eq!(aws::ts_secs(&input["EndTime"]), T0 + 3600.0);
    let q = &input["MetricDataQueries"][0];
    let id = q["Id"].as_str().expect("an Id");
    assert!(
        id.chars().next().unwrap().is_ascii_lowercase()
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        "Id must match ^[a-z][a-zA-Z0-9_]*$: {id}"
    );
    let ms = &q["MetricStat"];
    assert_eq!(ms["Metric"]["Namespace"], "AWS/RDS");
    assert_eq!(ms["Metric"]["MetricName"], "CPUUtilization");
    let mut dims: Vec<(String, String)> = ms["Metric"]["Dimensions"]
        .as_array()
        .expect("dimensions")
        .iter()
        .map(|d| {
            (
                d["Name"].as_str().unwrap().into(),
                d["Value"].as_str().unwrap().into(),
            )
        })
        .collect();
    dims.sort();
    assert_eq!(
        dims,
        vec![
            ("DBInstanceIdentifier".into(), "db-1".into()),
            ("Role".into(), "writer".into())
        ]
    );
    assert_eq!(ms["Period"], json!(300));
    assert_eq!(ms["Stat"], "Average");
    assert_ne!(q["ReturnData"], json!(false));
    assert_eq!(calls[1].input["NextToken"], "page-2");
    // SigV4 with the default credential chain (env credentials), region from the source.
    let req = &calls[0].request;
    assert_eq!(aws::sigv4_key_id(req).as_deref(), Some(AWS_KEY_ID));
    assert_eq!(aws::sigv4_region(req).as_deref(), Some("us-east-2"));
}

/// eng-cloudwatch-expression
#[tokio::test]
async fn eng_cloudwatch_expression() {
    let mock = cloudwatch_mock(|call| {
        aws::cloudwatch_reply(
            call,
            &[
                CwResult {
                    id: "e1".into(),
                    label: "i-aaa".into(),
                    timestamps: vec![T0 as i64, T0 as i64 + 60],
                    values: vec![1.0, 2.0],
                },
                CwResult {
                    id: "e1".into(),
                    label: "i-bbb".into(),
                    timestamps: vec![T0 as i64],
                    values: vec![3.0],
                },
            ],
            None,
        )
    })
    .await;
    let engine = Engine::start(Cfg::new().table(&cw_source("cw-a", &mock.url(), ""))).await;
    let c = engine.connect().await;
    let expr = r#"SEARCH('{AWS/EC2,InstanceId} MetricName="CPUUtilization"', 'Average', 300)"#;
    let grafana = json!({"refId": "B", "id": "", "expression": expr, "metricEditorMode": 1,
        "metricQueryType": 0, "label": "", "period": "300", "region": "default", "queryMode": "Metrics",
        "namespace": "", "metricName": "", "dimensions": {}, "statistic": "Average"});
    let rows = c
        .query(&format!("SELECT series, count(*) AS n FROM cloudwatch({}, {RANGE}) GROUP BY series ORDER BY series", sql_lit(&grafana.to_string())), &[])
        .await
        .unwrap();
    let got: Vec<(String, i64)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    assert_eq!(
        got,
        vec![("i-aaa".into(), 2), ("i-bbb".into(), 1)],
        "series = each result's label"
    );
    let calls = cw_calls(&mock);
    let q = &calls[0].input["MetricDataQueries"][0];
    assert_eq!(q["Expression"], expr, "expression passed whole");
    assert!(q.get("MetricStat").is_none_or(|v| v.is_null()));
}

/// eng-cloudwatch-role-assumption
#[tokio::test]
async fn eng_cloudwatch_role_assumption() {
    let mock = cloudwatch_mock(|call| {
        aws::cloudwatch_reply(
            call,
            &[CwResult {
                id: "m".into(),
                label: "x".into(),
                timestamps: vec![T0 as i64],
                values: vec![1.0],
            }],
            None,
        )
    })
    .await;
    let role = "arn:aws:iam::000000000000:role/test-federation-engine-not-real";
    let engine = Engine::start(Cfg::new().table(&cw_source(
        "cw-a",
        &mock.url(),
        &format!(
            "role_arn = \"{role}\"\nsts_endpoint_url = \"{}\"",
            mock.url()
        ),
    )))
    .await;
    let c = engine.connect().await;
    let grafana = json!({"refId": "A", "namespace": "AWS/SQS", "metricName": "NumberOfMessagesSent",
        "dimensions": {"QueueName": "q"}, "statistic": "Sum", "period": "60", "metricEditorMode": 0,
        "metricQueryType": 0, "matchExact": true, "expression": "", "id": "", "label": ""});
    let rows = c
        .query(
            &format!(
                "SELECT * FROM cloudwatch({}, {RANGE})",
                sql_lit(&grafana.to_string())
            ),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    let assume: Vec<aws::AwsCall> = mock
        .requests()
        .iter()
        .filter_map(aws::decode)
        .filter(|c| c.operation == "AssumeRole")
        .collect();
    assert!(!assume.is_empty(), "the role is assumed through STS");
    assert_eq!(assume[0].input["RoleArn"], role);
    assert_eq!(
        aws::sigv4_key_id(&assume[0].request).as_deref(),
        Some(AWS_KEY_ID),
        "STS call signed by the base chain"
    );
    let call = &cw_calls(&mock)[0];
    assert_eq!(
        aws::sigv4_key_id(&call.request).as_deref(),
        Some(aws::ASSUMED_KEY_ID),
        "GetMetricData signed with the assumed role"
    );
    assert_eq!(
        call.request.header("x-amz-security-token"),
        Some(aws::ASSUMED_SESSION_TOKEN)
    );
}

fn logs_source(name: &str, endpoint: &str, extra: &str) -> String {
    format!(
        "[[sources]]\nname = \"{name}\"\nkind = \"cloudwatch_logs\"\nregion = \"us-east-2\"\nendpoint_url = \"{endpoint}\"\npoll_interval_ms = 50\n{extra}\n"
    )
}

/// eng-cloudwatch-logs-insights
#[tokio::test]
async fn eng_cloudwatch_logs_insights() {
    let logs = logs_insights_mock(
        2,
        "Complete",
        vec![
            vec![
                ("@timestamp", "2026-11-08 00:00:01.250".into()),
                ("@message", "first event".into()),
                ("level", "error".into()),
                ("@ptr", "ptr-1".into()),
            ],
            vec![
                ("@timestamp", "2026-11-08 00:00:02.000".into()),
                ("@message", "second event".into()),
                ("level", "info".into()),
                ("@ptr", "ptr-2".into()),
            ],
        ],
    )
    .await;
    let engine =
        Engine::start(Cfg::new().table(&logs_source("logs-a", &logs.server.url(), ""))).await;
    let c = engine.connect().await;
    let q = r#"fields @timestamp, @message, level | filter level in ["error", "info"] | sort @timestamp asc"#;
    let stmt = c
        .prepare(&format!("SELECT * FROM cloudwatch_logs('/aws/lambda/a, /aws/lambda/b', {}, {RANGE}) ORDER BY \"timestamp\"", sql_lit(q)))
        .await
        .unwrap();
    assert_eq!(names(&stmt), ["timestamp", "message", "fields"]);
    assert_eq!(oids(&stmt), vec![1184, 25, 114]);
    let rows = c.query(&stmt, &[]).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert!(
        (secs(rows[0].get::<_, SystemTime>(0)) - (T0 + 1.25)).abs() < 1e-6,
        "@timestamp is UTC"
    );
    assert_eq!(rows[0].get::<_, String>(1), "first event");
    let fields: Value = rows[0].get(2);
    assert_eq!(fields["level"], "error");
    assert!(fields.get("@ptr").is_none(), "@ptr is not a field");
    let start = &logs.calls("StartQuery")[0].input;
    assert_eq!(
        start["logGroupNames"],
        json!(["/aws/lambda/a", "/aws/lambda/b"])
    );
    assert_eq!(start["queryString"], q, "Logs Insights query passed whole");
    assert_eq!(start["startTime"].as_f64(), Some(T0));
    assert_eq!(start["endTime"].as_f64(), Some(T0 + 3600.0));
    assert!(
        logs.calls("GetQueryResults").len() >= 3,
        "polled until Complete"
    );
    assert_eq!(
        aws::sigv4_key_id(&logs.calls("StartQuery")[0].request).as_deref(),
        Some(AWS_KEY_ID)
    );
}

/// eng-cloudwatch-logs-failure-and-cancel
#[tokio::test]
async fn eng_cloudwatch_logs_failure_and_cancel() {
    let failing = logs_insights_mock(0, "Failed", vec![]).await;
    let never = logs_insights_mock(usize::MAX, "Complete", vec![]).await;
    let engine = Engine::start(
        Cfg::new()
            .table(&logs_source(
                "logs-failing",
                &failing.server.url(),
                "default = true",
            ))
            .table(&logs_source("logs-never", &never.server.url(), "")),
    )
    .await;
    let c = engine.connect().await;
    let (_, msg) = db_error(
        c.query(
            &format!("SELECT * FROM cloudwatch_logs('/aws/a', 'fields @message', {RANGE})"),
            &[],
        )
        .await,
    );
    assert!(
        msg.contains("Failed"),
        "the query status is reported: {msg}"
    );

    c.batch_execute("SET statement_timeout = 700")
        .await
        .unwrap();
    let t = Instant::now();
    let r = c
        .query(
            &format!(
                "SELECT * FROM cloudwatch_logs('/aws/a', 'fields @message', {RANGE}, 'logs-never')"
            ),
            &[],
        )
        .await;
    assert_sqlstate(r, "57014", "");
    assert!(t.elapsed() < Duration::from_secs(4));
    let deadline = Instant::now() + Duration::from_secs(3);
    while never.calls("StopQuery").is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let stops = never.calls("StopQuery");
    assert_eq!(
        stops.len(),
        1,
        "an abandoned Logs Insights query is stopped"
    );
    assert_eq!(stops[0].input["queryId"], "query-1");
    let polls = never.calls("GetQueryResults").len();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(never.calls("GetQueryResults").len(), polls, "polling stops");
}

/// eng-traceql-search
#[tokio::test]
async fn eng_traceql_search() {
    let search = tempo_search(&[
        TempoTrace {
            trace_id: "2f3e0cee77ae5dc9c17ade3689eb2e54",
            root_service: "web",
            root_name: "GET /orders",
            start_ns: "1762560000500000000",
            duration_ms: 557,
            matched: 3,
        },
        TempoTrace {
            trace_id: "0af7651916cd43dd8448eb211c80319c",
            root_service: "api",
            root_name: "POST /fills",
            start_ns: "1762560010000000000",
            duration_ms: 12,
            matched: 1,
        },
    ]);
    let mock = tempo_mock(search, "00".repeat(16), json!({"batches": []})).await;
    let engine = Engine::start(Cfg::new().tempo("tempo-a", &mock.url(), "")).await;
    let c = engine.connect().await;
    let q = r#"{ resource.service.name = "web" && span.http.status_code >= 500 }"#;
    let stmt = c
        .prepare(&format!(
            "SELECT * FROM traceql({}, {RANGE}) ORDER BY \"start\"",
            sql_lit(q)
        ))
        .await
        .unwrap();
    assert_eq!(
        names(&stmt),
        [
            "trace_id",
            "root_service",
            "root_name",
            "start",
            "duration_ms",
            "span_count"
        ]
    );
    assert_eq!(oids(&stmt), vec![25, 25, 25, 1184, 701, 20]);
    let rows = c.query(&stmt, &[]).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0].get::<_, String>(0),
        "2f3e0cee77ae5dc9c17ade3689eb2e54"
    );
    assert_eq!(rows[0].get::<_, String>(1), "web");
    assert_eq!(rows[0].get::<_, String>(2), "GET /orders");
    assert!((secs(rows[0].get::<_, SystemTime>(3)) - (T0 + 0.5)).abs() < 1e-6);
    assert_eq!(rows[0].get::<_, f64>(4), 557.0);
    assert_eq!(rows[0].get::<_, i64>(5), 3);
    let r = mock.requests_to("/api/search").pop().unwrap();
    assert_eq!(p(&r, "q"), q);
    assert_eq!(parse_time_param(&p(&r, "start")), T0);
    assert_eq!(parse_time_param(&p(&r, "end")), T0 + 3600.0);
    assert_eq!(p(&r, "limit"), "20", "default limit");
    c.query(
        &format!("SELECT * FROM traceql({}, {RANGE}, 5)", sql_lit(q)),
        &[],
    )
    .await
    .unwrap();
    assert_eq!(
        p(&mock.requests_to("/api/search").pop().unwrap(), "limit"),
        "5"
    );
}

/// eng-trace-by-id
#[tokio::test]
async fn eng_trace_by_id() {
    let trace_id = "0af7651916cd43dd8448eb211c80319c";
    let ns = 1_762_560_000_000_000_000u64;
    let trace = tempo_trace_batches(
        trace_id,
        &[
            OtlpSpan {
                service: "web",
                span_id: "b7ad6b7169203331",
                parent_span_id: "",
                name: "GET /orders",
                start_ns: ns,
                end_ns: ns + 250_000_000,
                status: "",
                attributes: json!([{"key": "http.method", "value": {"stringValue": "GET"}}]),
            },
            OtlpSpan {
                service: "api",
                span_id: "00f067aa0ba902b7",
                parent_span_id: "b7ad6b7169203331",
                name: "SELECT orders",
                start_ns: ns + 10_000_000,
                end_ns: ns + 110_500_000,
                status: "STATUS_CODE_ERROR",
                attributes: json!([{"key": "db.system", "value": {"stringValue": "postgresql"}}, {"key": "http.status_code", "value": {"intValue": "500"}}, {"key": "retry", "value": {"boolValue": true}}, {"key": "ratio", "value": {"doubleValue": 0.5}}]),
            },
            OtlpSpan {
                service: "api",
                span_id: "1111111111111111",
                parent_span_id: "b7ad6b7169203331",
                name: "render",
                start_ns: ns + 200_000_000,
                end_ns: ns + 201_000_000,
                status: "STATUS_CODE_OK",
                attributes: json!([]),
            },
        ],
    );
    let mock = tempo_mock(tempo_search(&[]), trace_id.into(), trace).await;
    let engine = Engine::start(Cfg::new().tempo("tempo-a", &mock.url(), "")).await;
    let c = engine.connect().await;
    let stmt = c
        .prepare(&format!(
            "SELECT * FROM trace('{trace_id}') ORDER BY \"start\""
        ))
        .await
        .unwrap();
    assert_eq!(
        names(&stmt),
        [
            "trace_id",
            "span_id",
            "parent_span_id",
            "service",
            "name",
            "start",
            "duration_ms",
            "status",
            "attributes"
        ]
    );
    assert_eq!(oids(&stmt), vec![25, 25, 25, 25, 25, 1184, 701, 25, 114]);
    let rows = c.query(&stmt, &[]).await.unwrap();
    assert_eq!(rows.len(), 3);
    let root = &rows[0];
    assert_eq!(root.get::<_, String>(0), trace_id, "ids are lowercase hex");
    assert_eq!(root.get::<_, String>(1), "b7ad6b7169203331");
    assert_eq!(
        root.get::<_, Option<String>>(2),
        None,
        "a root span has no parent"
    );
    assert_eq!(root.get::<_, String>(3), "web");
    assert_eq!(root.get::<_, String>(4), "GET /orders");
    assert_eq!(secs(root.get::<_, SystemTime>(5)), T0);
    assert_eq!(root.get::<_, f64>(6), 250.0);
    assert_eq!(root.get::<_, String>(7), "unset");
    let db = &rows[1];
    assert_eq!(
        db.get::<_, Option<String>>(2).as_deref(),
        Some("b7ad6b7169203331")
    );
    assert_eq!(db.get::<_, String>(3), "api");
    assert_eq!(db.get::<_, f64>(6), 100.5);
    assert_eq!(db.get::<_, String>(7), "error");
    assert_eq!(
        db.get::<_, Value>(8),
        json!({"db.system": "postgresql", "http.status_code": 500, "retry": true, "ratio": 0.5})
    );
    assert_eq!(rows[2].get::<_, String>(7), "ok");
    // Unknown trace id: no rows.
    let rows = c
        .query(&format!("SELECT * FROM trace('{}')", "ab".repeat(16)), &[])
        .await
        .unwrap();
    assert!(rows.is_empty());
}
