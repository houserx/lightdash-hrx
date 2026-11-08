//! Workspace and config (§1.4): `--config`, `--check-config`, env-var indirection for secrets.

use crate::harness::engine::run_engine_cli;
use crate::harness::*;

fn full_config(pg_port: u16, http_port: u16) -> String {
    format!(
        r#"listen_pg = "127.0.0.1:{pg_port}"
listen_http = "127.0.0.1:{http_port}"
identity_secret_env = "HRX_IDENTITY_SECRET"
max_rows = 100000

[[users]]
name = "lightdash-operations"
password_env = "HRX_PG_PASSWORD_OPERATIONS"

[[sources]]
name = "prometheus-production"
kind = "prometheus"
url = "http://127.0.0.1:9"
default = true
restricted = false

[[sources]]
name = "loki-production"
kind = "loki"
url = "http://127.0.0.1:9"
restricted_selectors = ['{{namespace="platform"}}']

[[sources]]
name = "cloudwatch-production"
kind = "cloudwatch"
region = "us-east-2"
role_arn = "arn:aws:iam::000000000000:role/test-not-real"

[[sources]]
name = "cloudwatch-logs-production"
kind = "cloudwatch_logs"
region = "us-east-2"
restricted_log_groups = ["/aws/rds/platform"]

[[sources]]
name = "tempo-production"
kind = "tempo"
url = "http://127.0.0.1:9"

[[sources]]
name = "platform"
kind = "platform_postgres"
read_url_env = "HRX_PLATFORM_READ_URL"
write_url_env = "HRX_PLATFORM_WRITE_URL"

[[sources]]
name = "ops-marts"
kind = "bigquery"
project = "hrx-test-dataplatform"
allow = ["ops_marts.fills_hourly", "ops_marts.queue_depth"]
access_token_env = "BQ_TEST_TOKEN"

[audit]
dynamodb_table = "db-query-portal-executions"
s3_bucket = "db-query-portal-audit"
integrity_key_env = "AUDIT_INTEGRITY_KEY"
"#
    )
}

const SECRET_ENV: [(&str, &str); 3] = [
    (
        "HRX_PLATFORM_READ_URL",
        "postgres://engine_read:test-read-password-not-real@127.0.0.1:9/postgres",
    ),
    (
        "HRX_PLATFORM_WRITE_URL",
        "postgres://engine_write:test-write-password-not-real@127.0.0.1:9/postgres",
    ),
    ("BQ_TEST_TOKEN", "test-bigquery-token-not-real"),
];

fn check(config: &str, env: &[(&str, &str)]) -> (bool, String) {
    let dir = unique_dir("check-config");
    let path = dir.join("federation-engine.toml");
    std::fs::write(&path, config).unwrap();
    let (status, out, err) =
        run_engine_cli(&["--check-config", "--config", path.to_str().unwrap()], env);
    (status.success(), format!("{out}\n{err}"))
}

/// eng-config-check
#[test]
fn eng_config_check() {
    // Ports held by this test: --check-config must validate without binding or connecting.
    let held_pg = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let held_http = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let cfg = full_config(
        held_pg.local_addr().unwrap().port(),
        held_http.local_addr().unwrap().port(),
    );

    let (ok, out) = check(&cfg, &SECRET_ENV);
    assert!(
        ok,
        "a valid config must pass --check-config; output:\n{out}"
    );
    for (_, secret) in SECRET_ENV {
        assert!(!out.contains(secret), "output must not echo secret values");
    }
    assert!(!out.contains(PG_PASSWORD) && !out.contains(IDENTITY_SECRET));

    // A secret's env var is missing: fail, naming the variable (not a value).
    let (ok, out) = check(&cfg, &SECRET_ENV[1..]);
    assert!(!ok, "missing HRX_PLATFORM_READ_URL must fail");
    assert!(
        out.contains("HRX_PLATFORM_READ_URL"),
        "output must name the missing env var:\n{out}"
    );

    // The identity secret env var is unset (run_engine_cli sets it; point at another name).
    let (ok, out) = check(
        &cfg.replace("\"HRX_IDENTITY_SECRET\"", "\"HRX_UNSET_IDENTITY_SECRET\""),
        &SECRET_ENV,
    );
    assert!(!ok, "an unset identity secret env var must fail");
    assert!(out.contains("HRX_UNSET_IDENTITY_SECRET"), "{out}");

    // Unknown source kind.
    let (ok, out) = check(
        &cfg.replace("kind = \"tempo\"", "kind = \"graphite\""),
        &SECRET_ENV,
    );
    assert!(!ok, "unknown kind must fail");
    assert!(
        out.contains("graphite"),
        "output must name the bad kind:\n{out}"
    );

    // Duplicate source names.
    let (ok, out) = check(
        &cfg.replace("name = \"tempo-production\"", "name = \"loki-production\""),
        &SECRET_ENV,
    );
    assert!(!ok, "duplicate source names must fail");
    assert!(out.contains("loki-production"), "{out}");

    // Two defaults for one kind.
    let two_defaults = cfg.replace(
        "[[sources]]\nname = \"loki-production\"",
        "[[sources]]\nname = \"prometheus-second\"\nkind = \"prometheus\"\nurl = \"http://127.0.0.1:9\"\ndefault = true\n\n[[sources]]\nname = \"loki-production\"",
    );
    let (ok, out) = check(&two_defaults, &SECRET_ENV);
    assert!(!ok, "two default prometheus sources must fail");
    assert!(out.to_lowercase().contains("default"), "{out}");

    // Audited sources without an [audit] table.
    let no_audit = cfg.split("[audit]").next().unwrap().to_string();
    let (ok, out) = check(&no_audit, &SECRET_ENV);
    assert!(!ok, "audited sources need [audit]");
    assert!(out.to_lowercase().contains("audit"), "{out}");

    // Not TOML at all.
    let (ok, _) = check("listen_pg = ", &SECRET_ENV);
    assert!(!ok, "unparseable TOML must fail");

    drop((held_pg, held_http));
}
