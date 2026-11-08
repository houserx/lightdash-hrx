//! Audit records (§6): the DynamoDB `executions` item and the S3 Object Lock object, byte-compatible
//! with db-query-portal; fail-closed (58000); and `GET /v1/audit` over the portal's GSIs.

use std::collections::HashSet;

use base64::Engine as _;
use serde_json::{Value, json};

use crate::harness::aws::AuditStore;
use crate::harness::raw_pg::RawPg;
use crate::harness::telemetry::*;
use crate::harness::tokens::*;
use crate::harness::*;
use crate::identity::{RESTRICTED_SQL, restricted_reader, restricted_setup};
use crate::platform::{platform_setup, pq, reader};

const ITEM_KEYS_WITH_TICKET: [&str; 17] = [
    "id",
    "sql",
    "mode",
    "description",
    "database",
    "linearTicketId",
    "executedByEmail",
    "executedBySub",
    "status",
    "rowCount",
    "durationMs",
    "errorMessage",
    "preview",
    "action",
    "integrityHash",
    "createdAt",
    "createdAtMonth",
];

fn is_iso_ms_utc(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 24
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'.'
        && b[23] == b'Z'
        && chrono::DateTime::parse_from_rfc3339(s).is_ok()
}

/// eng-audit-dynamodb-item
#[tokio::test]
async fn eng_audit_dynamodb_item() {
    let s = restricted_setup(Cfg::new()).await;
    let c = s.engine.connect().await;
    let id = restricted_reader().ticket("ENG-1799");
    set_identity(&c, &id.token()).await;
    // Extended protocol: Parse/Describe/Bind/Execute is still one Audited Query.
    let rows = c
        .query(RESTRICTED_SQL, &[])
        .await
        .expect("an authorised restricted read");
    assert_eq!(rows.len(), 2);
    let puts = s.audit.put_inputs();
    assert_eq!(puts.len(), 1, "exactly one audit item per query");
    assert_eq!(puts[0]["TableName"], crate::harness::aws::AUDIT_TABLE);
    assert_eq!(
        puts[0]["ConditionExpression"], "attribute_not_exists(id)",
        "append-only put"
    );
    let item = &s.audit.items()[0];
    let keys: HashSet<&str> = item
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.as_str())
        .collect();
    assert_eq!(
        keys,
        ITEM_KEYS_WITH_TICKET.into_iter().collect::<HashSet<_>>(),
        "exactly the portal's Execution fields"
    );
    assert!(uuid::Uuid::parse_str(item["id"].as_str().unwrap()).is_ok());
    assert_eq!(item["sql"], RESTRICTED_SQL, "the SQL statement as received");
    assert_eq!(item["mode"], "read");
    assert_eq!(item["description"], "investigating elevated error rate");
    assert_eq!(item["database"], "prom-restricted", "the source name");
    assert_eq!(item["linearTicketId"], "ENG-1799");
    assert_eq!(item["executedByEmail"], id.email());
    assert_eq!(item["executedBySub"], id.sub());
    assert_eq!(item["status"], "success");
    assert_eq!(item["rowCount"], json!(2));
    assert!(
        item["durationMs"].as_i64().is_some_and(|d| d >= 0),
        "integer milliseconds"
    );
    assert_eq!(item["errorMessage"], Value::Null);
    assert_eq!(item["preview"], json!(false));
    assert_eq!(item["action"], "query");
    let created = item["createdAt"].as_str().unwrap();
    assert!(
        is_iso_ms_utc(created),
        "createdAt like new Date().toISOString(): {created}"
    );
    let age = chrono::Utc::now()
        .signed_duration_since(chrono::DateTime::parse_from_rfc3339(created).unwrap());
    assert!(age.num_seconds().abs() < 120);
    assert_eq!(item["createdAtMonth"], &created[..7]);
    assert!(
        item["integrityHash"]
            .as_str()
            .unwrap()
            .starts_with("hmac-sha256:")
    );

    // Without a ticket, linearTicketId is omitted (sparse GSI), not null.
    set_identity(&c, &restricted_reader().token()).await;
    c.query(RESTRICTED_SQL, &[]).await.unwrap();
    let item = &s.audit.items()[1];
    assert!(item.get("linearTicketId").is_none(), "{item}");
    // Ordinary telemetry is not audited per query.
    c.query(crate::identity::OPEN_SQL, &[]).await.unwrap();
    assert_eq!(s.audit.items().len(), 2);
}

/// eng-audit-s3-object
#[tokio::test]
async fn eng_audit_s3_object() {
    let s = restricted_setup(Cfg::new()).await;
    let c = s.engine.connect().await;
    set_identity(
        &c,
        &restricted_reader()
            .ticket("ENG-7")
            .description("Line1\nLine2 \"quoted\" ünïcødé ✓")
            .token(),
    )
    .await;
    c.query(RESTRICTED_SQL, &[]).await.unwrap();
    let item = s.audit.items()[0].clone();
    let puts = s.audit.s3_puts();
    assert_eq!(puts.len(), 1, "one Object Lock object per record");
    let put = &puts[0];
    assert_eq!(put.bucket, crate::harness::aws::AUDIT_BUCKET);
    assert_eq!(
        put.key,
        format!(
            "executions/{}/{}.json",
            item["createdAt"].as_str().unwrap(),
            item["id"].as_str().unwrap()
        )
    );
    let expected = js_pretty_flat(&item, &EXECUTION_KEY_ORDER);
    assert_eq!(
        String::from_utf8_lossy(&put.body),
        expected,
        "JSON.stringify(record, null, 2) of the DynamoDB item"
    );
    assert!(
        put.header("content-type")
            .unwrap_or_default()
            .starts_with("application/json")
    );
    assert_eq!(put.header("x-amz-object-lock-mode"), Some("COMPLIANCE"));
    let until = chrono::DateTime::parse_from_rfc3339(
        put.header("x-amz-object-lock-retain-until-date")
            .expect("retain-until"),
    )
    .unwrap();
    let days = until.signed_duration_since(chrono::Utc::now()).num_hours() as f64 / 24.0;
    assert!(
        (days - 2555.0).abs() < 2.0,
        "default retention 2555 days, got {days}"
    );

    // Retention is configurable.
    let audit = AuditStore::start().await;
    let mock = prometheus_mock(prom_matrix(&[]), prom_vector(&[])).await;
    let engine = Engine::start(
        Cfg::new()
            .prometheus("prom-restricted", &mock.url(), "restricted = true")
            .audit(&audit)
            .table("s3_retention_days = 30\n"),
    )
    .await;
    let c = engine.connect().await;
    set_identity(&c, &restricted_reader().token()).await;
    c.query(RESTRICTED_SQL, &[]).await.unwrap();
    let put = &audit.s3_puts()[0];
    let until = chrono::DateTime::parse_from_rfc3339(
        put.header("x-amz-object-lock-retain-until-date").unwrap(),
    )
    .unwrap();
    let days = until.signed_duration_since(chrono::Utc::now()).num_hours() as f64 / 24.0;
    assert!((days - 30.0).abs() < 2.0, "{days}");
}

/// eng-audit-integrity-hash
#[tokio::test]
async fn eng_audit_integrity_hash() {
    // The harness reproduces the portal's computeIntegrityHash, checked against values computed
    // by the portal's own Node code (fixtures/integrity_hash.json).
    let fixtures: Value =
        serde_json::from_str(include_str!("fixtures/integrity_hash.json")).unwrap();
    for f in fixtures.as_array().unwrap() {
        let mut rec = f["input"].clone();
        rec["createdAt"] = f["createdAt"].clone();
        assert_eq!(
            json!(portal_integrity_hash(&rec, Some(AUDIT_KEY))),
            f["hmac"]
        );
        assert_eq!(json!(portal_integrity_hash(&rec, None)), f["sha256"]);
    }
    // The engine's hash matches for a record with escapes, unicode and a ticket.
    let s = restricted_setup(Cfg::new()).await;
    let c = s.engine.connect().await;
    let sql = format!("/* ünïcødé ✓ \"q\" \\ */ {RESTRICTED_SQL}");
    set_identity(
        &c,
        &restricted_reader()
            .ticket("ENG-123")
            .description("Line1\nLine2\ttab <tag> & ünïcødé 🚀 \u{1}")
            .token(),
    )
    .await;
    c.query(&sql, &[]).await.unwrap();
    let item = &s.audit.items()[0];
    assert_eq!(item["sql"], sql);
    assert_eq!(
        item["integrityHash"],
        json!(portal_integrity_hash(item, Some(AUDIT_KEY)))
    );
    // Without integrity_key_env the portal falls back to a plain SHA-256.
    let audit = AuditStore::start().await;
    let mock = prometheus_mock(prom_matrix(&[]), prom_vector(&[])).await;
    let engine = Engine::start(
        Cfg::new()
            .prometheus("prom-restricted", &mock.url(), "restricted = true")
            .table(&format!(
                "[audit]\ndynamodb_table = \"{}\"\ns3_bucket = \"{}\"\nregion = \"us-east-2\"\ndynamodb_endpoint_url = \"{}\"\ns3_endpoint_url = \"{}\"\n",
                crate::harness::aws::AUDIT_TABLE, crate::harness::aws::AUDIT_BUCKET, audit.url(), audit.url()
            )),
    )
    .await;
    let c = engine.connect().await;
    set_identity(&c, &restricted_reader().token()).await;
    c.query(RESTRICTED_SQL, &[]).await.unwrap();
    let item = &audit.items()[0];
    assert!(
        item["integrityHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(
        item["integrityHash"],
        json!(portal_integrity_hash(item, None))
    );
}

/// eng-audit-fail-closed
#[tokio::test]
async fn eng_audit_fail_closed() {
    let s = restricted_setup(Cfg::new()).await;
    let mut raw = RawPg::connect(s.engine.pg_port, PG_USER, PG_PASSWORD, "operations")
        .await
        .unwrap();
    let (_, _, err) = raw
        .simple_query(&format!(
            "SET hrx.identity = {}",
            sql_lit(&restricted_reader().token())
        ))
        .await;
    assert!(err.is_none());
    for (dynamo, s3) in [(true, false), (false, true)] {
        s.audit.fail_dynamo(dynamo);
        s.audit.fail_s3(s3);
        let (_, rows, err) = raw.simple_query(RESTRICTED_SQL).await;
        assert!(
            rows.is_empty(),
            "no result rows when the audit write fails (dynamo {dynamo}, s3 {s3})"
        );
        let err = err.expect("an error");
        assert_eq!(err.sqlstate(), Some("58000"), "{err:?}");
        if let crate::harness::raw_pg::Msg::Error(f) = &err {
            assert!(
                f.get(&'M')
                    .is_some_and(|m| m.contains("audit write failed")),
                "{f:?}"
            );
        }
    }
    // Extended protocol too.
    let c = s.engine.connect().await;
    set_identity(&c, &restricted_reader().token()).await;
    assert_sqlstate(
        c.query(RESTRICTED_SQL, &[]).await,
        "58000",
        "audit write failed",
    );
    s.audit.fail_s3(false);
    assert_eq!(
        c.query(RESTRICTED_SQL, &[]).await.unwrap().len(),
        2,
        "recovers when the store does"
    );
    let (_, rows, err) = raw.simple_query(RESTRICTED_SQL).await;
    assert!(err.is_none());
    assert_eq!(rows.len(), 2);
}

/// eng-audit-failed-query-recorded
#[tokio::test]
async fn eng_audit_failed_query_recorded() {
    let p = platform_setup(Cfg::new(), false).await;
    let c = p.engine.connect().await;
    set_identity(&c, &reader().token()).await;
    let sql = pq("SELECT 1 / (id - id) AS boom FROM widgets");
    assert!(c.query(&sql, &[]).await.is_err());
    let items = p.audit.items();
    assert_eq!(items.len(), 1, "failed executions are audited");
    assert_eq!(items[0]["status"], "error");
    assert!(
        items[0]["errorMessage"]
            .as_str()
            .unwrap_or_default()
            .contains("division by zero"),
        "{}",
        items[0]
    );
    assert_eq!(items[0]["rowCount"], Value::Null);
    assert_eq!(items[0]["sql"], sql);
    assert_eq!(
        items[0]["integrityHash"],
        json!(portal_integrity_hash(&items[0], Some(AUDIT_KEY)))
    );
    // A successful one for contrast.
    c.query(&pq("SELECT id FROM widgets WHERE id < 4"), &[])
        .await
        .unwrap();
    let item = &p.audit.items()[1];
    assert_eq!(item["status"], "success");
    assert_eq!(item["rowCount"], json!(3));
}

/// eng-audit-action-mapping
#[tokio::test]
async fn eng_audit_action_mapping() {
    let p = platform_setup(Cfg::new(), false).await;
    let c = p.engine.connect().await;
    let sql = pq("SELECT id FROM widgets WHERE id = 1");
    for (id, action) in [
        (reader(), "query"),
        (
            Identity::mcp_agent()
                .attr("platform_read", true)
                .description("agent question"),
            "ai_ask",
        ),
        (reader().agent(true), "ai_ask"),
        (
            Identity::system()
                .attr("platform_read", true)
                .description("rule: stuck widgets"),
            "assertion",
        ),
    ] {
        set_identity(&c, &id.token()).await;
        c.query(&sql, &[]).await.unwrap();
        let item = p.audit.items().pop().unwrap();
        assert_eq!(item["action"], action, "{:?}", id.claims);
        assert_eq!(item["executedBySub"], id.sub());
        assert_eq!(item["database"], "platform");
    }
}

// ---------------------------------------------------------------------------------------------
// GET /v1/audit
// ---------------------------------------------------------------------------------------------

fn seeded(i: usize, created: &str, ticket: Option<&str>, email: &str) -> Value {
    let mut item = json!({
        "id": format!("00000000-0000-4000-8000-{:012}", i), "sql": "SELECT 1", "mode": "read",
        "description": format!("seeded {i}"), "database": "platform",
        "executedByEmail": email, "executedBySub": format!("sub-{email}"), "status": "success",
        "rowCount": 1, "durationMs": 3, "errorMessage": null, "preview": false, "action": "query",
        "integrityHash": "hmac-sha256:00", "createdAt": created, "createdAtMonth": &created[..7],
    });
    if let Some(t) = ticket {
        item["linearTicketId"] = json!(t);
    }
    item
}

async fn audit_engine() -> (Engine, AuditStore, MockServer) {
    let audit = AuditStore::start().await;
    let mock = prometheus_mock(prom_matrix(&[]), prom_vector(&[])).await;
    let engine = Engine::start(
        Cfg::new()
            .prometheus("prom-restricted", &mock.url(), "restricted = true")
            .audit(&audit),
    )
    .await;
    (engine, audit, mock)
}

async fn get_audit(engine: &Engine, query: &str, bearer: Option<&str>) -> (u16, Value) {
    let mut req = engine
        .http_client()
        .get(engine.http(&format!("/v1/audit{query}")));
    if let Some(b) = bearer {
        req = req.bearer_auth(b);
    }
    let resp = req.send().await.unwrap();
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(Value::Null))
}

fn ids(body: &Value) -> Vec<String> {
    body["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect()
}

fn browser() -> Identity {
    Identity::person().attr("platform_read", true)
}

fn decode_cursor(c: &str) -> Value {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(c)
        .expect("cursor is base64 (Buffer.toString('base64'))");
    serde_json::from_slice(&bytes).expect("cursor is base64 JSON")
}

/// eng-audit-browser-by-month
#[tokio::test]
async fn eng_audit_browser_by_month() {
    let (engine, audit, _mock) = audit_engine().await;
    for i in 0..30 {
        audit.seed(seeded(
            i,
            &format!("2026-10-{:02}T10:00:00.000Z", i + 1),
            None,
            "a@example.com",
        ));
    }
    for i in 30..33 {
        audit.seed(seeded(
            i,
            &format!("2026-09-{:02}T10:00:00.000Z", i - 20),
            None,
            "a@example.com",
        ));
    }
    let token = browser().token();
    let (status, page1) = get_audit(&engine, "?month=2026-10", Some(&token)).await;
    assert_eq!(status, 200, "{page1}");
    let first = ids(&page1);
    assert_eq!(first.len(), 25, "page size 25");
    assert_eq!(
        first[0], "00000000-0000-4000-8000-000000000029",
        "newest first"
    );
    let created: Vec<&str> = page1["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["createdAt"].as_str().unwrap())
        .collect();
    assert!(created.windows(2).all(|w| w[0] >= w[1]));
    assert_eq!(
        page1["items"][0]["description"], "seeded 29",
        "items are portal Execution objects"
    );
    let cursor = page1["nextCursor"]
        .as_str()
        .expect("a next cursor")
        .to_string();
    let decoded = decode_cursor(&cursor);
    assert_eq!(
        decoded["month"], "2026-10",
        "portal range cursor {{month, key}}: {decoded}"
    );
    let (status, page2) = get_audit(
        &engine,
        &format!("?month=2026-10&cursor={}", urlencode(&cursor)),
        Some(&token),
    )
    .await;
    assert_eq!(status, 200);
    let second = ids(&page2);
    assert_eq!(second.len(), 5);
    assert_eq!(page2["nextCursor"], Value::Null);
    let all: HashSet<String> = first.into_iter().chain(second).collect();
    assert_eq!(
        all.len(),
        30,
        "no overlap, nothing missing, nothing from September"
    );
    assert!(
        audit
            .query_inputs()
            .iter()
            .all(|q| q["IndexName"] == "byMonth")
    );
    let (status, _) = get_audit(&engine, "?month=2026-13", Some(&token)).await;
    assert_eq!(status, 400);
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// eng-audit-browser-by-ticket-and-user
#[tokio::test]
async fn eng_audit_browser_by_ticket_and_user() {
    let (engine, audit, _mock) = audit_engine().await;
    for i in 0..27 {
        let email = if i % 3 == 0 {
            "b@example.com"
        } else {
            "a@example.com"
        };
        audit.seed(seeded(
            i,
            &format!("2026-{:02}-{:02}T08:00:00.000Z", 9 + i % 2, 1 + i),
            Some("ENG-7"),
            email,
        ));
    }
    for i in 27..33 {
        audit.seed(seeded(
            i,
            &format!("2026-10-{:02}T09:00:00.000Z", i - 26),
            Some("ENG-8"),
            "b@example.com",
        ));
    }
    let token = browser().token();
    let (status, page1) = get_audit(&engine, "?ticket=ENG-7", Some(&token)).await;
    assert_eq!(status, 200, "{page1}");
    assert_eq!(ids(&page1).len(), 25);
    assert!(
        page1["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["linearTicketId"] == "ENG-7")
    );
    let cursor = page1["nextCursor"]
        .as_str()
        .expect("next cursor")
        .to_string();
    assert!(
        decode_cursor(&cursor)["id"].is_string(),
        "portal cursor: base64 JSON of LastEvaluatedKey"
    );
    let (_, page2) = get_audit(
        &engine,
        &format!("?ticket=ENG-7&cursor={}", urlencode(&cursor)),
        Some(&token),
    )
    .await;
    assert_eq!(ids(&page2).len(), 2);
    assert_eq!(page2["nextCursor"], Value::Null);
    let q = audit.query_inputs();
    assert!(q.iter().all(|q| q["IndexName"] == "byTicket"), "{q:?}");

    let (_, by_user) = get_audit(&engine, "?user=b@example.com", Some(&token)).await;
    let users: Vec<&str> = by_user["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["executedByEmail"].as_str().unwrap())
        .collect();
    assert_eq!(users.len(), 9 + 6);
    assert!(users.iter().all(|u| *u == "b@example.com"));
    assert_eq!(audit.query_inputs().last().unwrap()["IndexName"], "byUser");
    // ticket takes precedence over user, as in the portal.
    let (_, both) = get_audit(&engine, "?ticket=ENG-8&user=a@example.com", Some(&token)).await;
    assert_eq!(ids(&both).len(), 6);
    assert_eq!(
        audit.query_inputs().last().unwrap()["IndexName"],
        "byTicket"
    );
}

/// eng-audit-browser-authorization
#[tokio::test]
async fn eng_audit_browser_authorization() {
    let (engine, audit, _mock) = audit_engine().await;
    audit.seed(seeded(1, "2026-10-01T00:00:00.000Z", None, "a@example.com"));
    let (status, _) = get_audit(&engine, "?month=2026-10", None).await;
    assert_eq!(status, 401);
    let (status, _) = get_audit(&engine, "?month=2026-10", Some("garbage")).await;
    assert_eq!(status, 401);
    let (status, _) = get_audit(
        &engine,
        "?month=2026-10",
        Some(&browser().times(-900, -600).token()),
    )
    .await;
    assert_eq!(status, 401);
    let (status, body) = get_audit(
        &engine,
        "?month=2026-10",
        Some(
            &Identity::person()
                .attr("telemetry_restricted", true)
                .token(),
        ),
    )
    .await;
    assert_eq!(status, 403);
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("platform_read"),
        "{body}"
    );
    assert!(
        audit.query_inputs().is_empty(),
        "refused before touching the store"
    );
    let (status, body) = get_audit(&engine, "?month=2026-10", Some(&browser().token())).await;
    assert_eq!(status, 200);
    assert_eq!(ids(&body).len(), 1);
}
