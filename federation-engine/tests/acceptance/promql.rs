//! Prometheus table functions (§1.1), time arguments, label()/series_name(), pushdown, max_rows.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio_postgres::types::Type;

use crate::harness::telemetry::*;
use crate::harness::*;

const T0: f64 = 1_762_560_000.0; // 2026-11-08T00:00:00Z
const RANGE: &str = "'2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z'";

pub fn secs(t: SystemTime) -> f64 {
    t.duration_since(UNIX_EPOCH).unwrap().as_secs_f64()
}

fn two_series() -> Value {
    prom_matrix(&[
        (
            json!({"__name__": "http_requests_total", "job": "api", "pod": "api-1"}),
            vec![
                (T0, "1".into()),
                (T0 + 30.0, "2.5".into()),
                (T0 + 60.0, "NaN".into()),
            ],
        ),
        (
            json!({"job": "api", "pod": "api-2"}),
            vec![
                (T0, "4".into()),
                (T0 + 30.0, "+Inf".into()),
                (T0 + 60.0, "6".into()),
            ],
        ),
    ])
}

async fn prom_engine(range: Value, instant: Value) -> (Engine, MockServer) {
    let mock = prometheus_mock(range, instant).await;
    let engine = Engine::start(Cfg::new().prometheus("prom-a", &mock.url(), "")).await;
    (engine, mock)
}

fn param(r: &Recorded, k: &str) -> String {
    r.param_or_form(k)
        .unwrap_or_else(|| panic!("request {} has no {k} parameter", r.raw_target))
}

/// eng-promql-range
#[tokio::test]
async fn eng_promql_range() {
    let (engine, mock) = prom_engine(two_series(), prom_vector(&[])).await;
    let c = engine.connect().await;
    let q = "rate(http_requests_total{job=\"api\"}[5m])";
    let sql = format!("SELECT * FROM promql({}, {RANGE}, '30s')", sql_lit(q));
    let stmt = c.prepare(&sql).await.unwrap();
    let cols: Vec<(String, u32)> = stmt
        .columns()
        .iter()
        .map(|c| (c.name().to_string(), c.type_().oid()))
        .collect();
    assert_eq!(
        cols,
        vec![
            ("timestamp".into(), 1184),
            ("value".into(), 701),
            ("labels".into(), 114),
            ("series".into(), 25)
        ]
    );
    let rows = c.query(&stmt, &[]).await.unwrap();
    assert_eq!(rows.len(), 6);

    let reqs = mock.requests_to("/api/v1/query_range");
    let r = reqs.last().expect("query_range was called");
    assert_eq!(
        param(r, "query"),
        q,
        "the native query goes to the source unchanged"
    );
    assert_eq!(parse_time_param(&param(r, "start")), T0);
    assert_eq!(parse_time_param(&param(r, "end")), T0 + 3600.0);
    assert_eq!(parse_duration_param(&param(r, "step")), 30.0);

    let mut got: Vec<(f64, f64, Value, String)> = rows
        .iter()
        .map(|r| {
            (
                secs(r.get::<_, SystemTime>(0)),
                r.get::<_, f64>(1),
                r.get::<_, Value>(2),
                r.get::<_, String>(3),
            )
        })
        .collect();
    got.sort_by(|a, b| (a.3.clone(), a.0).partial_cmp(&(b.3.clone(), b.0)).unwrap());
    let s1 = "{__name__=\"http_requests_total\",job=\"api\",pod=\"api-1\"}";
    let s2 = "{job=\"api\",pod=\"api-2\"}";
    assert_eq!(got[0].3, s1);
    assert_eq!(got[0].0, T0);
    assert_eq!(got[0].1, 1.0);
    assert_eq!(
        got[0].2,
        json!({"__name__": "http_requests_total", "job": "api", "pod": "api-1"})
    );
    assert_eq!(got[1].1, 2.5);
    assert!(got[2].1.is_nan(), "NaN sample");
    assert_eq!(got[3].3, s2);
    assert_eq!(got[3].1, 4.0);
    assert!(got[4].1.is_infinite() && got[4].1 > 0.0, "+Inf sample");
    assert_eq!(got[5].0, T0 + 60.0);

    // Empty result: zero rows, same columns.
    let (engine2, _m) = prom_engine(prom_matrix(&[]), prom_vector(&[])).await;
    let c2 = engine2.connect().await;
    let rows = c2
        .query(&format!("SELECT * FROM promql('up', {RANGE}, '1m')"), &[])
        .await
        .unwrap();
    assert!(rows.is_empty());
}

/// eng-promql-instant
#[tokio::test]
async fn eng_promql_instant() {
    let at = "2026-11-08T00:10:00Z";
    let t = T0 + 600.0;
    let vector = prom_vector(&[
        (json!({"job": "api"}), t, "3"),
        (json!({"job": "worker"}), t, "0.25"),
    ]);
    let (engine, mock) = prom_engine(prom_matrix(&[]), vector).await;
    let c = engine.connect().await;
    let stmt = c
        .prepare(&format!(
            "SELECT * FROM promql_instant('up', '{at}') ORDER BY series"
        ))
        .await
        .unwrap();
    let oids: Vec<u32> = stmt.columns().iter().map(|c| c.type_().oid()).collect();
    assert_eq!(oids, vec![1184, 701, 114, 25]);
    let rows = c.query(&stmt, &[]).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<_, String>(3), "{job=\"api\"}");
    assert_eq!(rows[0].get::<_, f64>(1), 3.0);
    assert_eq!(secs(rows[0].get::<_, SystemTime>(0)), t);
    assert_eq!(rows[1].get::<_, f64>(1), 0.25);
    let r = mock.requests_to("/api/v1/query").pop().unwrap();
    assert_eq!(param(&r, "query"), "up");
    assert_eq!(parse_time_param(&param(&r, "time")), t);

    // scalar: one row, empty labels.
    let (engine, _m) = prom_engine(prom_matrix(&[]), prom_scalar(t, "42")).await;
    let c = engine.connect().await;
    let rows = c
        .query(
            &format!("SELECT * FROM promql_instant('scalar(1)', '{at}')"),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<_, f64>(1), 42.0);
    assert_eq!(rows[0].get::<_, Value>(2), json!({}));
    assert_eq!(rows[0].get::<_, String>(3), "{}");

    // string: one row, value NULL, labels {}, series = the string (contract assumption).
    let (engine, _m) = prom_engine(prom_matrix(&[]), prom_string(t, "hello")).await;
    let c = engine.connect().await;
    let rows = c
        .query(
            &format!("SELECT * FROM promql_instant('\"hello\"', '{at}')"),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<_, Option<f64>>(1), None);
    assert_eq!(rows[0].get::<_, Value>(2), json!({}));
    assert_eq!(rows[0].get::<_, String>(3), "hello");

    // A matrix answer to an instant query is accepted too (e.g. `up[5m]`).
    let (engine, _m) = prom_engine(prom_matrix(&[]), two_series()).await;
    let c = engine.connect().await;
    let rows = c
        .query(
            &format!("SELECT * FROM promql_instant('up[1m]', '{at}')"),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 6);
}

/// eng-time-arguments
#[tokio::test]
async fn eng_time_arguments() {
    let (engine, mock) = prom_engine(prom_matrix(&[]), prom_vector(&[])).await;
    let c = engine.connect().await;
    let cases: Vec<(String, f64, f64, f64)> = vec![
        (
            "'2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z', '1m'".into(),
            T0,
            T0 + 3600.0,
            60.0,
        ),
        (
            "'2026-11-08T02:00:00+02:00', '2026-11-08T00:30:00.500Z', '1h30m'".into(),
            T0,
            T0 + 1800.5,
            5400.0,
        ),
        (
            "CAST('2026-11-08T00:00:00Z' AS TIMESTAMP WITH TIME ZONE), CAST('2026-11-08T06:00:00Z' AS TIMESTAMP WITH TIME ZONE), '15s'".into(),
            T0,
            T0 + 21600.0,
            15.0,
        ),
        (
            "to_timestamp(1762560000), to_timestamp(1762563600), '5m'".into(),
            T0,
            T0 + 3600.0,
            300.0,
        ),
    ];
    for (i, (args, start, end, step)) in cases.iter().enumerate() {
        c.query(&format!("SELECT * FROM promql('up', {args})"), &[])
            .await
            .unwrap_or_else(|e| panic!("case {i} ({args}): {e}"));
        let r = mock.requests_to("/api/v1/query_range").pop().unwrap();
        assert_eq!(
            parse_time_param(&param(&r, "start")),
            *start,
            "case {i} start"
        );
        assert_eq!(parse_time_param(&param(&r, "end")), *end, "case {i} end");
        assert_eq!(
            parse_duration_param(&param(&r, "step")),
            *step,
            "case {i} step"
        );
    }
    // now()-relative.
    c.query(
        "SELECT * FROM promql('up', now() - INTERVAL '1 hour', now(), '1m')",
        &[],
    )
    .await
    .unwrap();
    let r = mock.requests_to("/api/v1/query_range").pop().unwrap();
    let now = now_secs() as f64;
    let (s, e) = (
        parse_time_param(&param(&r, "start")),
        parse_time_param(&param(&r, "end")),
    );
    assert!(
        (e - now).abs() < 60.0 && (e - s - 3600.0).abs() < 1.0,
        "start {s} end {e}"
    );

    let before = mock.requests().len();
    for bad in [
        "'2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z', 'abc'",
        "'yesterday', '2026-11-08T01:00:00Z', '1m'",
        "'2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z', '0s'",
    ] {
        let r = c
            .query(&format!("SELECT * FROM promql('up', {bad})"), &[])
            .await;
        assert!(r.is_err(), "bad arguments must be rejected: {bad}");
    }
    assert_eq!(
        mock.requests().len(),
        before,
        "invalid arguments never reach the source"
    );
}

/// eng-promql-source-selection
#[tokio::test]
async fn eng_promql_source_selection() {
    let a = prometheus_mock(
        prom_matrix(&[(json!({"from": "a"}), vec![(T0, "1".into())])]),
        prom_vector(&[]),
    )
    .await;
    let b = prometheus_mock(
        prom_matrix(&[(json!({"from": "b"}), vec![(T0, "2".into())])]),
        prom_vector(&[(json!({"from": "b"}), T0, "2")]),
    )
    .await;
    let loki = MockServer::start(|_| Reply::text(200, "ready")).await;
    let engine = Engine::start(
        Cfg::new()
            .prometheus("prom-b", &b.url(), "")
            .prometheus("prom-a", &a.url(), "default = true")
            .loki("only-loki", &loki.url(), ""),
    )
    .await;
    let c = engine.connect().await;
    let from = |rows: Vec<tokio_postgres::Row>| -> String {
        label_of(&rows[0].get::<_, Value>(2), "from")
    };
    let rows = c
        .query(&format!("SELECT * FROM promql('up', {RANGE}, '1m')"), &[])
        .await
        .unwrap();
    assert_eq!(from(rows), "a", "default source");
    let rows = c
        .query(
            &format!("SELECT * FROM promql('up', {RANGE}, '1m', 'prom-b')"),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(from(rows), "b", "named source");
    let rows = c
        .query(
            "SELECT * FROM promql_instant('up', '2026-11-08T00:00:00Z', 'prom-b')",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(from(rows), "b");
    let r = c
        .query(
            &format!("SELECT * FROM promql('up', {RANGE}, '1m', 'nope')"),
            &[],
        )
        .await;
    assert_sqlstate(r, "42704", "nope");
    let r = c
        .query(
            &format!("SELECT * FROM promql('up', {RANGE}, '1m', 'only-loki')"),
            &[],
        )
        .await;
    let (_, msg) = db_error(r);
    assert!(
        msg.contains("only-loki"),
        "kind mismatch names the source: {msg}"
    );
    assert!(loki.requests_to("/loki/").is_empty());
}

fn label_of(labels: &Value, k: &str) -> String {
    labels[k].as_str().unwrap_or_default().to_string()
}

/// eng-promql-upstream-errors
#[tokio::test]
async fn eng_promql_upstream_errors() {
    let mock = MockServer::start(|r| {
        let q = r.param_or_form("query").unwrap_or_default();
        match q.as_str() {
            "bad_query(" => Reply::json_status(
                400,
                &prom_error(
                    "bad_data",
                    "parse error at char 11: unclosed left parenthesis",
                ),
            ),
            "html" => Reply::new(503, "text/html", "<html>upstream unavailable</html>"),
            "garbage" => Reply::new(200, "application/json", "{not json"),
            "warn" => Reply::json(&prom_ok("matrix", json!([]))),
            _ => Reply::text(200, "ready"),
        }
    })
    .await;
    let engine = Engine::start(
        Cfg::new()
            .prometheus("prom-a", &mock.url(), "default = true")
            .prometheus("prom-down", &crate::harness::mock_http::dead_url(), ""),
    )
    .await;
    let c = engine.connect().await;
    let run =
        |q: &str, src: &str| format!("SELECT * FROM promql({}, {RANGE}, '1m'{src})", sql_lit(q));
    let (_, msg) = db_error(c.query(&run("bad_query(", ""), &[]).await);
    assert!(
        msg.contains("parse error at char 11"),
        "upstream error text is passed on: {msg}"
    );
    let (_, msg) = db_error(c.query(&run("html", ""), &[]).await);
    assert!(
        msg.contains("503") || msg.to_lowercase().contains("unavailable"),
        "{msg}"
    );
    assert!(c.query(&run("garbage", ""), &[]).await.is_err());
    let (_, msg) = db_error(c.query(&run("up", ", 'prom-down'"), &[]).await);
    assert!(
        msg.contains("prom-down"),
        "unreachable source is named: {msg}"
    );
    // The session is fine afterwards.
    assert!(c.query(&run("warn", ""), &[]).await.unwrap().is_empty());
}

/// eng-label-function
#[tokio::test]
async fn eng_label_function() {
    let (engine, _mock) = prom_engine(two_series(), prom_vector(&[])).await;
    let c = engine.connect().await;
    let rows = c
        .query(
            &format!("SELECT label(labels, 'pod') AS pod, label(labels, '__name__') AS n, label(labels, 'missing') AS m FROM promql('up', {RANGE}, '30s') ORDER BY pod, \"timestamp\""),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0].get::<_, String>(0), "api-1");
    assert_eq!(
        rows[0].get::<_, Option<String>>(1).as_deref(),
        Some("http_requests_total")
    );
    assert_eq!(rows[3].get::<_, String>(0), "api-2");
    assert_eq!(
        rows[3].get::<_, Option<String>>(1),
        None,
        "missing key is NULL"
    );
    assert!(rows.iter().all(|r| r.get::<_, Option<String>>(2).is_none()));
    let stmt = c
        .prepare("SELECT label('{\"a\":\"b\"}', 'a') AS v")
        .await
        .unwrap();
    assert_eq!(stmt.columns()[0].type_(), &Type::TEXT);
    let row = c.query_one(&stmt, &[]).await.unwrap();
    assert_eq!(row.get::<_, String>(0), "b");
    let row = c
        .query_one("SELECT label(NULL, 'a') AS v, label('{}', 'a') AS w", &[])
        .await
        .unwrap();
    assert_eq!(row.get::<_, Option<String>>(0), None);
    assert_eq!(row.get::<_, Option<String>>(1), None);
    // WHERE and GROUP BY on a label run in the engine.
    let rows = c
        .query(
            &format!("SELECT label(labels, 'pod') AS pod, count(*) AS n FROM promql('up', {RANGE}, '30s') WHERE label(labels, 'job') = 'api' GROUP BY 1 ORDER BY 1"),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].get::<_, i64>(1), 3);
}

/// eng-series-name-function
#[tokio::test]
async fn eng_series_name_function() {
    let (engine, _mock) = prom_engine(two_series(), prom_vector(&[])).await;
    let c = engine.connect().await;
    let one = |sql: String| {
        let c = &c;
        async move { c.query_one(&sql, &[]).await.unwrap().get::<_, String>(0) }
    };
    assert_eq!(
        one("SELECT series_name('{\"b\":\"2\",\"a\":\"1\"}')".into()).await,
        "{a=\"1\",b=\"2\"}"
    );
    assert_eq!(one("SELECT series_name('{}')".into()).await, "{}");
    assert_eq!(
        one(r#"SELECT series_name('{"k":"say \"hi\" \\ now\nplease"}')"#.into()).await,
        r#"{k="say \"hi\" \\ now\nplease"}"#,
        "Prometheus escaping of quotes, backslashes and newlines"
    );
    let rows = c
        .query(
            &format!(
                "SELECT series_name(labels) = series AS same FROM promql('up', {RANGE}, '30s')"
            ),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 6);
    assert!(
        rows.iter().all(|r| r.get::<_, bool>(0)),
        "series column equals series_name(labels)"
    );
}

/// eng-promql-pushdown-and-sql
#[tokio::test]
async fn eng_promql_pushdown_and_sql() {
    let series: Vec<Series> = (0..4)
        .map(|i| {
            (
                json!({"pod": format!("api-{}", i % 2), "container": format!("c{i}")}),
                (0..5)
                    .map(|j| {
                        (
                            T0 + 60.0 * j as f64,
                            format!("{}", i as f64 * 0.5 + j as f64 * 0.1),
                        )
                    })
                    .collect(),
            )
        })
        .collect();
    let (engine, mock) = prom_engine(prom_matrix(&series), prom_vector(&[])).await;
    let c = engine.connect().await;
    let q = r#"sum by (pod, container) (rate(container_cpu_usage_seconds_total{namespace="web",pod=~"api-.*"}[5m]))"#;
    let rows = c
        .query(
            &format!(
                "SELECT label(labels, 'pod') AS pod, count(*) AS n, max(\"value\") AS peak
                 FROM promql({}, {RANGE}, '1m')
                 WHERE \"value\" > 0.45
                 GROUP BY 1 ORDER BY 1",
                sql_lit(q)
            ),
            &[],
        )
        .await
        .unwrap();
    let got: Vec<(String, i64, f64)> = rows
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    // api-0: series 0 (0.0..0.4: none > 0.45) and 2 (1.0..1.4: 5); api-1: series 1 (0.5..0.9: 5), 3 (1.5..1.9: 5).
    assert_eq!(got.len(), 2);
    assert_eq!((got[0].0.as_str(), got[0].1), ("api-0", 5));
    assert!((got[0].2 - 1.4).abs() < 1e-9);
    assert_eq!((got[1].0.as_str(), got[1].1), ("api-1", 10));
    assert!((got[1].2 - 1.9).abs() < 1e-9);
    let reqs = mock.requests_to("/api/v1/query_range");
    assert_eq!(reqs.len(), 1, "one source request per table function call");
    assert_eq!(
        param(&reqs[0], "query"),
        q,
        "the native query is passed whole and unchanged"
    );

    // Joining two calls and a VALUES list runs in the engine.
    let rows = c
        .query(
            &format!(
                "SELECT a.series, v.team FROM promql('up', {RANGE}, '1m') a
                 JOIN (VALUES ('api-0', 'blue'), ('api-1', 'green')) AS v(pod, team) ON label(a.labels, 'pod') = v.pod
                 WHERE a.\"timestamp\" = CAST('2026-11-08T00:00:00Z' AS TIMESTAMP WITH TIME ZONE)
                 ORDER BY a.series"
            ),
            &[],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0].get::<_, String>(1), "blue");
}

/// eng-max-rows-overflow
#[tokio::test]
async fn eng_max_rows_overflow() {
    let body = |points: usize| {
        prom_matrix(&[
            (
                json!({"s": "1"}),
                (0..points).map(|j| (T0 + j as f64, "1".into())).collect(),
            ),
            (
                json!({"s": "2"}),
                (0..points).map(|j| (T0 + j as f64, "2".into())).collect(),
            ),
        ])
    };
    let mock = MockServer::start({
        let (b60, b50) = (body(60), body(50));
        move |r| match r.param_or_form("query").as_deref() {
            Some("sixty") => Reply::json(&b60),
            Some("fifty") => Reply::json(&b50),
            _ => Reply::text(200, "ready"),
        }
    })
    .await;
    let engine = Engine::start(
        Cfg::new()
            .top("max_rows = 100")
            .prometheus("prom-capped", &mock.url(), "default = true")
            .prometheus("prom-roomy", &mock.url(), "max_rows = 1000"),
    )
    .await;
    let c = engine.connect().await;
    let r = c
        .query(
            &format!("SELECT * FROM promql('sixty', {RANGE}, '1s')"),
            &[],
        )
        .await;
    assert_sqlstate(r, "54000", "result exceeds max_rows");
    let rows = c
        .query(
            &format!("SELECT * FROM promql('fifty', {RANGE}, '1s')"),
            &[],
        )
        .await
        .expect("exactly max_rows is fine");
    assert_eq!(rows.len(), 100);
    let rows = c
        .query(
            &format!("SELECT * FROM promql('sixty', {RANGE}, '1s', 'prom-roomy')"),
            &[],
        )
        .await
        .expect("per-source max_rows overrides the top-level one");
    assert_eq!(rows.len(), 120);
}
