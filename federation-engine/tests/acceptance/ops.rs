//! Operations: /healthz, /metrics, graceful shutdown, structured logs, the performance guard, and
//! an end-to-end Lightdash session.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::harness::raw_pg::RawPg;
use crate::harness::telemetry::*;
use crate::harness::*;
use crate::identity::{OPEN_SQL, RESTRICTED_SQL, restricted_reader, restricted_setup};

const T0: f64 = 1_762_560_000.0;
const RANGE: &str = "'2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z'";

/// eng-healthz
#[tokio::test]
async fn eng_healthz() {
    let prom = prometheus_mock(prom_matrix(&[]), prom_vector(&[])).await;
    let loki = MockServer::start(|_| Reply::text(200, "ready")).await;
    let tempo = MockServer::start(|_| Reply::text(200, "ready")).await;
    let healthy = Cfg::new()
        .prometheus("prom-up", &prom.url(), "")
        .loki("loki-up", &loki.url(), "")
        .tempo("tempo-up", &tempo.url(), "");
    let engine = Engine::start(healthy.clone()).await;
    let resp = reqwest::get(engine.http("/healthz")).await.unwrap();
    assert_eq!(
        resp.status().as_u16(),
        200,
        "no auth needed; all sources reachable"
    );
    let body = resp.text().await.unwrap();
    for n in ["prom-up", "loki-up", "tempo-up"] {
        assert!(body.contains(n), "per-source status for {n}: {body}");
    }
    let engine =
        Engine::start(healthy.prometheus("prom-dead", &crate::harness::mock_http::dead_url(), ""))
            .await;
    let resp = reqwest::get(engine.http("/healthz")).await.unwrap();
    assert_eq!(resp.status().as_u16(), 503);
    let body = resp.text().await.unwrap();
    assert!(
        body.contains("prom-dead"),
        "the unhealthy source is listed: {body}"
    );
}

/// Sum of the sample values of `name` whose label set contains `label` (e.g. `source="x"`).
fn metric(text: &str, name: &str, label: &str) -> f64 {
    text.lines()
        .filter(|l| !l.starts_with('#'))
        .filter(|l| l.starts_with(&format!("{name}{{")) || l.starts_with(&format!("{name} ")))
        .filter(|l| label.is_empty() || l.contains(label))
        .filter_map(|l| l.rsplit(' ').next()?.parse::<f64>().ok())
        .sum()
}

/// eng-metrics
#[tokio::test]
async fn eng_metrics() {
    let bad = MockServer::start(|r| {
        if r.path.starts_with("/api/v1/") {
            Reply::text(500, "boom")
        } else {
            Reply::text(200, "ready")
        }
    })
    .await;
    let s = restricted_setup(Cfg::new().prometheus("prom-bad", &bad.url(), "")).await;
    let c = s.engine.connect().await;
    c.query(OPEN_SQL, &[]).await.unwrap();
    c.query(OPEN_SQL, &[]).await.unwrap();
    assert!(
        c.query(
            &format!("SELECT * FROM promql('up', {RANGE}, '1m', 'prom-bad')"),
            &[]
        )
        .await
        .is_err()
    );
    s.audit.fail_dynamo(true);
    set_identity(&c, &restricted_reader().token()).await;
    assert!(c.query(RESTRICTED_SQL, &[]).await.is_err());
    let resp = reqwest::get(s.engine.http("/metrics")).await.unwrap();
    assert_eq!(resp.status().as_u16(), 200, "no auth");
    let ct = resp
        .headers()
        .get("content-type")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    assert!(
        ct.starts_with("text/plain"),
        "Prometheus exposition content type: {ct}"
    );
    let text = resp.text().await.unwrap();
    assert!(
        metric(
            &text,
            "federation_engine_queries_total",
            "source=\"prom-open\""
        ) >= 2.0,
        "{text}"
    );
    assert!(
        metric(
            &text,
            "federation_engine_query_duration_seconds_count",
            "source=\"prom-open\""
        ) >= 2.0,
        "latency histogram per source"
    );
    assert!(text.lines().any(
        |l| l.starts_with("federation_engine_query_duration_seconds_bucket{")
            && l.contains("source=\"prom-open\"")
            && l.contains("le=")
    ));
    assert!(
        metric(
            &text,
            "federation_engine_query_errors_total",
            "source=\"prom-bad\""
        ) >= 1.0
    );
    assert!(metric(&text, "federation_engine_audit_write_failures_total", "") >= 1.0);
    assert!(text.contains("# TYPE federation_engine_queries_total counter"));
    assert!(text.contains("# TYPE federation_engine_query_duration_seconds histogram"));
}

/// eng-graceful-shutdown
#[tokio::test]
async fn eng_graceful_shutdown() {
    let body = prom_matrix(&[(json!({"job": "slow"}), vec![(T0, "1".into())])]);
    let mock = MockServer::start(move |r| {
        if r.path.starts_with("/api/v1/") {
            Reply::json(&body).delayed(Duration::from_secs(2))
        } else {
            Reply::text(200, "ready")
        }
    })
    .await;
    let mut engine = Engine::start(Cfg::new().prometheus("prom-slow", &mock.url(), "")).await;
    let c = engine.connect().await;
    let q = tokio::spawn(async move {
        c.query(&format!("SELECT * FROM promql('up', {RANGE}, '1m')"), &[])
            .await
            .map(|r| r.len())
    });
    assert!(mock.wait_requests(1, Duration::from_secs(10)).await);
    engine.sigterm();
    let rows = q
        .await
        .unwrap()
        .expect("an in-flight query finishes during shutdown");
    assert_eq!(rows, 1);
    let status = engine
        .wait_exit(Duration::from_secs(15))
        .await
        .expect("the engine exits after draining");
    assert!(status.success(), "clean exit: {status:?}");
    assert!(engine.connect_as(PG_USER, PG_PASSWORD).await.is_err());
}

/// eng-json-logs
#[tokio::test]
async fn eng_json_logs() {
    let canary = "canary-result-7f3a9c";
    let body = prom_matrix(&[(json!({"secret_label": canary}), vec![(T0, "1".into())])]);
    let open = prometheus_mock(body.clone(), prom_vector(&[])).await;
    let restricted = prometheus_mock(body, prom_vector(&[])).await;
    let audit = crate::harness::aws::AuditStore::start().await;
    let engine = Engine::start(
        Cfg::new()
            .prometheus("prom-open", &open.url(), "default = true")
            .prometheus("prom-restricted", &restricted.url(), "restricted = true")
            .audit(&audit),
    )
    .await;
    let c = engine.connect().await;
    let id = restricted_reader().description("description-canary-41b2");
    let token = id.token();
    set_identity(&c, &token).await;
    c.query(OPEN_SQL, &[]).await.unwrap();
    c.query(RESTRICTED_SQL, &[]).await.unwrap();
    assert!(
        engine
            .connect_as(PG_USER, "wrong-password-canary")
            .await
            .is_err()
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    let logs = format!("{}{}", engine.stdout_text(), engine.stderr_text());
    let lines: Vec<&str> = logs.lines().filter(|l| !l.trim().is_empty()).collect();
    assert!(!lines.is_empty(), "the engine logs something");
    for l in &lines {
        let v: Value =
            serde_json::from_str(l).unwrap_or_else(|_| panic!("not a JSON log line: {l}"));
        assert!(
            v.get("timestamp").is_some() && v.get("level").is_some(),
            "JSON log lines carry timestamp and level: {l}"
        );
    }
    for forbidden in [
        canary,
        token.as_str(),
        &id.email(),
        "description-canary-41b2",
        IDENTITY_SECRET,
        PG_PASSWORD,
        "wrong-password-canary",
        AUDIT_KEY,
    ] {
        assert!(
            !logs.contains(forbidden),
            "logs must not contain query results, identity payloads or secrets ({forbidden})"
        );
    }
    let payload = token.split('.').next().unwrap();
    assert!(!logs.contains(payload));
}

/// eng-perf-promql-large-range
#[tokio::test]
async fn eng_perf_promql_large_range() {
    let series: Vec<Series> = (0..1000)
        .map(|i| {
            (
                json!({"__name__": "perf_metric", "instance": format!("host-{i:04}"), "job": "perf"}),
                (0..360).map(|j| (T0 + 10.0 * j as f64, format!("{}", (i * 360 + j) as f64 * 0.5))).collect(),
            )
        })
        .collect();
    let body = prom_matrix(&series);
    let mock = prometheus_mock(body, prom_vector(&[])).await;
    let engine = Engine::start(Cfg::new().top("max_rows = 500000").prometheus(
        "prom-perf",
        &mock.url(),
        "",
    ))
    .await;
    let c = engine.connect().await;
    let sql = format!("SELECT * FROM promql('perf_metric', {RANGE}, '10s')");
    let warm = c.query(&sql, &[]).await.unwrap();
    assert_eq!(warm.len(), 360_000);
    drop(warm);
    let t = Instant::now();
    let rows = c.query(&sql, &[]).await.unwrap();
    let elapsed = t.elapsed();
    assert_eq!(rows.len(), 360_000);
    assert!(
        elapsed < Duration::from_secs(2),
        "1000 series x 360 points took {elapsed:?} (budget 2 s)"
    );
    let total: f64 = rows.iter().map(|r| r.get::<_, f64>(1)).sum();
    let n = 360_000.0f64;
    assert_eq!(total, 0.5 * n * (n - 1.0) / 2.0);
}

/// eng-lightdash-session-compat
#[tokio::test]
async fn eng_lightdash_session_compat() {
    let series: Vec<Series> = (0..5)
        .map(|i| {
            (
                json!({"pod": format!("p{i}")}),
                (0..50)
                    .map(|j| (T0 + 60.0 * j as f64, j.to_string()))
                    .collect(),
            )
        })
        .collect();
    let mock = prometheus_mock(prom_matrix(&series), prom_vector(&[])).await;
    let engine = Engine::start(Cfg::new().prometheus("prom-a", &mock.url(), "")).await;
    let mut raw = RawPg::connect(engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .unwrap();
    // PostgresWarehouseClient's session preamble, each as its own simple query.
    for stmt in [
        "SET statement_timeout = 570000".to_string(),
        "SET lightdash.agent = 'true'".to_string(),
        "SET timezone TO 'UTC'".to_string(),
        format!(
            "SET hrx.identity = {}",
            sql_lit(&Identity::person().token())
        ),
    ] {
        let (_, _, err) = raw.simple_query(&stmt).await;
        assert!(err.is_none(), "{stmt}: {err:?}");
    }
    // The query itself through pg-cursor, 100-row batches.
    let (fields, batches) = raw
        .cursor_read_all(
            "C_1",
            &format!("SELECT \"timestamp\", \"value\", labels, series FROM promql('rate(x[5m])', {RANGE}, '1m') ORDER BY series, \"timestamp\""),
            &[],
            100,
        )
        .await
        .expect("cursor query");
    assert_eq!(
        fields.iter().map(|f| f.type_oid).collect::<Vec<_>>(),
        vec![1184, 701, 114, 25]
    );
    assert_eq!(
        batches.iter().map(|b| b.len()).collect::<Vec<_>>(),
        vec![100, 100, 50]
    );
    let first = &batches[0][0];
    assert!(
        first[0]
            .as_deref()
            .unwrap()
            .starts_with("2026-11-08 00:00:00"),
        "{first:?}"
    );
    let labels: Value =
        serde_json::from_str(first[2].as_deref().unwrap()).expect("labels as json text");
    assert_eq!(labels, json!({"pod": "p0"}));
    // The other things the client asks.
    let (_, batches) = raw
        .cursor_read_all("C_2", "SELECT current_setting('TIMEZONE') AS tz", &[], 100)
        .await
        .unwrap();
    assert_eq!(batches[0][0][0].as_deref(), Some("UTC"));
    let (_, batches) = raw
        .cursor_read_all("C_3", "SELECT version()", &[], 100)
        .await
        .unwrap();
    assert!(
        batches[0][0][0]
            .as_deref()
            .unwrap()
            .starts_with("PostgreSQL 16.0 (hrx-federation-engine ")
    );
    let (_, _) = raw
        .cursor_read_all(
            "C_4",
            "SELECT table_catalog, table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND table_schema = $2",
            &[Some("tables"), Some("information_schema")],
            100,
        )
        .await
        .expect("getFields with positional parameters");
}
