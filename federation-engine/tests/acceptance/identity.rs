//! Identity tokens (§3) and Restricted Telemetry enforcement (§1.2).

use serde_json::json;

use crate::harness::aws::AuditStore;
use crate::harness::telemetry::*;
use crate::harness::tokens::*;
use crate::harness::*;

pub const T0: f64 = 1_762_560_000.0;
pub const RESTRICTED_SQL: &str = "SELECT * FROM promql('up', '2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z', '1m', 'prom-restricted')";
pub const OPEN_SQL: &str =
    "SELECT * FROM promql('up', '2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z', '1m')";

#[allow(dead_code)]
pub struct Restricted {
    pub engine: Engine,
    pub open: MockServer,
    pub restricted: MockServer,
    pub audit: AuditStore,
}

/// prom-open (default, unrestricted) and prom-restricted (`restricted = true`), each answering
/// 2 rows, plus the audit store.
pub async fn restricted_setup(extra: Cfg) -> Restricted {
    let body = prom_matrix(&[(
        json!({"job": "restricted-canary"}),
        vec![(T0, "1".into()), (T0 + 60.0, "2".into())],
    )]);
    let open = prometheus_mock(body.clone(), prom_vector(&[])).await;
    let restricted = prometheus_mock(body, prom_vector(&[])).await;
    let audit = AuditStore::start().await;
    let engine = Engine::start(
        extra
            .prometheus("prom-open", &open.url(), "default = true")
            .prometheus("prom-restricted", &restricted.url(), "restricted = true")
            .audit(&audit),
    )
    .await;
    Restricted {
        engine,
        open,
        restricted,
        audit,
    }
}

/// A person allowed to read Restricted Telemetry, with a description.
pub fn restricted_reader() -> Identity {
    Identity::person()
        .attr("telemetry_restricted", true)
        .description("investigating elevated error rate")
}

fn source_calls(m: &MockServer) -> usize {
    m.requests_to("/api/v1/").len()
}

/// eng-identity-restricted-denied
#[tokio::test]
async fn eng_identity_restricted_denied() {
    let s = restricted_setup(Cfg::new()).await;
    let c = s.engine.connect().await;
    // Ordinary telemetry needs only the login.
    assert_eq!(c.query(OPEN_SQL, &[]).await.unwrap().len(), 2);
    // No identity at all.
    assert_sqlstate(
        c.query(RESTRICTED_SQL, &[]).await,
        "42501",
        "telemetry_restricted",
    );
    // A valid identity without the claim.
    set_identity(&c, &Identity::person().description("x").token()).await;
    assert_sqlstate(
        c.query(RESTRICTED_SQL, &[]).await,
        "42501",
        "telemetry_restricted",
    );
    // A token signed with another key counts as no claims.
    set_identity(
        &c,
        &restricted_reader().token_with_secret("some-other-secret-not-real"),
    )
    .await;
    assert_sqlstate(
        c.query(RESTRICTED_SQL, &[]).await,
        "42501",
        "telemetry_restricted",
    );
    // An expired token counts as no claims.
    set_identity(&c, &restricted_reader().times(-600, -300).token()).await;
    assert_sqlstate(
        c.query(RESTRICTED_SQL, &[]).await,
        "42501",
        "telemetry_restricted",
    );
    // Joins and subqueries cannot route around the check.
    let r = c
        .query(&format!("SELECT count(*) FROM ({OPEN_SQL}) a JOIN ({RESTRICTED_SQL}) b ON a.\"timestamp\" = b.\"timestamp\""), &[])
        .await;
    assert_sqlstate(r, "42501", "telemetry_restricted");
    assert_eq!(
        source_calls(&s.restricted),
        0,
        "a refused query never reaches the source"
    );
    assert!(s.audit.items().is_empty());
}

/// eng-identity-token-verification
#[tokio::test]
async fn eng_identity_token_verification() {
    let s = restricted_setup(Cfg::new()).await;
    let c = s.engine.connect().await;
    let accepted = |id: Identity| id.token();
    // Accepted: fresh; iat 30 s in the future (inside the 60 s skew); lifetime exactly 300 s.
    for (label, token) in [
        ("fresh", accepted(restricted_reader())),
        ("iat +30s", accepted(restricted_reader().times(30, 300))),
        (
            "old but unexpired",
            accepted(restricted_reader().times(-290, 10)),
        ),
    ] {
        set_identity(&c, &token).await;
        let rows = c.query(RESTRICTED_SQL, &[]).await;
        assert!(
            rows.is_ok(),
            "{label} token must be accepted: {:?}",
            rows.err()
        );
    }
    let good = restricted_reader();
    let tampered = {
        let t = good.token();
        let (p, sig) = t.split_once('.').unwrap();
        let mut claims = good.claims.clone();
        claims["email"] = json!("someone.else@example.com");
        let p2 = b64url(&serde_json::to_vec(&claims).unwrap());
        assert_ne!(p, p2);
        format!("{p2}.{sig}")
    };
    let rejected: Vec<(&str, String)> = vec![
        ("expired", restricted_reader().times(-400, -1).token()),
        (
            "iat 120 s in the future",
            restricted_reader().times(120, 400).token(),
        ),
        (
            "lifetime over 300 s",
            restricted_reader().times(0, 301).token(),
        ),
        ("v = 2", restricted_reader().set("v", json!(2)).token()),
        ("v missing", {
            let mut id = restricted_reader();
            id.claims.as_object_mut().unwrap().remove("v");
            id.token()
        }),
        (
            "wrong key",
            restricted_reader().token_with_secret("wrong-secret-not-real"),
        ),
        ("tampered payload", tampered),
        ("not a token", "not-a-token".into()),
        ("empty", String::new()),
    ];
    for (label, token) in rejected {
        set_identity(&c, &token).await;
        let r = c.query(RESTRICTED_SQL, &[]).await;
        let (code, msg) = db_error(r);
        assert_eq!(
            code, "42501",
            "{label} token must count as no claims ({msg})"
        );
    }
    // A later SET replaces the identity.
    set_identity(&c, &restricted_reader().token()).await;
    assert!(c.query(RESTRICTED_SQL, &[]).await.is_ok());
}

/// eng-identity-per-session
#[tokio::test]
async fn eng_identity_per_session() {
    let s = restricted_setup(Cfg::new()).await;
    let a = s.engine.connect().await;
    let b = s.engine.connect().await;
    set_identity(&a, &restricted_reader().token()).await;
    assert!(a.query(RESTRICTED_SQL, &[]).await.is_ok());
    assert_sqlstate(
        b.query(RESTRICTED_SQL, &[]).await,
        "42501",
        "telemetry_restricted",
    );
    // Concurrent sessions keep their own identities.
    let mut tasks = vec![];
    for i in 0..8 {
        let c = s.engine.connect().await;
        tasks.push(tokio::spawn(async move {
            let allowed = i % 2 == 0;
            let id = if allowed {
                restricted_reader()
            } else {
                Identity::person().description("no claim")
            };
            set_identity(&c, &id.token()).await;
            for _ in 0..3 {
                assert_eq!(
                    c.query(RESTRICTED_SQL, &[]).await.is_ok(),
                    allowed,
                    "session {i}"
                );
            }
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    // Replacing the identity with one lacking the claim takes effect immediately.
    set_identity(&a, &Identity::person().description("x").token()).await;
    assert_sqlstate(
        a.query(RESTRICTED_SQL, &[]).await,
        "42501",
        "telemetry_restricted",
    );
    // A new connection starts with no identity.
    let fresh = s.engine.connect().await;
    assert_sqlstate(
        fresh.query(RESTRICTED_SQL, &[]).await,
        "42501",
        "telemetry_restricted",
    );
}

/// eng-identity-agent-and-system
#[tokio::test]
async fn eng_identity_agent_and_system() {
    let s = restricted_setup(Cfg::new()).await;
    let c = s.engine.connect().await;
    // AI agents never read Restricted Telemetry, whatever their attrs say.
    set_identity(&c, &restricted_reader().agent(true).token()).await;
    let (code, msg) = db_error(c.query(RESTRICTED_SQL, &[]).await);
    assert_eq!(code, "42501");
    assert!(
        msg.contains("agent"),
        "the message names the agent restriction: {msg}"
    );
    set_identity(
        &c,
        &Identity::mcp_agent()
            .attr("telemetry_restricted", true)
            .description("mcp")
            .token(),
    )
    .await;
    assert_sqlstate(c.query(RESTRICTED_SQL, &[]).await, "42501", "agent");
    // Agents still read ordinary telemetry.
    assert!(c.query(OPEN_SQL, &[]).await.is_ok());
    // The system identity counts as agent = false, and needs the same attrs.
    set_identity(
        &c,
        &Identity::system()
            .attr("telemetry_restricted", true)
            .description("rule: high error rate")
            .token(),
    )
    .await;
    assert!(
        c.query(RESTRICTED_SQL, &[]).await.is_ok(),
        "system identity with the attr"
    );
    set_identity(
        &c,
        &Identity::system().description("rule without attr").token(),
    )
    .await;
    assert_sqlstate(
        c.query(RESTRICTED_SQL, &[]).await,
        "42501",
        "telemetry_restricted",
    );
    assert_eq!(source_calls(&s.restricted), 1);
}

/// eng-audited-query-description-required
#[tokio::test]
async fn eng_audited_query_description_required() {
    let s = restricted_setup(Cfg::new()).await;
    let c = s.engine.connect().await;
    for id in [
        Identity::person().attr("telemetry_restricted", true),
        Identity::person()
            .attr("telemetry_restricted", true)
            .description(""),
    ] {
        set_identity(&c, &id.token()).await;
        assert_sqlstate(
            c.query(RESTRICTED_SQL, &[]).await,
            "42501",
            "audited query requires a description",
        );
    }
    assert_eq!(source_calls(&s.restricted), 0);
    assert!(s.audit.items().is_empty());
    set_identity(&c, &restricted_reader().token()).await;
    assert!(c.query(RESTRICTED_SQL, &[]).await.is_ok());
}

/// eng-restricted-loki-selectors
#[tokio::test]
async fn eng_restricted_loki_selectors() {
    let body = loki_streams(&[(
        json!({"namespace": "web"}),
        vec![("1762560000000000000", "line")],
    )]);
    let metric = loki_matrix(&[(json!({"namespace": "web"}), vec![(T0, "1".into())])]);
    let mock = MockServer::start(move |r| {
        if r.path == "/loki/api/v1/query_range" {
            if r.param_or_form("step").is_some() {
                Reply::json(&metric)
            } else {
                Reply::json(&body)
            }
        } else {
            Reply::text(200, "ready")
        }
    })
    .await;
    let audit = AuditStore::start().await;
    let engine = Engine::start(
        Cfg::new()
            .loki(
                "loki-a",
                &mock.url(),
                "restricted_selectors = ['{namespace=\"platform\"}']",
            )
            .audit(&audit),
    )
    .await;
    let c = engine.connect().await;
    let range = "'2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z'";
    let logql = |q: &str| format!("SELECT * FROM logql({}, {range})", sql_lit(q));
    let metric_sql = |q: &str| format!("SELECT * FROM logql_metric({}, {range}, '1m')", sql_lit(q));
    // Provably outside every restricted selector (an equality matcher on the same label with
    // another value): no claim needed.
    for q in [
        r#"{namespace="web"} |= "error""#,
        r#"{namespace="web", app="api"}"#,
    ] {
        assert!(c.query(&logql(q), &[]).await.is_ok(), "{q} is unrestricted");
    }
    let calls_before = mock.requests_to("/loki/").len();
    for q in [
        r#"{namespace="platform"}"#,
        r#"{namespace="platform", app="api"} |= "error""#,
        r#"{app="api"}"#,
        r#"{namespace=~"plat.*"}"#,
        r#"{namespace!="web"}"#,
    ] {
        assert_sqlstate(
            c.query(&logql(q), &[]).await,
            "42501",
            "telemetry_restricted",
        );
    }
    assert_sqlstate(
        c.query(
            &metric_sql(r#"sum(count_over_time({namespace="platform"}[5m]))"#),
            &[],
        )
        .await,
        "42501",
        "telemetry_restricted",
    );
    assert_sqlstate(
        c.query(&metric_sql(r#"sum(count_over_time({namespace="web"}[5m])) / sum(count_over_time({namespace="platform"}[5m]))"#), &[]).await,
        "42501",
        "telemetry_restricted",
    );
    assert_eq!(
        mock.requests_to("/loki/").len(),
        calls_before,
        "refused queries never reach Loki"
    );
    assert!(audit.items().is_empty());
    set_identity(&c, &restricted_reader().token()).await;
    assert!(
        c.query(&logql(r#"{namespace="platform"}"#), &[])
            .await
            .is_ok()
    );
    assert_eq!(
        audit.items().len(),
        1,
        "a restricted read is an Audited Query"
    );
    assert_eq!(audit.items()[0]["database"], "loki-a");
}

/// eng-restricted-cloudwatch-log-groups
#[tokio::test]
async fn eng_restricted_cloudwatch_log_groups() {
    let logs = logs_insights_mock(
        0,
        "Complete",
        vec![vec![
            ("@timestamp", "2026-11-08 00:00:01.000".into()),
            ("@message", "m".into()),
        ]],
    )
    .await;
    let audit = AuditStore::start().await;
    let engine = Engine::start(
        Cfg::new()
            .table(&format!(
                "[[sources]]\nname = \"logs-a\"\nkind = \"cloudwatch_logs\"\nregion = \"us-east-2\"\nendpoint_url = \"{}\"\npoll_interval_ms = 50\nrestricted_log_groups = [\"/aws/rds/platform\"]\n",
                logs.server.url()
            ))
            .audit(&audit),
    )
    .await;
    let c = engine.connect().await;
    let range = "'2026-11-08T00:00:00Z', '2026-11-08T01:00:00Z'";
    let sql = |groups: &str| {
        format!(
            "SELECT * FROM cloudwatch_logs({}, 'fields @message', {range})",
            sql_lit(groups)
        )
    };
    assert!(c.query(&sql("/aws/lambda/web"), &[]).await.is_ok());
    let starts = logs.calls("StartQuery").len();
    for groups in [
        "/aws/rds/platform",
        "/aws/lambda/web, /aws/rds/platform",
        " /aws/rds/platform ",
    ] {
        assert_sqlstate(
            c.query(&sql(groups), &[]).await,
            "42501",
            "telemetry_restricted",
        );
    }
    assert_eq!(
        logs.calls("StartQuery").len(),
        starts,
        "refused queries never start"
    );
    set_identity(&c, &restricted_reader().token()).await;
    assert_eq!(
        c.query(&sql("/aws/lambda/web, /aws/rds/platform"), &[])
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(audit.items().len(), 1);
    assert_eq!(audit.items()[0]["database"], "logs-a");
}
