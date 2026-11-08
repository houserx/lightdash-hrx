//! Self-tests of the harness itself (not feature checks). They run against a real throwaway
//! Postgres and the mocks, never the engine, so they pass on any tree. If one fails, the machine
//! (not the engine) is broken: e.g. `/opt/homebrew/bin/initdb` is missing.

use std::time::Duration;

use serde_json::{Value, json};

use crate::harness::aws::{self, AuditStore};
use crate::harness::raw_pg::{Msg, RawPg};
use crate::harness::tokens::*;
use crate::harness::*;

/// The raw frontend speaks real pg-wire: SCRAM login, pg-cursor batches, errors, cancel.
#[tokio::test]
async fn harness_selftest_raw_pg_against_postgres() {
    let pg = PgCluster::start_platform().await;
    let mut raw = RawPg::connect(
        pg.port,
        "postgres",
        crate::harness::pg_cluster::SUPERUSER_PASSWORD,
        "postgres",
    )
    .await
    .expect("SCRAM login");
    let (fields, batches) = raw
        .cursor_read_all(
            "C_1",
            "SELECT g AS value FROM generate_series(1, 250) AS g",
            &[],
            100,
        )
        .await
        .unwrap();
    assert_eq!(fields[0].type_oid, 23);
    assert_eq!(
        batches.iter().map(|b| b.len()).collect::<Vec<_>>(),
        vec![100, 100, 50]
    );
    let (_, batches) = raw
        .cursor_read_all(
            "C_2",
            "SELECT g FROM generate_series(1, 30) AS g WHERE g > $1::int",
            &[Some("25")],
            100,
        )
        .await
        .unwrap();
    assert_eq!(batches.iter().map(|b| b.len()).sum::<usize>(), 5);
    let (_, _, err) = raw.simple_query("SELECT * FROM no_such_table").await;
    assert_eq!(err.unwrap().sqlstate(), Some("42P01"));
    raw.simple_query_send("").await;
    assert!(
        raw.drain_until_ready()
            .await
            .iter()
            .any(|m| matches!(m, Msg::EmptyQuery))
    );
    raw.simple_query_send("SELECT pg_sleep(30)").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    crate::harness::raw_pg::send_cancel(pg.port, raw.backend_pid, raw.backend_secret).await;
    let msgs = raw.drain_until_ready().await;
    assert!(
        msgs.iter().any(|m| m.sqlstate() == Some("57014")),
        "{msgs:?}"
    );
    // Seeded Platform Database and roles.
    assert_eq!(pg.count("widgets").await, 200);
    let (c, conn) = tokio_postgres::connect(&pg.read_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(conn);
    let u: String = c
        .query_one("SELECT current_user::text", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(u, "engine_read");
    assert!(
        c.execute("DELETE FROM widgets", &[]).await.is_err(),
        "read role cannot write"
    );
    assert_eq!(
        raw.params.get("server_version").map(|v| !v.is_empty()),
        Some(true)
    );
}

/// The mock server records requests and notices a client hanging up during a delayed reply.
#[tokio::test]
async fn harness_selftest_mock_http() {
    let m = MockServer::start(|r| {
        if r.path == "/slow" {
            Reply::text(200, "late").delayed(Duration::from_secs(30))
        } else {
            Reply::json(&json!({"echo": r.param_or_form("q")}))
        }
    })
    .await;
    let client = reqwest::Client::new();
    let v: Value = client
        .get(format!("{}/x?q=a%20b", m.url()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["echo"], "a b");
    let v: Value = client
        .post(format!("{}/x", m.url()))
        .form(&[("q", "c=d")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["echo"], "c=d");
    let slow = tokio::spawn({
        let c = client.clone();
        let u = format!("{}/slow", m.url());
        async move { c.get(u).send().await }
    });
    assert!(m.wait_requests(3, Duration::from_secs(5)).await);
    slow.abort();
    assert!(
        m.wait_cancelled(1, Duration::from_secs(3)).await,
        "dropping the request is seen as a cancel"
    );
}

/// The portal hash fixture, the DynamoDB query emulation, and token minting.
#[tokio::test]
async fn harness_selftest_fixtures_and_tokens() {
    let fixtures: Value =
        serde_json::from_str(include_str!("fixtures/integrity_hash.json")).unwrap();
    for f in fixtures.as_array().unwrap() {
        let mut rec = f["input"].clone();
        rec["createdAt"] = f["createdAt"].clone();
        assert_eq!(
            json!(portal_integrity_hash(&rec, Some(AUDIT_KEY))),
            f["hmac"]
        );
    }
    let rec = json!({"id": "i", "sql": "S", "mode": "read", "description": "d", "database": "db",
        "executedByEmail": "e", "executedBySub": "s", "status": "success", "rowCount": 1, "durationMs": 2,
        "errorMessage": null, "preview": false, "action": "query", "integrityHash": "h",
        "createdAt": "2026-01-01T00:00:00.000Z", "createdAtMonth": "2026-01"});
    assert!(
        js_pretty_flat(&rec, &EXECUTION_KEY_ORDER)
            .starts_with("{\n  \"id\": \"i\",\n  \"sql\": \"S\",")
    );
    let store = AuditStore::start().await;
    for i in 0..3 {
        store.seed(json!({"id": format!("{i}"), "createdAt": format!("2026-10-0{}T00:00:00.000Z", i + 1), "createdAtMonth": "2026-10"}));
    }
    let out = aws::run_query(
        &store.items(),
        &json!({
        "IndexName": "byMonth", "KeyConditionExpression": "createdAtMonth = :m AND createdAt BETWEEN :from AND :to",
        "ExpressionAttributeValues": {":m": {"S": "2026-10"}, ":from": {"S": "2026-10-01"}, ":to": {"S": "2026-10-31"}},
        "ScanIndexForward": false, "Limit": 2}),
    );
    assert_eq!(out["Items"][0]["id"]["S"], "2");
    assert!(out.get("LastEvaluatedKey").is_some());
    let t = Identity::person().token();
    let (p, s) = t.split_once('.').unwrap();
    assert!(
        !p.contains('=') && !s.contains('='),
        "base64url without padding"
    );
}
