//! Ops Marts: the allowlisted BigQuery catalog `ops_marts` over the BigQuery REST API (mock).

use std::collections::HashSet;
use std::time::SystemTime;

use serde_json::Value;

use crate::harness::bigquery::{self, BigQueryMock};
use crate::harness::*;
use crate::promql::secs;

fn bq_source(mock: &BigQueryMock, auth: &str) -> String {
    format!(
        "[[sources]]\nname = \"ops-marts\"\nkind = \"bigquery\"\nproject = \"{}\"\nallow = [\"ops_marts.fills_hourly\", \"ops_marts.queue_depth\"]\napi_base_url = \"{}\"\n{auth}\n",
        bigquery::PROJECT,
        mock.url()
    )
}

async fn static_token_engine() -> (Engine, BigQueryMock) {
    let mock = BigQueryMock::start(bigquery::STATIC_TOKEN).await;
    let engine = Engine::start(
        Cfg::new()
            .table(&bq_source(&mock, "access_token_env = \"BQ_TEST_TOKEN\""))
            .env("BQ_TEST_TOKEN", bigquery::STATIC_TOKEN),
    )
    .await;
    (engine, mock)
}

/// eng-ops-marts-catalog
#[tokio::test]
async fn eng_ops_marts_catalog() {
    let (engine, _mock) = static_token_engine().await;
    let c = engine.connect().await;
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
        .unwrap();
    let tables: Vec<(String, String, String)> = rows
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        tables,
        vec![
            (
                "ops_marts".into(),
                "ops_marts".into(),
                "fills_hourly".into()
            ),
            ("ops_marts".into(), "ops_marts".into(), "queue_depth".into())
        ],
        "exactly the allowlist"
    );
    let cols: Vec<String> = c
        .query(
            "SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = $2 AND table_catalog = $3 ORDER BY ordinal_position",
            &[&"fills_hourly", &"ops_marts", &"ops_marts"],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(cols, ["hour", "pharmacy", "fills", "avg_minutes", "late"]);
    let stmt = c
        .prepare("SELECT * FROM ops_marts.ops_marts.fills_hourly")
        .await
        .unwrap();
    let oids: Vec<u32> = stmt.columns().iter().map(|c| c.type_().oid()).collect();
    assert_eq!(
        oids,
        vec![1184, 25, 20, 701, 16],
        "TIMESTAMP STRING INT64 FLOAT64 BOOL"
    );
}

/// eng-ops-marts-query
#[tokio::test]
async fn eng_ops_marts_query() {
    let (engine, mock) = static_token_engine().await;
    let c = engine.connect().await;
    let rows = c
        .query(
            "SELECT pharmacy, sum(fills) AS fills FROM ops_marts.ops_marts.fills_hourly GROUP BY pharmacy ORDER BY pharmacy",
            &[],
        )
        .await
        .unwrap();
    let got: Vec<(String, i64)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    assert_eq!(
        got,
        vec![("pharmacy-a".into(), 24), ("pharmacy-b".into(), 19)],
        "all pages read"
    );
    let rows = c
        .query(
            "SELECT hour, avg_minutes, late FROM ops_marts.ops_marts.fills_hourly WHERE pharmacy = 'pharmacy-b' ORDER BY hour",
            &[],
        )
        .await
        .unwrap();
    let got: Vec<(f64, Option<f64>, bool)> = rows
        .iter()
        .map(|r| (secs(r.get::<_, SystemTime>(0)), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        got,
        vec![
            (1_762_588_800.0, Some(20.25), true),
            (1_762_592_400.0, None, true),
            (1_762_596_000.0, Some(30.0), false)
        ]
    );
    // Joins with other tables run in the engine.
    let rows = c
        .query(
            "SELECT q.queue, sum(q.depth) AS depth, v.owner
             FROM ops_marts.ops_marts.queue_depth q JOIN (VALUES ('intake', 'team-a'), ('review', 'team-b')) AS v(queue, owner) ON q.queue = v.queue
             GROUP BY q.queue, v.owner ORDER BY q.queue",
            &[],
        )
        .await
        .unwrap();
    let got: Vec<(String, i64, String)> = rows
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        got,
        vec![
            ("intake".into(), 10, "team-a".into()),
            ("review".into(), 1, "team-b".into())
        ]
    );
    let reqs = mock.bq_requests();
    assert!(!reqs.is_empty());
    assert!(
        reqs.iter()
            .all(|r| r.header("authorization")
                == Some(&format!("Bearer {}", bigquery::STATIC_TOKEN))),
        "every BigQuery call carries the token source's bearer"
    );
}

/// eng-ops-marts-allowlist
#[tokio::test]
async fn eng_ops_marts_allowlist() {
    let (engine, mock) = static_token_engine().await;
    let c = engine.connect().await;
    for sql in [
        "SELECT * FROM ops_marts.ops_marts.not_allowlisted",
        "SELECT * FROM ops_marts.other_dataset.fills_hourly",
        "SELECT * FROM ops_marts.ops_marts.\"FILLS_HOURLY\"",
    ] {
        assert_sqlstate(c.query(sql, &[]).await, "42P01", "");
    }
    let n: i64 = c
        .query_one(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = 'not_allowlisted'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(n, 0);
    for r in mock.server.requests() {
        assert!(
            !r.raw_target.contains("not_allowlisted") && !r.body_str().contains("not_allowlisted"),
            "a table outside the allowlist was requested: {} {}",
            r.raw_target,
            r.body_str()
        );
        assert!(!r.raw_target.contains("other_dataset") && !r.body_str().contains("other_dataset"));
    }
}

/// eng-ops-marts-workload-identity
#[tokio::test]
async fn eng_ops_marts_workload_identity() {
    let mock = BigQueryMock::start(bigquery::SA_TOKEN).await;
    let auth = format!(
        "workload_identity_audience = \"{}\"\nservice_account = \"{}\"\ngcp_sts_url = \"{}/v1/token\"\ngcp_iam_credentials_url = \"{}\"",
        bigquery::WIF_AUDIENCE,
        bigquery::SERVICE_ACCOUNT,
        mock.url(),
        mock.url()
    );
    let engine = Engine::start(Cfg::new().table(&bq_source(&mock, &auth))).await;
    let c = engine.connect().await;
    let n: i64 = c
        .query_one("SELECT count(*) FROM ops_marts.ops_marts.queue_depth", &[])
        .await
        .expect("query through workload identity federation")
        .get(0);
    assert_eq!(n, 3);
    let sts = mock.server.requests_to("/v1/token");
    assert!(!sts.is_empty(), "GCP STS token exchange");
    let r = &sts[0];
    let field = |k: &str| -> String {
        if r.header("content-type")
            .unwrap_or_default()
            .contains("json")
        {
            r.json()[k].as_str().unwrap_or_default().to_string()
        } else {
            r.param_or_form(k).unwrap_or_default()
        }
    };
    assert_eq!(
        field("grant_type"),
        "urn:ietf:params:oauth:grant-type:token-exchange"
    );
    assert_eq!(field("audience"), bigquery::WIF_AUDIENCE);
    assert_eq!(
        field("subject_token_type"),
        "urn:ietf:params:aws:token-type:aws4_request"
    );
    let subject = field("subject_token");
    let decoded = crate::harness::mock_http::percent_decode(&subject);
    let st: Value = serde_json::from_str(&decoded)
        .expect("subject_token is the serialized signed GetCallerIdentity request");
    assert!(
        st["url"]
            .as_str()
            .unwrap_or_default()
            .contains("GetCallerIdentity"),
        "{st}"
    );
    assert_eq!(st["method"], "POST");
    let headers: HashSet<String> = st["headers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["key"].as_str().unwrap_or_default().to_ascii_lowercase())
        .collect();
    assert!(
        headers.contains("authorization") && headers.contains("x-goog-cloud-target-resource"),
        "{headers:?}"
    );
    let auth_header = st["headers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| {
            h["key"]
                .as_str()
                .unwrap_or_default()
                .eq_ignore_ascii_case("authorization")
        })
        .unwrap()["value"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        auth_header.contains(&format!("Credential={AWS_KEY_ID}/")),
        "signed with the engine's AWS identity: {auth_header}"
    );
    let gen_reqs: Vec<_> = mock
        .server
        .requests()
        .into_iter()
        .filter(|r| r.path.ends_with(":generateAccessToken"))
        .collect();
    assert_eq!(
        gen_reqs.len(),
        1,
        "the federated token is exchanged once and cached"
    );
    assert!(gen_reqs[0].path.contains(bigquery::SERVICE_ACCOUNT));
    assert!(
        mock.bq_requests()
            .iter()
            .all(|r| r.header("authorization") == Some(&format!("Bearer {}", bigquery::SA_TOKEN)))
    );
    // A second query reuses the cached token.
    c.query_one("SELECT count(*) FROM ops_marts.ops_marts.queue_depth", &[])
        .await
        .unwrap();
    assert_eq!(mock.server.requests_to("/v1/token").len(), 1);
}
