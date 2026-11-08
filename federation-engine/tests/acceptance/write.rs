//! Write Mode (`POST /v1/write`, §4.2 engine side): confirmation tokens, Preview, commit, agents.

use serde_json::{Value, json};

use crate::harness::tokens::{PROJECT_UUID, confirmation_token_with};
use crate::harness::*;
use crate::platform::platform_setup;

/// A person holding `platform_write`.
pub fn writer() -> Identity {
    Identity::person()
        .attr("platform_write", true)
        .attr("platform_read", true)
        .description("fix a synthetic record")
}

/// POSTs `body` to `/v1/write` with an optional bearer token. Returns (status, JSON body or Null).
pub async fn write_req(engine: &Engine, bearer: Option<&str>, body: &Value) -> (u16, Value) {
    post_json(engine, "/v1/write", bearer, body).await
}

pub async fn post_json(
    engine: &Engine,
    path: &str,
    bearer: Option<&str>,
    body: &Value,
) -> (u16, Value) {
    let mut req = engine.http_client().post(engine.http(path)).json(body);
    if let Some(b) = bearer {
        req = req.bearer_auth(b);
    }
    let resp = req.send().await.expect("HTTP request to the engine");
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

pub fn write_body(id: &Identity, stmt: &str, mode: &str) -> Value {
    json!({"statement": stmt, "mode": mode,
           "confirmation_token": confirmation_token(stmt, &id.sub(), PROJECT_UUID),
           "description": "fix a synthetic record", "ticket": "ENG-4242"})
}

fn int_of(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

async fn note_of(p: &crate::platform::Platform, id: i64) -> Option<String> {
    p.cluster
        .superuser()
        .await
        .query_one("SELECT note FROM widgets WHERE id = $1", &[&id])
        .await
        .unwrap()
        .get(0)
}

/// eng-write-preview
#[tokio::test]
async fn eng_write_preview() {
    let p = platform_setup(Cfg::new(), true).await;
    let id = writer();
    let stmt = "UPDATE widgets SET note = 'previewed' WHERE id <= 3 RETURNING id, note";
    let (status, body) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "preview"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["preview"], json!(true));
    assert_eq!(body["rows_affected"], json!(3));
    assert!(
        body["audit_id"].as_str().is_some_and(|s| !s.is_empty()),
        "{body}"
    );
    let ret = body["returning"].as_array().expect("RETURNING rows");
    assert_eq!(ret.len(), 3);
    let mut ids: Vec<i64> = ret.iter().map(|r| int_of(&r["id"]).unwrap()).collect();
    ids.sort();
    assert_eq!(ids, vec![1, 2, 3]);
    assert!(ret.iter().all(|r| r["note"] == "previewed"));
    for i in 1..=3 {
        assert_eq!(note_of(&p, i).await, None, "Preview rolls back");
    }
    // Preview runs on the write pool, as the elevated role.
    let stmt = "UPDATE widgets SET note = current_user WHERE id = 1 RETURNING note";
    let (status, body) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "preview"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["returning"][0]["note"],
        crate::harness::pg_cluster::WRITE_ROLE
    );
    assert_eq!(note_of(&p, 1).await, None);
}

/// eng-write-preview-returning-cap
#[tokio::test]
async fn eng_write_preview_returning_cap() {
    let p = platform_setup(Cfg::new(), true).await;
    let id = writer();
    let stmt = "UPDATE widgets SET note = 'x' RETURNING id";
    let (status, body) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "preview"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["rows_affected"], json!(200));
    assert_eq!(
        body["returning"].as_array().map(|a| a.len()),
        Some(100),
        "at most 100 RETURNING rows"
    );
    let stmt = "DELETE FROM widgets WHERE id > 190";
    let (status, body) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "preview"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["rows_affected"], json!(10));
    assert_eq!(
        body["returning"],
        Value::Null,
        "no RETURNING clause -> null"
    );
    assert_eq!(p.cluster.count("widgets").await, 200);
}

/// eng-write-commit
#[tokio::test]
async fn eng_write_commit() {
    let p = platform_setup(Cfg::new(), true).await;
    let id = writer();
    let stmt = "UPDATE widgets SET note = current_user WHERE id = 7";
    let (status, body) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "commit"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["preview"], json!(false));
    assert_eq!(body["rows_affected"], json!(1));
    assert!(body["audit_id"].is_string());
    assert_eq!(
        note_of(&p, 7).await.as_deref(),
        Some(crate::harness::pg_cluster::WRITE_ROLE),
        "committed on the write pool"
    );
    let stmt = "INSERT INTO patients (full_name) VALUES ('Synthetic Person Three') RETURNING id";
    let (status, body) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "commit"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(p.cluster.count("patients").await, 3);
    assert!(int_of(&body["returning"][0]["id"]).is_some(), "{body}");
}

/// eng-write-authorization
#[tokio::test]
async fn eng_write_authorization() {
    let p = platform_setup(Cfg::new(), true).await;
    let stmt = "UPDATE widgets SET note = 'auth' WHERE id = 1";
    let id = writer();
    let (status, _) = write_req(&p.engine, None, &write_body(&id, stmt, "commit")).await;
    assert_eq!(status, 401, "no bearer token");
    let (status, _) = write_req(
        &p.engine,
        Some("not-a-token"),
        &write_body(&id, stmt, "commit"),
    )
    .await;
    assert_eq!(status, 401, "invalid bearer token");
    let (status, _) = write_req(
        &p.engine,
        Some(&id.clone().times(-600, -300).token()),
        &write_body(&id, stmt, "commit"),
    )
    .await;
    assert_eq!(status, 401, "expired bearer token");
    let reader_only = Identity::person().attr("platform_read", true);
    let (status, body) = write_req(
        &p.engine,
        Some(&reader_only.token()),
        &write_body(&reader_only, stmt, "commit"),
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("platform_write"),
        "{body}"
    );
    let mut no_desc = write_body(&id, stmt, "commit");
    no_desc["description"] = json!("");
    let (status, _) = write_req(&p.engine, Some(&id.token()), &no_desc).await;
    assert_eq!(status, 400, "a description is required");
    let mut bad_mode = write_body(&id, stmt, "commit");
    bad_mode["mode"] = json!("yolo");
    let (status, _) = write_req(&p.engine, Some(&id.token()), &bad_mode).await;
    assert_eq!(status, 400, "mode is preview or commit");
    assert_eq!(note_of(&p, 1).await, None);

    // Write Mode is off when write_url_env is unset.
    let off = platform_setup(Cfg::new(), false).await;
    let (status, body) = write_req(
        &off.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "preview"),
    )
    .await;
    assert_eq!(status, 503, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
            .contains("write mode")
    );
}

/// eng-write-confirmation-single-use
#[tokio::test]
async fn eng_write_confirmation_single_use() {
    let p = platform_setup(Cfg::new(), true).await;
    let id = writer();
    let stmt = "UPDATE widgets SET score = score + 1 WHERE id = 9";
    let body = write_body(&id, stmt, "commit");
    let (status, b) = write_req(&p.engine, Some(&id.token()), &body).await;
    assert_eq!(status, 200, "{b}");
    let (status, b) = write_req(&p.engine, Some(&id.token()), &body).await;
    assert_eq!(status, 409, "a reused confirmation token is refused: {b}");
    let score: f64 = p
        .cluster
        .superuser()
        .await
        .query_one("SELECT score FROM widgets WHERE id = 9", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(score, 14.5, "the statement ran exactly once");
    // A token spent on a Preview cannot then commit.
    let stmt = "UPDATE widgets SET note = 'once' WHERE id = 10";
    let mut body = write_body(&id, stmt, "preview");
    let (status, _) = write_req(&p.engine, Some(&id.token()), &body).await;
    assert_eq!(status, 200);
    body["mode"] = json!("commit");
    let (status, _) = write_req(&p.engine, Some(&id.token()), &body).await;
    assert_eq!(status, 409);
    assert_eq!(note_of(&p, 10).await, None);
}

/// eng-write-confirmation-binding
#[tokio::test]
async fn eng_write_confirmation_binding() {
    let p = platform_setup(Cfg::new(), true).await;
    let id = writer();
    let stmt = "UPDATE widgets SET note = 'bound' WHERE id = 11";
    let sub = id.sub();
    let cases: Vec<(&str, Option<String>)> = vec![
        (
            "another statement",
            Some(confirmation_token(
                "UPDATE widgets SET note = 'other' WHERE id = 11",
                &sub,
                PROJECT_UUID,
            )),
        ),
        (
            "another user",
            Some(confirmation_token(
                stmt,
                "00000000-0000-4000-8000-0000000000ff",
                PROJECT_UUID,
            )),
        ),
        (
            "another project",
            Some(confirmation_token(
                stmt,
                &sub,
                "00000000-0000-4000-8000-0000000000cc",
            )),
        ),
        (
            "expired",
            Some(confirmation_token_with(
                stmt,
                &sub,
                PROJECT_UUID,
                -200,
                -10,
                IDENTITY_SECRET,
            )),
        ),
        (
            "lifetime over 120 s",
            Some(confirmation_token_with(
                stmt,
                &sub,
                PROJECT_UUID,
                0,
                121,
                IDENTITY_SECRET,
            )),
        ),
        (
            "wrong key",
            Some(confirmation_token_with(
                stmt,
                &sub,
                PROJECT_UUID,
                0,
                120,
                "wrong-secret-not-real",
            )),
        ),
        ("an identity token instead", Some(id.token())),
        ("garbage", Some("garbage".into())),
        ("missing", None),
    ];
    for (label, token) in cases {
        let mut body = write_body(&id, stmt, "commit");
        body["confirmation_token"] = token.map(Value::from).unwrap_or(Value::Null);
        let (status, b) = write_req(&p.engine, Some(&id.token()), &body).await;
        assert_eq!(status, 403, "{label}: {b}");
    }
    assert_eq!(note_of(&p, 11).await, None);
    let (status, _) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "commit"),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(note_of(&p, 11).await.as_deref(), Some("bound"));
}

/// eng-write-agent-commit-refused
#[tokio::test]
async fn eng_write_agent_commit_refused() {
    let p = platform_setup(Cfg::new(), true).await;
    let stmt = "UPDATE widgets SET note = 'agent' WHERE id = 12";
    for agent in [
        writer().agent(true),
        Identity::mcp_agent()
            .attr("platform_write", true)
            .description("agent preview"),
    ] {
        let (status, body) = write_req(
            &p.engine,
            Some(&agent.token()),
            &write_body(&agent, stmt, "preview"),
        )
        .await;
        assert_eq!(status, 200, "agents may Preview: {body}");
        let (status, body) = write_req(
            &p.engine,
            Some(&agent.token()),
            &write_body(&agent, stmt, "commit"),
        )
        .await;
        assert_eq!(status, 403, "agents never commit: {body}");
        assert!(
            body["error"].as_str().unwrap_or_default().contains("agent"),
            "{body}"
        );
    }
    assert_eq!(note_of(&p, 12).await, None);
    // The system identity is not an agent.
    let sys = Identity::system().attr("platform_write", true);
    let (status, body) = write_req(
        &p.engine,
        Some(&sys.token()),
        &write_body(&sys, stmt, "commit"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
}

/// eng-write-statement-failure
#[tokio::test]
async fn eng_write_statement_failure() {
    let p = platform_setup(Cfg::new(), true).await;
    let id = writer();
    let stmt = "UPDATE widgets SET id = 1 WHERE id = 2";
    let (status, body) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "commit"),
    )
    .await;
    assert!(
        status == 400 || status == 422,
        "a failing statement is a client error: {status} {body}"
    );
    assert_eq!(
        body["sqlstate"], "23505",
        "the Postgres SQLSTATE is passed on: {body}"
    );
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("duplicate key"),
        "{body}"
    );
    let items = p.audit.items();
    assert_eq!(items.len(), 1, "failed writes are audited too");
    assert_eq!(items[0]["status"], "error");
    assert!(
        items[0]["errorMessage"]
            .as_str()
            .unwrap_or_default()
            .contains("duplicate key")
    );
    assert_eq!(items[0]["rowCount"], Value::Null);
}

/// eng-write-audit-records
#[tokio::test]
async fn eng_write_audit_records() {
    let p = platform_setup(Cfg::new(), true).await;
    let id = writer();
    let stmt = "UPDATE widgets SET note = 'audited' WHERE id IN (20, 21)";
    let (_, preview) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "preview"),
    )
    .await;
    let (_, commit) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(&id, stmt, "commit"),
    )
    .await;
    let agent = writer().agent(true);
    let (_, agent_preview) = write_req(
        &p.engine,
        Some(&agent.token()),
        &write_body(&agent, stmt, "preview"),
    )
    .await;
    let items = p.audit.items();
    assert_eq!(items.len(), 3, "{items:?}");
    let find = |audit_id: &Value| {
        items
            .iter()
            .find(|i| &i["id"] == audit_id)
            .unwrap_or_else(|| panic!("audit_id {audit_id} has an item"))
            .clone()
    };
    let pv = find(&preview["audit_id"]);
    let cm = find(&commit["audit_id"]);
    let ap = find(&agent_preview["audit_id"]);
    for (item, is_preview) in [(&pv, true), (&cm, false), (&ap, true)] {
        assert_eq!(item["mode"], "write");
        assert_eq!(item["preview"], json!(is_preview));
        assert_eq!(item["sql"], stmt);
        assert_eq!(item["database"], "platform");
        assert_eq!(item["description"], "fix a synthetic record");
        assert_eq!(item["linearTicketId"], "ENG-4242");
        assert_eq!(item["rowCount"], json!(2));
        assert_eq!(item["status"], "success");
        assert_eq!(item["executedBySub"], id.sub());
        assert_eq!(item["executedByEmail"], id.email());
        assert_eq!(
            item["integrityHash"],
            json!(crate::harness::tokens::portal_integrity_hash(
                item,
                Some(AUDIT_KEY)
            ))
        );
    }
    assert_eq!(pv["action"], "query");
    assert_eq!(ap["action"], "ai_ask");
    assert_eq!(p.audit.s3_puts().len(), 3);

    // Fail closed: the write is refused when the audit store refuses the record.
    p.audit.fail_dynamo(true);
    let (status, body) = write_req(
        &p.engine,
        Some(&id.token()),
        &write_body(
            &id,
            "UPDATE widgets SET note = 'x' WHERE id = 30",
            "preview",
        ),
    )
    .await;
    assert_eq!(status, 500, "{body}");
    assert_eq!(body["sqlstate"], "58000");
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("audit write failed")
    );
}

/// eng-write-confirmations-verify-endpoint
#[tokio::test]
async fn eng_write_confirmations_verify_endpoint() {
    let p = platform_setup(Cfg::new().top("test_mode = true"), true).await;
    let id = writer();
    let stmt = "UPDATE widgets SET note = 'verify' WHERE id = 40";
    let token = confirmation_token(stmt, &id.sub(), PROJECT_UUID);
    let verify = |s: &str, t: &str| json!({"statement": s, "confirmation_token": t});
    let (status, body) = post_json(
        &p.engine,
        "/v1/write/confirmations/verify",
        Some(&id.token()),
        &verify(stmt, &token),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["valid"], json!(true));
    let (status, body) = post_json(
        &p.engine,
        "/v1/write/confirmations/verify",
        Some(&id.token()),
        &verify("UPDATE widgets SET note = 'other'", &token),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["valid"], json!(false));
    // Verifying does not spend the token.
    let mut body = write_body(&id, stmt, "commit");
    body["confirmation_token"] = json!(token);
    let (status, b) = write_req(&p.engine, Some(&id.token()), &body).await;
    assert_eq!(status, 200, "{b}");
    // Disabled unless test_mode = true.
    let off = platform_setup(Cfg::new(), true).await;
    let (status, _) = post_json(
        &off.engine,
        "/v1/write/confirmations/verify",
        Some(&id.token()),
        &verify(stmt, &token),
    )
    .await;
    assert_eq!(status, 404);
}
