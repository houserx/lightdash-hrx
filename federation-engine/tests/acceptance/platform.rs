//! Platform Database (§1.1, §5, §6): platform_query, platform_tables, platform_columns,
//! platform_explain, read pool, timeouts, cancellation and max_rows. Each test runs its own
//! throwaway Postgres cluster.

use std::collections::HashSet;
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;
use tokio_postgres::types::Type;

use crate::harness::aws::AuditStore;
use crate::harness::raw_pg::RawPg;
use crate::harness::*;
use crate::promql::secs;

pub struct Platform {
    pub engine: Engine,
    pub cluster: PgCluster,
    pub audit: AuditStore,
}

/// A Platform Database cluster, the audit store, and an engine with the `platform` source.
pub async fn platform_setup(cfg: Cfg, with_write: bool) -> Platform {
    let cluster = PgCluster::start_platform().await;
    let audit = AuditStore::start().await;
    let engine = Engine::start(cfg.platform(&cluster, with_write).audit(&audit)).await;
    Platform {
        engine,
        cluster,
        audit,
    }
}

pub fn reader() -> Identity {
    Identity::person()
        .attr("platform_read", true)
        .description("support lookup for a synthetic ticket")
}

pub fn pq(sql: &str) -> String {
    format!("SELECT * FROM platform_query({})", sql_lit(sql))
}

/// eng-platform-query-basic
#[tokio::test]
async fn eng_platform_query_basic() {
    let p = platform_setup(Cfg::new(), false).await;
    let c = p.engine.connect().await;
    set_identity(&c, &reader().token()).await;
    let stmt = c
        .prepare(&pq("SELECT id, name, active, created_at, score, note FROM widgets WHERE id <= 3 ORDER BY id"))
        .await
        .unwrap();
    let cols: Vec<(String, Type)> = stmt
        .columns()
        .iter()
        .map(|c| (c.name().to_string(), c.type_().clone()))
        .collect();
    assert_eq!(
        cols,
        vec![
            ("id".into(), Type::INT8),
            ("name".into(), Type::TEXT),
            ("active".into(), Type::BOOL),
            ("created_at".into(), Type::TIMESTAMPTZ),
            ("score".into(), Type::FLOAT8),
            ("note".into(), Type::TEXT)
        ]
    );
    let rows = c.query(&stmt, &[]).await.unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1].get::<_, i64>(0), 2);
    assert_eq!(rows[1].get::<_, String>(1), "widget-2");
    assert!(rows[1].get::<_, bool>(2));
    assert_eq!(
        secs(rows[1].get::<_, SystemTime>(3)),
        1_767_225_600.0 + 7200.0
    );
    assert_eq!(rows[1].get::<_, f64>(4), 3.0);
    assert_eq!(rows[1].get::<_, Option<String>>(5), None);
    // Simple protocol too.
    let rows = simple_rows(
        c.simple_query(&pq("SELECT count(*) AS n FROM patients"))
            .await
            .unwrap(),
    );
    assert_eq!(rows, vec![vec![Some("2".to_string())]]);
}

/// eng-platform-query-enforcement
#[tokio::test]
async fn eng_platform_query_enforcement() {
    let p = platform_setup(Cfg::new(), false).await;
    let c = p.engine.connect().await;
    let sql = pq("SELECT id FROM widgets WHERE id = 1");
    assert_sqlstate(c.query(&sql, &[]).await, "42501", "platform_read");
    set_identity(
        &c,
        &Identity::person()
            .attr("telemetry_restricted", true)
            .description("x")
            .token(),
    )
    .await;
    assert_sqlstate(c.query(&sql, &[]).await, "42501", "platform_read");
    set_identity(
        &c,
        &Identity::person()
            .attr("platform_explain", true)
            .description("x")
            .token(),
    )
    .await;
    assert_sqlstate(c.query(&sql, &[]).await, "42501", "platform_read");
    set_identity(&c, &Identity::person().attr("platform_read", true).token()).await;
    assert_sqlstate(
        c.query(&sql, &[]).await,
        "42501",
        "audited query requires a description",
    );
    set_identity(&c, &reader().times(-400, -100).token()).await;
    assert_sqlstate(c.query(&sql, &[]).await, "42501", "platform_read");
    assert!(
        p.audit.items().is_empty(),
        "refused queries are not executed"
    );
    set_identity(&c, &reader().token()).await;
    assert_eq!(c.query(&sql, &[]).await.unwrap().len(), 1);
    // An agent with platform_read may query (MCP platform_query), audited as ai_ask.
    set_identity(
        &c,
        &Identity::mcp_agent()
            .attr("platform_read", true)
            .description("agent asks")
            .token(),
    )
    .await;
    assert_eq!(c.query(&sql, &[]).await.unwrap().len(), 1);
}

/// eng-platform-query-describe-only
#[tokio::test]
async fn eng_platform_query_describe_only() {
    let p = platform_setup(Cfg::new(), false).await;
    let c = p.engine.connect().await;
    set_identity(&c, &reader().token()).await;
    // Planning must describe, never execute: nextval() advances exactly once per run.
    let n: i64 = c
        .query_one(&pq("SELECT nextval('probe_seq') AS n"), &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(n, 1, "planning executed the statement");
    let n: i64 = c
        .query_one(&pq("SELECT nextval('probe_seq') AS n"), &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(n, 2);
    let rows = simple_rows(
        c.simple_query(&pq("SELECT nextval('probe_seq') AS n"))
            .await
            .unwrap(),
    );
    assert_eq!(rows[0][0].as_deref(), Some("3"));
    // A zero-row result still has its columns.
    let stmt = c
        .prepare(&pq("SELECT id, name FROM widgets WHERE false"))
        .await
        .unwrap();
    assert_eq!(
        stmt.columns().iter().map(|c| c.name()).collect::<Vec<_>>(),
        ["id", "name"]
    );
    assert!(c.query(&stmt, &[]).await.unwrap().is_empty());
    // A statement Postgres cannot describe fails at plan time.
    assert!(
        c.query(&pq("SELECT no_such_column FROM widgets"), &[])
            .await
            .is_err()
    );
}

/// eng-platform-read-only-role
#[tokio::test]
async fn eng_platform_read_only_role() {
    let p = platform_setup(Cfg::new(), true).await;
    let c = p.engine.connect().await;
    set_identity(&c, &reader().token()).await;
    let u: String = c
        .query_one(&pq("SELECT current_user AS u"), &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        u,
        crate::harness::pg_cluster::READ_ROLE,
        "platform_query uses the read pool even when Write Mode is on"
    );
    // The guard refuses writes before they reach Postgres.
    let before = p.cluster.count("widgets").await;
    assert_sqlstate(
        c.query(&pq("DELETE FROM widgets"), &[]).await,
        "42501",
        "requires write mode",
    );
    assert_sqlstate(
        c.query(
            &pq("WITH d AS (DELETE FROM widgets RETURNING *) SELECT * FROM d"),
            &[],
        )
        .await,
        "42501",
        "requires write mode",
    );
    assert_eq!(p.cluster.count("widgets").await, before);
}

/// eng-platform-sql-over-results
#[tokio::test]
async fn eng_platform_sql_over_results() {
    let p = platform_setup(Cfg::new(), false).await;
    let c = p.engine.connect().await;
    set_identity(&c, &reader().token()).await;
    let rows = c
        .query(
            &format!(
                "SELECT w.name, v.label FROM ({}) w JOIN (VALUES (2, 'two'), (4, 'four')) AS v(id, label) ON w.id = v.id ORDER BY w.id",
                pq("SELECT id, name FROM widgets WHERE id <= 5")
            ),
            &[],
        )
        .await
        .unwrap();
    let got: Vec<(String, String)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    assert_eq!(
        got,
        vec![
            ("widget-2".into(), "two".into()),
            ("widget-4".into(), "four".into())
        ]
    );
    let rows = c
        .query(
            &format!("SELECT active, count(*) AS n, max(score) AS top FROM ({}) t GROUP BY active ORDER BY active", pq("SELECT id, active, score FROM widgets")),
            &[],
        )
        .await
        .unwrap();
    let got: Vec<(bool, i64, f64)> = rows
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(got, vec![(false, 100, 298.5), (true, 100, 300.0)]);
    let n: i64 = c
        .query_one(
            &format!(
                "SELECT count(*) FROM ({}) t WHERE id > 190",
                pq("SELECT id FROM widgets")
            ),
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(n, 10);
}

/// eng-platform-tables-columns
#[tokio::test]
async fn eng_platform_tables_columns() {
    let p = platform_setup(Cfg::new(), false).await;
    let c = p.engine.connect().await;
    assert_sqlstate(
        c.query("SELECT * FROM platform_tables()", &[]).await,
        "42501",
        "platform_read",
    );
    assert_sqlstate(
        c.query("SELECT * FROM platform_columns('public', 'widgets')", &[])
            .await,
        "42501",
        "platform_read",
    );
    set_identity(&c, &reader().token()).await;
    let stmt = c.prepare("SELECT * FROM platform_tables()").await.unwrap();
    assert_eq!(
        stmt.columns()
            .iter()
            .map(|c| (c.name(), c.type_().oid()))
            .collect::<Vec<_>>(),
        [("table_schema", 25), ("table_name", 25)]
    );
    let tables: HashSet<(String, String)> = c
        .query(&stmt, &[])
        .await
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    for t in ["widgets", "patients", "t"] {
        assert!(
            tables.contains(&("public".into(), t.into())),
            "{t} listed: {tables:?}"
        );
    }
    assert!(
        !tables
            .iter()
            .any(|(s, _)| s == "pg_catalog" || s == "information_schema")
    );
    let stmt = c
        .prepare("SELECT * FROM platform_columns('public', 'widgets')")
        .await
        .unwrap();
    assert_eq!(
        stmt.columns()
            .iter()
            .map(|c| (c.name(), c.type_().oid()))
            .collect::<Vec<_>>(),
        [("column_name", 25), ("data_type", 25), ("is_nullable", 16)]
    );
    let cols: Vec<(String, String, bool)> = c
        .query(&stmt, &[])
        .await
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        cols,
        vec![
            ("id".into(), "bigint".into(), false),
            ("name".into(), "text".into(), false),
            ("active".into(), "boolean".into(), false),
            (
                "created_at".into(),
                "timestamp with time zone".into(),
                false
            ),
            ("score".into(), "double precision".into(), true),
            ("note".into(), "text".into(), true),
        ],
        "in ordinal order"
    );
    assert!(
        c.query("SELECT * FROM platform_columns('public', 'nope')", &[])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(p.audit.items().len(), 3, "each call is an Audited Query");
}

/// eng-platform-explain
#[tokio::test]
async fn eng_platform_explain() {
    let p = platform_setup(Cfg::new(), false).await;
    let c = p.engine.connect().await;
    let sql = "SELECT * FROM platform_explain('SELECT * FROM widgets WHERE id = 1')";
    let (code, msg) = db_error(c.query(sql, &[]).await);
    assert_eq!(code, "42501");
    assert!(
        msg.contains("platform_explain") || msg.contains("platform_read"),
        "{msg}"
    );
    for id in [
        Identity::person()
            .attr("platform_explain", true)
            .description("plan check"),
        reader(),
    ] {
        set_identity(&c, &id.token()).await;
        let stmt = c.prepare(sql).await.unwrap();
        assert_eq!(stmt.columns().len(), 1);
        assert_eq!(stmt.columns()[0].name(), "plan");
        assert_eq!(stmt.columns()[0].type_().oid(), 114);
        let rows = c.query(&stmt, &[]).await.unwrap();
        assert_eq!(rows.len(), 1);
        let plan: Value = rows[0].get(0);
        let node = &plan[0]["Plan"];
        assert!(
            node["Node Type"].is_string(),
            "EXPLAIN (FORMAT JSON) output: {plan}"
        );
        assert!(node.get("Total Cost").is_some());
        assert!(
            node.get("Actual Rows").is_none(),
            "estimate-only, never ANALYZE"
        );
    }
    // Explaining never runs the statement.
    c.query(
        "SELECT * FROM platform_explain('SELECT nextval(''probe_seq'')')",
        &[],
    )
    .await
    .unwrap();
    let called: bool = p
        .cluster
        .superuser()
        .await
        .query_one("SELECT is_called FROM probe_seq", &[])
        .await
        .unwrap()
        .get(0);
    assert!(!called, "EXPLAIN must not execute nextval()");
    // The read-mode guard applies.
    assert_sqlstate(
        c.query("SELECT * FROM platform_explain('DELETE FROM widgets')", &[])
            .await,
        "42501",
        "requires write mode",
    );
    assert_sqlstate(
        c.query(
            "SELECT * FROM platform_explain('SELECT 1; DROP TABLE widgets')",
            &[],
        )
        .await,
        "42501",
        "single SQL statement",
    );
}

/// eng-platform-statement-timeout
#[tokio::test]
async fn eng_platform_statement_timeout() {
    let p = platform_setup(Cfg::new(), false).await;
    let c = p.engine.connect().await;
    set_identity(&c, &reader().token()).await;
    c.batch_execute("SET statement_timeout = 500")
        .await
        .unwrap();
    let t = Instant::now();
    assert_sqlstate(
        c.query(&pq("SELECT pg_sleep(30) AS s"), &[]).await,
        "57014",
        "",
    );
    assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(
        p.cluster.active_queries_containing("pg_sleep(30)").await,
        0,
        "the Postgres backend stopped too"
    );
    c.batch_execute("SET statement_timeout = 0").await.unwrap();
    assert_eq!(c.query(&pq("SELECT 1 AS x"), &[]).await.unwrap().len(), 1);
}

/// eng-platform-cancel-on-disconnect
#[tokio::test]
async fn eng_platform_cancel_on_disconnect() {
    let p = platform_setup(Cfg::new(), false).await;
    let mut raw = RawPg::connect(p.engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .unwrap();
    let _ = raw
        .simple_query(&format!(
            "SET hrx.identity = {}",
            sql_lit(&reader().token())
        ))
        .await;
    raw.simple_query_send(&pq("SELECT pg_sleep(60) AS s")).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while p.cluster.active_queries_containing("pg_sleep(60)").await == 0 {
        assert!(Instant::now() < deadline, "query never started in Postgres");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    raw.hard_close();
    let deadline = Instant::now() + Duration::from_secs(5);
    while p.cluster.active_queries_containing("pg_sleep(60)").await > 0 {
        assert!(
            Instant::now() < deadline,
            "disconnecting must cancel the Postgres query"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // Cancel request on the pg-wire side also reaches Postgres.
    let c = p.engine.connect().await;
    set_identity(&c, &reader().token()).await;
    let token = c.cancel_token();
    let q = tokio::spawn(async move {
        c.query(&pq("SELECT pg_sleep(60) AS s"), &[])
            .await
            .map(|r| r.len())
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while p.cluster.active_queries_containing("pg_sleep(60)").await == 0 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    token.cancel_query(tokio_postgres::NoTls).await.unwrap();
    assert_sqlstate(q.await.unwrap(), "57014", "");
    let deadline = Instant::now() + Duration::from_secs(5);
    while p.cluster.active_queries_containing("pg_sleep(60)").await > 0 {
        assert!(
            Instant::now() < deadline,
            "cancel must stop the Postgres query"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// eng-platform-max-rows
#[tokio::test]
async fn eng_platform_max_rows() {
    let cluster = PgCluster::start_platform().await;
    let audit = AuditStore::start().await;
    let engine = Engine::start(
        Cfg::new()
            .top("max_rows = 1000")
            .platform(&cluster, false)
            .table("max_rows = 50\n")
            .audit(&audit),
    )
    .await;
    let c = engine.connect().await;
    set_identity(&c, &reader().token()).await;
    assert_sqlstate(
        c.query(&pq("SELECT g FROM generate_series(1, 51) AS g"), &[])
            .await,
        "54000",
        "result exceeds max_rows",
    );
    assert_eq!(
        c.query(&pq("SELECT g FROM generate_series(1, 50) AS g"), &[])
            .await
            .unwrap()
            .len(),
        50
    );
}

/// eng-platform-pools
#[tokio::test]
async fn eng_platform_pools() {
    let p = platform_setup(Cfg::new(), false).await;
    let mut tasks = vec![];
    for i in 0..20 {
        let c = p.engine.connect().await;
        tasks.push(tokio::spawn(async move {
            set_identity(&c, &reader().token()).await;
            let rows = c
                .query(
                    &pq("SELECT pg_backend_pid() AS pid, pg_sleep(0.2)::text AS s"),
                    &[],
                )
                .await
                .unwrap_or_else(|e| panic!("concurrent query {i}: {e}"));
            rows[0].get::<_, i32>(0)
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    let c = p.engine.connect().await;
    set_identity(&c, &reader().token()).await;
    for _ in 0..40 {
        c.query(&pq("SELECT 1 AS one"), &[]).await.unwrap();
    }
    let conns: i64 = p
        .cluster
        .superuser()
        .await
        .query_one(
            "SELECT count(*) FROM pg_stat_activity WHERE usename = 'engine_read'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(
        (1..=25).contains(&conns),
        "connections are pooled, not opened per query: {conns}"
    );
}
