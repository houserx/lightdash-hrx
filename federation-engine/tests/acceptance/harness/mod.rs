//! Shared acceptance harness. Everything here drives the real `engine` binary from the outside:
//! pg-wire (tokio-postgres or the raw client in `raw_pg`), HTTP (reqwest), and mock upstreams on
//! ephemeral 127.0.0.1 ports. Nothing here links engine code.
#![allow(dead_code)]

pub mod aws;
pub mod bigquery;
pub mod engine;
pub mod mock_http;
pub mod pg_cluster;
pub mod raw_pg;
pub mod telemetry;
pub mod tokens;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

pub use engine::{Cfg, Engine};
pub use mock_http::{MockServer, Recorded, Reply};
pub use pg_cluster::PgCluster;
pub use tokens::{Identity, confirmation_token};

/// HMAC key for identity and confirmation tokens (env `HRX_IDENTITY_SECRET` in every engine).
pub const IDENTITY_SECRET: &str = "test-identity-secret-not-real";
/// The standard pg-wire login (env `HRX_PG_PASSWORD_OPERATIONS`).
pub const PG_USER: &str = "lightdash-operations";
pub const PG_PASSWORD: &str = "test-password-not-real";
/// Audit HMAC key (env `AUDIT_INTEGRITY_KEY`).
pub const AUDIT_KEY: &str = "test-integrity-key-not-real";
/// Fake static AWS credentials for the default credential chain.
pub const AWS_KEY_ID: &str = "AKIDTESTNOTREAL00001";
pub const AWS_SECRET: &str = "test-aws-secret-not-real";

/// `<repo>/tmp/acceptance`, gitignored.
pub fn tmp_root() -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tmp")
        .join("acceptance");
    std::fs::create_dir_all(&p).expect("create tmp/acceptance");
    p
}

/// A fresh directory under `tmp/acceptance`.
pub fn unique_dir(prefix: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let d = tmp_root().join(format!(
        "{prefix}-{}-{n}-{}",
        std::process::id(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    std::fs::create_dir_all(&d).expect("create unique dir");
    d
}

/// A free ephemeral port on 127.0.0.1 (bind to 0, read it back, release it).
pub fn free_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 0");
    l.local_addr().unwrap().port()
}

/// SQLSTATE and message of a failed tokio-postgres call. Panics if the call succeeded or the
/// error is not a server error.
pub fn db_error<T: std::fmt::Debug>(r: Result<T, tokio_postgres::Error>) -> (String, String) {
    match r {
        Ok(v) => panic!("expected a database error, got success: {v:?}"),
        Err(e) => match e.as_db_error() {
            Some(db) => (db.code().code().to_string(), db.message().to_string()),
            None => panic!("expected a database error with a SQLSTATE, got: {e}"),
        },
    }
}

/// Asserts a call failed with `sqlstate`, and that its message contains `needle` (case-insensitive).
pub fn assert_sqlstate<T: std::fmt::Debug>(
    r: Result<T, tokio_postgres::Error>,
    sqlstate: &str,
    needle: &str,
) -> String {
    let (code, msg) = db_error(r);
    assert_eq!(code, sqlstate, "wrong SQLSTATE; message was: {msg}");
    assert!(
        msg.to_lowercase().contains(&needle.to_lowercase()),
        "message {msg:?} should contain {needle:?}"
    );
    msg
}

/// Doubles single quotes so `s` can sit inside a SQL string literal.
pub fn sql_lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Current unix time in seconds.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Parses a Prometheus/Loki/Tempo time parameter: unix seconds (int or float), unix nanoseconds,
/// or RFC 3339. Returns unix seconds as f64.
pub fn parse_time_param(v: &str) -> f64 {
    if let Ok(f) = v.parse::<f64>() {
        if f > 1e15 {
            return f / 1e9;
        }
        return f;
    }
    chrono::DateTime::parse_from_rfc3339(v)
        .unwrap_or_else(|e| panic!("time param {v:?} is neither a number nor RFC 3339: {e}"))
        .timestamp_millis() as f64
        / 1000.0
}

/// Parses a Prometheus duration string or a plain number of seconds into seconds.
pub fn parse_duration_param(v: &str) -> f64 {
    if let Ok(f) = v.parse::<f64>() {
        return f;
    }
    let mut total = 0.0;
    let mut num = String::new();
    let chars: Vec<char> = v.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
            i += 1;
            continue;
        }
        let unit: String = if c == 'm' && chars.get(i + 1) == Some(&'s') {
            i += 2;
            "ms".into()
        } else {
            i += 1;
            c.to_string()
        };
        let n: f64 = num.parse().unwrap_or_else(|_| panic!("bad duration {v:?}"));
        num.clear();
        total += n * match unit.as_str() {
            "ms" => 0.001,
            "s" => 1.0,
            "m" => 60.0,
            "h" => 3600.0,
            "d" => 86400.0,
            "w" => 604800.0,
            "y" => 31536000.0,
            _ => panic!("bad duration unit in {v:?}"),
        };
    }
    total
}

/// A connected tokio-postgres client for the standard login, for tests that only need one.
pub async fn connect(engine: &Engine) -> tokio_postgres::Client {
    engine.connect().await
}

/// Runs `SET hrx.identity = '<token>'` on `client`.
pub async fn set_identity(client: &tokio_postgres::Client, token: &str) {
    client
        .batch_execute(&format!("SET hrx.identity = {}", sql_lit(token)))
        .await
        .expect("SET hrx.identity is accepted");
}

/// Reads a text column by name from every row (simple-protocol rows).
pub fn simple_rows(msgs: Vec<tokio_postgres::SimpleQueryMessage>) -> Vec<Vec<Option<String>>> {
    msgs.into_iter()
        .filter_map(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(r) => Some(
                (0..r.len())
                    .map(|i| r.get(i).map(|s| s.to_string()))
                    .collect(),
            ),
            _ => None,
        })
        .collect()
}
