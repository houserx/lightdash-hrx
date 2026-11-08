//! pg-wire server (§1): login, simple and extended protocol, portals, types, version, SETs,
//! information_schema, timeouts, cancellation, disconnect cleanup, TLS.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tokio_postgres::types::Type;

use crate::harness::raw_pg::{Msg, RawPg, send_cancel, ssl_request_answer};
use crate::harness::telemetry::*;
use crate::harness::*;

fn plain_cfg() -> Cfg {
    Cfg::new()
}

/// An engine whose only source is a Prometheus mock that holds every request for `delay`.
async fn slow_prom_engine(delay: Duration) -> (Engine, MockServer) {
    let body = prom_matrix(&[(json!({"job": "slow"}), vec![(1_762_560_000.0, "1".into())])]);
    let mock = MockServer::start(move |r| {
        if r.path.starts_with("/api/v1/query") {
            Reply::json(&body).delayed(delay)
        } else {
            Reply::text(200, "ready")
        }
    })
    .await;
    let engine = Engine::start(plain_cfg().prometheus("prom-slow", &mock.url(), "")).await;
    (engine, mock)
}

const SLOW_PROMQL: &str =
    "SELECT * FROM promql('up', '2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z', '1m')";

/// eng-pg-startup-auth
#[tokio::test]
async fn eng_pg_startup_auth() {
    let engine = Engine::start(
        plain_cfg()
            .table("[[users]]\nname = \"lightdash-second\"\npassword_env = \"HRX_PG_PASSWORD_SECOND\"\n")
            .env("HRX_PG_PASSWORD_SECOND", "test-second-password-not-real"),
    )
    .await;
    let c = engine.connect().await;
    let rows = simple_rows(c.simple_query("SELECT 1 AS one").await.unwrap());
    assert_eq!(rows, vec![vec![Some("1".to_string())]]);

    let c2 = engine
        .connect_as("lightdash-second", "test-second-password-not-real")
        .await
        .expect("second configured login works");
    c2.simple_query("SELECT 1").await.unwrap();

    let (code, _) = db_error(engine.connect_as(PG_USER, "wrong-password").await);
    assert_eq!(code, "28P01", "wrong password -> invalid_password");
    let (code, _) = db_error(engine.connect_as("nobody", PG_PASSWORD).await);
    assert_eq!(code, "28P01", "unknown user -> invalid_password");
    let (code, _) = db_error(engine.connect_as("lightdash-second", PG_PASSWORD).await);
    assert_eq!(code, "28P01", "passwords are per user");

    // The raw frontend (node-postgres-like startup) also logs in.
    let mut raw = RawPg::connect(engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .expect("raw login");
    let (_, rows, err) = raw.simple_query("SELECT 2 AS two").await;
    assert!(err.is_none(), "{err:?}");
    assert_eq!(rows, vec![vec![Some("2".to_string())]]);
}

/// eng-pg-simple-query
#[tokio::test]
async fn eng_pg_simple_query() {
    let engine = Engine::start(plain_cfg()).await;
    let mut raw = RawPg::connect(engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .unwrap();
    let (fields, rows, err) = raw
        .simple_query("SELECT 1 AS a, 'x' AS b, NULL AS c, 2.5 AS d")
        .await;
    assert!(err.is_none(), "{err:?}");
    let names: Vec<_> = fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["a", "b", "c", "d"]);
    assert!(
        fields.iter().all(|f| f.format == 0),
        "simple protocol rows are text format"
    );
    assert_eq!(
        rows,
        vec![vec![
            Some("1".into()),
            Some("x".into()),
            None,
            Some("2.5".into())
        ]]
    );

    // An empty query string answers EmptyQueryResponse then ReadyForQuery.
    raw.simple_query_send("").await;
    let msgs = raw.drain_until_ready().await;
    assert!(
        msgs.iter().any(|m| matches!(m, Msg::EmptyQuery)),
        "expected EmptyQueryResponse, got {msgs:?}"
    );

    // An error ends the query with ErrorResponse, and the session stays usable.
    let (_, _, err) = raw
        .simple_query("SELECT * FROM no_such_table_anywhere")
        .await;
    let err = err.expect("unknown table is an error");
    assert!(err.sqlstate().is_some(), "errors carry a SQLSTATE: {err:?}");
    let (_, rows, err) = raw.simple_query("SELECT 3").await;
    assert!(err.is_none());
    assert_eq!(rows, vec![vec![Some("3".to_string())]]);

    // tokio-postgres simple_query too.
    let c = engine.connect().await;
    let rows = simple_rows(c.simple_query("SELECT 'hello' AS greeting").await.unwrap());
    assert_eq!(rows, vec![vec![Some("hello".to_string())]]);
}

/// eng-pg-extended-query
#[tokio::test]
async fn eng_pg_extended_query() {
    let engine = Engine::start(plain_cfg()).await;
    let c = engine.connect().await;
    let stmt = c
        .prepare("SELECT $1::bigint + 1 AS n, $2::text AS t")
        .await
        .expect("prepare with parameters");
    assert_eq!(stmt.params(), &[Type::INT8, Type::TEXT]);
    let cols: Vec<_> = stmt
        .columns()
        .iter()
        .map(|c| (c.name().to_string(), c.type_().clone()))
        .collect();
    assert_eq!(
        cols,
        vec![("n".to_string(), Type::INT8), ("t".to_string(), Type::TEXT)]
    );
    for (n, t) in [(41i64, "hi"), (-2, "again")] {
        let row = c.query_one(&stmt, &[&n, &t]).await.unwrap();
        assert_eq!(row.get::<_, i64>(0), n + 1);
        assert_eq!(row.get::<_, String>(1), t);
    }
    // Unnamed statement, typed parameter inferred from context.
    let rows = c
        .query("SELECT $1::text AS echo", &[&"unnamed"])
        .await
        .unwrap();
    assert_eq!(rows[0].get::<_, String>(0), "unnamed");

    // Text-format parameters and results through Parse/Bind/Describe/Execute/Sync.
    let mut raw = RawPg::connect(engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .unwrap();
    raw.parse("s1", "SELECT $1::bigint * 2 AS doubled", &[20])
        .await;
    raw.describe_statement("s1").await;
    raw.bind("", "s1", &[Some("21")]).await;
    raw.execute("", 0).await;
    raw.sync().await;
    let msgs = raw.drain_until_ready().await;
    assert!(matches!(msgs[0], Msg::ParseComplete), "{msgs:?}");
    assert!(
        msgs.iter()
            .any(|m| matches!(m, Msg::ParameterDescription(p) if p == &vec![20])),
        "{msgs:?}"
    );
    let row = msgs
        .iter()
        .find_map(|m| match m {
            Msg::DataRow(r) => Some(crate::harness::raw_pg::text_row(r)),
            _ => None,
        })
        .expect("a data row");
    assert_eq!(row, vec![Some("42".to_string())]);
    assert!(msgs.iter().any(|m| matches!(m, Msg::CommandComplete(_))));
}

/// eng-pg-type-oids
#[tokio::test]
async fn eng_pg_type_oids() {
    let engine = Engine::start(plain_cfg()).await;
    let c = engine.connect().await;
    let sql = "SELECT CAST(7 AS BIGINT) AS i, CAST(1.5 AS DOUBLE) AS f, 'x' AS t, true AS b, \
               CAST('2026-01-02T03:04:05Z' AS TIMESTAMP WITH TIME ZONE) AS ts";
    let stmt = c.prepare(sql).await.unwrap();
    let oids: Vec<u32> = stmt.columns().iter().map(|c| c.type_().oid()).collect();
    assert_eq!(
        oids,
        vec![20, 701, 25, 16, 1184],
        "int8 float8 text bool timestamptz"
    );

    // Binary results decode as those types.
    let row = c.query_one(&stmt, &[]).await.unwrap();
    assert_eq!(row.get::<_, i64>(0), 7);
    assert_eq!(row.get::<_, f64>(1), 1.5);
    assert_eq!(row.get::<_, String>(2), "x");
    assert!(row.get::<_, bool>(3));
    let ts: std::time::SystemTime = row.get(4);
    let secs = ts.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    assert_eq!(secs, 1_767_323_045);

    // Text results use Postgres text formats.
    let mut raw = RawPg::connect(engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .unwrap();
    let (fields, rows, err) = raw.simple_query(sql).await;
    assert!(err.is_none(), "{err:?}");
    let oids: Vec<u32> = fields.iter().map(|f| f.type_oid).collect();
    assert_eq!(oids, vec![20, 701, 25, 16, 1184]);
    let r = &rows[0];
    assert_eq!(r[0].as_deref(), Some("7"));
    assert_eq!(r[1].as_deref(), Some("1.5"));
    assert!(
        matches!(r[3].as_deref(), Some("t") | Some("true")),
        "bool text: {:?}",
        r[3]
    );
    let ts = r[4].clone().unwrap();
    assert!(
        ts.starts_with("2026-01-02 03:04:05") && (ts.ends_with("+00") || ts.ends_with("+00:00")),
        "timestamptz text must be Postgres style `2026-01-02 03:04:05+00`, got {ts:?}"
    );
}

/// eng-pg-version
#[tokio::test]
async fn eng_pg_version() {
    let engine = Engine::start(plain_cfg()).await;
    let c = engine.connect().await;
    let v: String = c.query_one("SELECT version()", &[]).await.unwrap().get(0);
    let rest = v
        .strip_prefix("PostgreSQL 16.0 (hrx-federation-engine ")
        .unwrap_or_else(|| panic!("version() = {v:?}"));
    let ver = rest.strip_suffix(')').expect("closing paren");
    assert_eq!(ver, env!("CARGO_PKG_VERSION"), "crate version in version()");
    // Lightdash: /PostgreSQL (\d+)\./ must give 16.
    let major: u32 = v["PostgreSQL ".len()..]
        .split('.')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(major, 16);
    let rows = simple_rows(c.simple_query("SELECT version() AS version").await.unwrap());
    assert_eq!(rows[0][0].as_deref(), Some(v.as_str()));
}

/// eng-pg-session-settings
#[tokio::test]
async fn eng_pg_session_settings() {
    let engine = Engine::start(plain_cfg()).await;
    let c = engine.connect().await;
    assert_eq!(tz(&c).await, "UTC", "default session time zone");
    // The exact statements Lightdash's PostgresWarehouseClient sends, simple and extended.
    c.batch_execute("SET statement_timeout = 540000")
        .await
        .unwrap();
    c.execute("SET statement_timeout = 600000", &[])
        .await
        .unwrap();
    c.batch_execute("SET lightdash.agent = 'true'")
        .await
        .unwrap();
    c.batch_execute("SET timezone TO 'America/New_York'")
        .await
        .unwrap();
    assert_eq!(tz(&c).await, "America/New_York");
    c.execute("SET timezone TO 'Europe/Berlin'", &[])
        .await
        .unwrap();
    assert_eq!(tz(&c).await, "Europe/Berlin");
    let rows = simple_rows(
        c.simple_query("SELECT current_setting('TIMEZONE') AS tz")
            .await
            .unwrap(),
    );
    assert_eq!(rows[0][0].as_deref(), Some("Europe/Berlin"));
    // Unknown SETs are accepted and ignored.
    c.batch_execute("SET some.unknown_setting = 'x'")
        .await
        .unwrap();
    c.batch_execute("SET search_path TO public").await.unwrap();
    c.batch_execute("SET application_name = 'lightdash'")
        .await
        .unwrap();
    c.simple_query("SELECT 1").await.unwrap();
    // Settings are per session.
    let other = engine.connect().await;
    assert_eq!(tz(&other).await, "UTC");
}

async fn tz(c: &tokio_postgres::Client) -> String {
    c.query_one("SELECT current_setting('TIMEZONE') AS tz", &[])
        .await
        .expect("current_setting('TIMEZONE')")
        .get(0)
}

/// eng-pg-transaction-statements
#[tokio::test]
async fn eng_pg_transaction_statements() {
    let engine = Engine::start(plain_cfg()).await;
    let mut c = engine.connect().await;
    c.batch_execute("BEGIN").await.unwrap();
    c.simple_query("SELECT 1").await.unwrap();
    c.batch_execute("COMMIT").await.unwrap();
    c.batch_execute("BEGIN; ROLLBACK").await.unwrap();
    c.batch_execute("START TRANSACTION READ ONLY")
        .await
        .unwrap();
    c.batch_execute("ROLLBACK").await.unwrap();

    // tokio-postgres portals: BEGIN, Bind to a named portal, Execute with max_rows, COMMIT.
    let tx = c.transaction().await.expect("BEGIN");
    let stmt = tx
        .prepare("SELECT \"value\" FROM generate_series(1, 250) ORDER BY \"value\"")
        .await
        .unwrap();
    let portal = tx.bind(&stmt, &[]).await.expect("bind portal");
    let mut sizes = vec![];
    let mut all = vec![];
    loop {
        let rows = tx
            .query_portal(&portal, 100)
            .await
            .expect("fetch from portal");
        sizes.push(rows.len());
        all.extend(rows.iter().map(|r| r.get::<_, i64>(0)));
        if rows.len() < 100 {
            break;
        }
    }
    tx.commit().await.expect("COMMIT");
    assert_eq!(sizes, vec![100, 100, 50]);
    assert_eq!(all, (1..=250).collect::<Vec<i64>>());
}

/// eng-pg-cursor-batches
#[tokio::test]
async fn eng_pg_cursor_batches() {
    let engine = Engine::start(plain_cfg()).await;
    let mut raw = RawPg::connect(engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .unwrap();
    let (fields, batches) = raw
        .cursor_read_all(
            "C_1",
            "SELECT \"value\" AS n FROM generate_series(1, 250) ORDER BY \"value\"",
            &[],
            100,
        )
        .await
        .expect("pg-cursor read");
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0].name, "n");
    assert_eq!(fields[0].type_oid, 20);
    let sizes: Vec<usize> = batches.iter().map(|b| b.len()).collect();
    assert_eq!(
        sizes,
        vec![100, 100, 50],
        "100-row batches, PortalSuspended between them"
    );
    let values: Vec<i64> = batches
        .iter()
        .flatten()
        .map(|r| r[0].as_ref().unwrap().parse().unwrap())
        .collect();
    assert_eq!(values, (1..=250).collect::<Vec<i64>>());

    // Exactly 100 rows: the second Execute returns no rows and CommandComplete.
    let (_, batches) = raw
        .cursor_read_all(
            "C_2",
            "SELECT \"value\" FROM generate_series(1, 100)",
            &[],
            100,
        )
        .await
        .unwrap();
    let total: usize = batches.iter().map(|b| b.len()).sum();
    assert_eq!(total, 100);

    // With a bind parameter, as pg-cursor sends `values`.
    let (_, batches) = raw
        .cursor_read_all(
            "C_3",
            "SELECT \"value\" FROM generate_series(1, 30) WHERE \"value\" > $1::bigint",
            &[Some("25")],
            100,
        )
        .await
        .unwrap();
    assert_eq!(batches.iter().map(|b| b.len()).sum::<usize>(), 5);

    // The session is still usable afterwards.
    let (_, rows, err) = raw.simple_query("SELECT 1").await;
    assert!(err.is_none());
    assert_eq!(rows.len(), 1);
}

/// eng-pg-information-schema
#[tokio::test]
async fn eng_pg_information_schema() {
    let engine = Engine::start(plain_cfg()).await;
    let c = engine.connect().await;
    // Lightdash getAllTables (with pg_matviews gating off).
    let rows = c
        .query(
            "SELECT table_catalog, table_schema, table_name, table_type
             FROM information_schema.tables
             WHERE table_type IN ('BASE TABLE', 'VIEW', 'FOREIGN')
                 AND table_schema NOT IN ('information_schema', 'pg_catalog')
             ORDER BY 1, 2, 3",
            &[],
        )
        .await
        .expect("Lightdash getAllTables query");
    for r in &rows {
        let _: String = r.get(2);
    }
    let names: Vec<String> = c
        .query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'information_schema'",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert!(
        names.contains(&"tables".to_string()) && names.contains(&"columns".to_string()),
        "{names:?}"
    );
    // Lightdash getFields: information_schema.columns with positional parameters.
    let stmt = c
        .prepare(
            "SELECT table_catalog, table_schema, table_name, column_name, data_type
             FROM information_schema.columns
             WHERE table_name = $1
             AND table_schema = $2",
        )
        .await
        .expect("prepare getFields query");
    assert!(stmt.columns().iter().all(|c| c.type_() == &Type::TEXT));
    let _ = c
        .query(&stmt, &[&"no_such_table", &"public"])
        .await
        .expect("run getFields query");
}

/// eng-pg-statement-timeout
#[tokio::test]
async fn eng_pg_statement_timeout() {
    let (engine, mock) = slow_prom_engine(Duration::from_secs(20)).await;
    let c = engine.connect().await;
    c.batch_execute("SET statement_timeout = 500")
        .await
        .unwrap();
    let t = Instant::now();
    let r = c.query(SLOW_PROMQL, &[]).await;
    assert_sqlstate(r, "57014", "");
    assert!(
        t.elapsed() < Duration::from_secs(3),
        "timed out after {:?}",
        t.elapsed()
    );
    assert!(
        mock.wait_cancelled(1, Duration::from_secs(3)).await,
        "the in-flight request to the source must be abandoned"
    );
    // The session survives, and statement_timeout = 0 disables the limit.
    c.simple_query("SELECT 1").await.unwrap();
    c.batch_execute("SET statement_timeout = 0").await.unwrap();
    let (engine2, _mock2) = slow_prom_engine(Duration::from_millis(1200)).await;
    let c2 = engine2.connect().await;
    c2.batch_execute("SET statement_timeout = 0").await.unwrap();
    let rows = c2.query(SLOW_PROMQL, &[]).await.expect("no timeout");
    assert_eq!(rows.len(), 1);
}

/// eng-pg-cancel-request
#[tokio::test]
async fn eng_pg_cancel_request() {
    let (engine, mock) = slow_prom_engine(Duration::from_secs(20)).await;
    let c = engine.connect().await;
    let token = c.cancel_token();
    let q = tokio::spawn(async move {
        let r = c.query(SLOW_PROMQL, &[]).await;
        (r.map(|v| v.len()), c)
    });
    assert!(
        mock.wait_requests(1, Duration::from_secs(10)).await,
        "query reached the source"
    );
    let t = Instant::now();
    token
        .cancel_query(tokio_postgres::NoTls)
        .await
        .expect("send CancelRequest");
    let (r, c) = q.await.unwrap();
    assert_sqlstate(r, "57014", "");
    assert!(t.elapsed() < Duration::from_secs(3));
    assert!(
        mock.wait_cancelled(1, Duration::from_secs(3)).await,
        "source request abandoned"
    );
    c.simple_query("SELECT 1")
        .await
        .expect("session usable after cancel");

    // A cancel with a wrong secret key does nothing.
    let mut raw = RawPg::connect(engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .unwrap();
    raw.simple_query_send(SLOW_PROMQL.replace("'up'", "'up_two'").as_str())
        .await;
    assert!(mock.wait_requests(2, Duration::from_secs(10)).await);
    send_cancel(
        engine.pg_port,
        raw.backend_pid,
        raw.backend_secret.wrapping_add(1),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(mock.cancelled(), 1, "wrong secret must not cancel");
    send_cancel(engine.pg_port, raw.backend_pid, raw.backend_secret).await;
    let msgs = raw.drain_until_ready().await;
    assert!(
        msgs.iter().any(|m| m.sqlstate() == Some("57014")),
        "raw cancel -> 57014, got {msgs:?}"
    );
}

/// eng-pg-disconnect-cleanup
#[tokio::test]
async fn eng_pg_disconnect_cleanup() {
    let (engine, mock) = slow_prom_engine(Duration::from_secs(30)).await;
    let mut raw = RawPg::connect(engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .unwrap();
    raw.simple_query_send(SLOW_PROMQL).await;
    assert!(mock.wait_requests(1, Duration::from_secs(10)).await);
    raw.hard_close();
    assert!(
        mock.wait_cancelled(1, Duration::from_secs(3)).await,
        "client disconnect must stop the in-flight source request"
    );
    // Same through the extended protocol mid-portal.
    let mut raw = RawPg::connect(engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .unwrap();
    raw.parse("", SLOW_PROMQL, &[]).await;
    raw.bind("C_1", "", &[]).await;
    raw.describe_portal("C_1").await;
    raw.execute("C_1", 100).await;
    raw.flush().await;
    assert!(mock.wait_requests(2, Duration::from_secs(10)).await);
    raw.hard_close();
    assert!(mock.wait_cancelled(2, Duration::from_secs(3)).await);
    // The engine keeps serving.
    let c = engine.connect().await;
    c.simple_query("SELECT 1").await.unwrap();
}

/// eng-pg-tls
#[tokio::test]
async fn eng_pg_tls() {
    let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into(), "localhost".into()])
        .expect("self-signed cert");
    let dir = unique_dir("tls");
    let cert_path = dir.join("server.crt");
    let key_path = dir.join("server.key");
    std::fs::write(&cert_path, cert.cert.pem()).unwrap();
    std::fs::write(&key_path, cert.signing_key.serialize_pem()).unwrap();

    let engine = Engine::start(
        plain_cfg()
            .top(&format!("tls_cert_file = \"{}\"", cert_path.display()))
            .top(&format!("tls_key_file = \"{}\"", key_path.display())),
    )
    .await;
    assert_eq!(ssl_request_answer(engine.pg_port).await, b'S');

    let mut roots = rustls::RootCertStore::empty();
    roots.add(cert.cert.der().clone()).unwrap();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = tokio_postgres_rustls::MakeRustlsConnect::new(tls);
    let mut cfg = engine.pg_config(PG_USER, PG_PASSWORD);
    cfg.ssl_mode(tokio_postgres::config::SslMode::Require);
    let (client, conn) = cfg.connect(connector).await.expect("TLS login");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let rows = simple_rows(client.simple_query("SELECT 'over tls' AS t").await.unwrap());
    assert_eq!(rows[0][0].as_deref(), Some("over tls"));

    // Without a certificate the engine declines SSL and plain connections work.
    let plain = Engine::start(plain_cfg()).await;
    assert_eq!(ssl_request_answer(plain.pg_port).await, b'N');
    plain
        .connect()
        .await
        .simple_query("SELECT 1")
        .await
        .unwrap();
}
