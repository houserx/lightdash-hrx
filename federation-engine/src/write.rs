//! Write Mode (CONTRACTS §4.2, engine side): `POST /v1/write` runs one guarded DML statement on
//! the Platform Database's write pool (the elevated role from `write_url_env`).
//!
//! Request `{statement, mode, confirmation_token, description, ticket}`, response
//! `{audit_id, rows_affected, preview, returning}`. A request is checked in this order, and the
//! first failure answers `{"error": message}` (contract assumption A7 in PROGRESS.md):
//!
//! 1. a valid bearer identity token (§3), else 401;
//! 2. Write Mode is configured (the Platform Database source has a `write_url_env`), else 503;
//! 3. a JSON object body with a string `statement`, else 400;
//! 4. the identity holds `attrs.platform_write`, else 403 naming it;
//! 5. a non-blank `description` and `mode` `preview` or `commit`, else 400;
//! 6. an agent identity only previews, else 403 naming `agent`;
//! 7. the write guard (§5), else the portal's status (400 for empty SQL, 422) and message;
//! 8. a confirmation token bound to this statement, user and project, unexpired, living at most
//!    120 s, signed with the identity secret (assumption A6), else 403;
//! 9. the token has not been used before, else 409. It is spent here, before the statement runs.
//!
//! A Preview then runs `BEGIN; <statement>; ROLLBACK` on one write-pool connection and returns
//! the rows affected and at most [`MAX_RETURNING`] `RETURNING` rows (`null` without a RETURNING
//! clause). Every request that passes the checks above is audited (§6) with `mode` `write`, also
//! when its statement fails or no write-pool connection could be had (as for platform reads);
//! the response's `audit_id` is the record's id. If the audit write fails, the result is not
//! returned: 500 with SQLSTATE 58000 "audit write failed". A statement Postgres rejects is 422
//! with its SQLSTATE and message.
//!
//! The statement is first prepared (Parse/Describe, extended protocol), which refuses more than
//! one statement whatever the guard decided, and gives the result's column types. It then runs
//! through the simple protocol, so every value comes back as Postgres prints it, and is turned
//! into JSON by its column type ([`json_value`]).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use datafusion::error::DataFusionError;
use engine_config::{Config, SourceKind, SourceSettings};
use engine_guard::Mode as GuardMode;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio_postgres::SimpleQueryMessage;
use tokio_postgres::types::Type;

use crate::audit::{self, AuditWriter, Execution};
use crate::identity::{self, Identity};
use crate::platform::{CancelOnDrop, Pool, pg_error};
use crate::session::SqlStateError;

/// At most this many write-pool connections are open at once.
const WRITE_POOL_SIZE: usize = 4;
/// A Preview returns at most this many `RETURNING` rows; `rows_affected` still counts all.
pub const MAX_RETURNING: usize = 100;
/// The longest lifetime (`exp - iat`) a confirmation token may have.
const MAX_CONFIRMATION_LIFETIME_SECS: i64 = 120;
/// How far in the future a confirmation token's `iat` may be (clock skew), as for identities.
const MAX_IAT_SKEW_SECS: i64 = 60;
/// The confirmation token's `typ`, which tells it apart from an identity token.
const CONFIRMATION_TYP: &str = "write_confirmation";

/// Write Mode's shared state: the write pool, the audit store and the spent confirmations.
pub struct WriteMode {
    identity_secret: Vec<u8>,
    /// `Err` holds why Write Mode is off.
    target: Result<Target, String>,
    audit: Option<AuditWriter>,
    /// Confirmation tokens already used (by signature), with their `exp`. Entries are dropped
    /// once expired: an expired token is refused anyway.
    spent: Mutex<HashMap<String, i64>>,
}

/// Where writes run: the default Platform Database source's write URL.
struct Target {
    source: String,
    pool: Arc<Pool>,
}

impl WriteMode {
    pub fn new(config: &Config, connect_timeout: Duration) -> WriteMode {
        WriteMode {
            identity_secret: config.identity_secret.expose().as_bytes().to_vec(),
            target: Target::from_config(config, connect_timeout),
            audit: config
                .audit
                .clone()
                .map(|a| AuditWriter::new(a, connect_timeout)),
            spent: Mutex::default(),
        }
    }

    /// Marks the confirmation token with signature `signature` used. False if it already was.
    fn spend(&self, signature: &str, exp: i64, now: i64) -> bool {
        let mut spent = self.spent.lock().unwrap_or_else(|e| e.into_inner());
        spent.retain(|_, until| *until > now);
        if spent.contains_key(signature) {
            return false;
        }
        spent.insert(signature.to_string(), exp);
        true
    }
}

impl Target {
    fn from_config(config: &Config, connect_timeout: Duration) -> Result<Target, String> {
        let source = config
            .default_source(SourceKind::PlatformPostgres)
            .ok_or("Write Mode is off: there is no default platform_postgres source")?;
        match &source.settings {
            SourceSettings::PlatformPostgres {
                write_url: Some(url),
                ..
            } => Ok(Target {
                source: source.name.clone(),
                pool: Arc::new(Pool::new(
                    &source.name,
                    url,
                    WRITE_POOL_SIZE,
                    connect_timeout,
                )),
            }),
            _ => Err(format!(
                "Write Mode is off: source \"{}\" has no write_url_env",
                source.name
            )),
        }
    }
}

/// A refused or failed request: its HTTP status, message and, when there is one, SQLSTATE.
#[derive(Debug, PartialEq)]
struct Failure {
    status: StatusCode,
    message: String,
    sqlstate: Option<String>,
}

impl Failure {
    fn new(status: StatusCode, message: impl Into<String>) -> Failure {
        Failure {
            status,
            message: message.into(),
            sqlstate: None,
        }
    }

    fn audit_write_failed(cause: &str) -> Failure {
        eprintln!("engine: audit write failed: {cause}");
        Failure {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "audit write failed".to_string(),
            sqlstate: Some("58000".to_string()),
        }
    }

    /// An error from the write pool or the Platform Database: a statement Postgres rejected is
    /// the client's (422); a connection that could not be had or was lost is 503.
    fn from_postgres(e: &DataFusionError) -> Failure {
        let (code, message) = match e.find_root() {
            DataFusionError::External(inner) => match inner.downcast_ref::<SqlStateError>() {
                Some(e) => (e.code.to_string(), e.message.clone()),
                None => ("XX000".to_string(), e.to_string()),
            },
            other => ("XX000".to_string(), other.to_string()),
        };
        let status = if code.starts_with("08") || code.starts_with("53") {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::UNPROCESSABLE_ENTITY
        };
        Failure {
            status,
            message,
            sqlstate: Some(code),
        }
    }
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        let mut body = json!({"error": self.message});
        if let Some(code) = self.sqlstate {
            body["sqlstate"] = json!(code);
        }
        (self.status, Json(body)).into_response()
    }
}

/// `POST /v1/write`.
pub async fn handle(
    State(write): State<Arc<WriteMode>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match run(&write, &headers, &body).await {
        Ok(result) => Json(result).into_response(),
        Err(failure) => failure.into_response(),
    }
}

/// The request's body fields.
struct Request {
    statement: String,
    mode: Option<String>,
    confirmation_token: Option<String>,
    description: Option<String>,
    ticket: Option<String>,
}

impl Request {
    fn parse(body: &[u8]) -> Result<Request, Failure> {
        let bad = |m: &str| Failure::new(StatusCode::BAD_REQUEST, m);
        let body: Value =
            serde_json::from_slice(body).map_err(|_| bad("the body must be a JSON object"))?;
        let Value::Object(body) = body else {
            return Err(bad("the body must be a JSON object"));
        };
        let text = |name: &str| body.get(name).and_then(Value::as_str).map(str::to_string);
        let non_blank = |name: &str| text(name).filter(|s| !s.trim().is_empty());
        Ok(Request {
            statement: text("statement").ok_or_else(|| bad("statement must be a string"))?,
            mode: text("mode"),
            confirmation_token: text("confirmation_token"),
            description: non_blank("description"),
            ticket: non_blank("ticket"),
        })
    }
}

async fn run(write: &WriteMode, headers: &HeaderMap, body: &[u8]) -> Result<Value, Failure> {
    let now = chrono::Utc::now().timestamp();
    let identity = bearer(headers)
        .and_then(|token| identity::verify(token, &write.identity_secret, now))
        .ok_or_else(|| {
            Failure::new(
                StatusCode::UNAUTHORIZED,
                "Write Mode needs a valid identity token (Authorization: Bearer)",
            )
        })?;
    let target = write
        .target
        .as_ref()
        .map_err(|why| Failure::new(StatusCode::SERVICE_UNAVAILABLE, why.clone()))?;
    let request = Request::parse(body)?;
    if !identity.platform_write {
        return Err(Failure::new(
            StatusCode::FORBIDDEN,
            "Write Mode needs platform_write",
        ));
    }
    let Some(description) = request.description.as_deref() else {
        return Err(Failure::new(
            StatusCode::BAD_REQUEST,
            "a write requires a description",
        ));
    };
    let preview = match request.mode.as_deref() {
        Some("preview") => true,
        Some("commit") => false,
        _ => {
            return Err(Failure::new(
                StatusCode::BAD_REQUEST,
                "mode must be \"preview\" or \"commit\"",
            ));
        }
    };
    if !preview && identity.agent {
        return Err(Failure::new(
            StatusCode::FORBIDDEN,
            "an AI agent identity (agent = true) may only Preview, never commit",
        ));
    }
    if !preview {
        // eng-write-commit builds this; refuse before anything is checked or spent.
        return Err(Failure::new(
            StatusCode::NOT_IMPLEMENTED,
            "mode \"commit\" is not available yet",
        ));
    }
    let sql = engine_guard::guard(&request.statement, GuardMode::Write).map_err(|r| {
        Failure::new(
            StatusCode::from_u16(r.status).unwrap_or(StatusCode::UNPROCESSABLE_ENTITY),
            r.message,
        )
    })?;
    let confirmation = request
        .confirmation_token
        .as_deref()
        .and_then(|token| {
            verify_confirmation(token, &request.statement, &identity, &write.identity_secret, now)
        })
        .ok_or_else(|| {
            Failure::new(
                StatusCode::FORBIDDEN,
                "the confirmation token is missing or not valid for this statement, user and \
                 project",
            )
        })?;
    if !write.spend(&confirmation.signature, confirmation.exp, now) {
        return Err(Failure::new(
            StatusCode::CONFLICT,
            "this confirmation token has already been used",
        ));
    }
    let Some(writer) = &write.audit else {
        return Err(Failure::audit_write_failed("no [audit] store is configured"));
    };

    let started = Instant::now();
    let result = preview_statement(target, &sql).await;
    let message;
    let outcome = match &result {
        Ok(ran) => Ok(ran.rows_affected),
        Err(e) => {
            message = Failure::from_postgres(e).message;
            Err(message.as_str())
        }
    };
    let sources = [target.source.clone()];
    let execution = Execution {
        identity: &identity,
        sql: &request.statement,
        sources: &sources,
        outcome,
        duration: started.elapsed(),
        mode: audit::Mode::Write,
        preview,
        description: Some(description),
        ticket: request.ticket.as_deref(),
    };
    let audit_id = writer
        .write(&execution)
        .await
        .map_err(|e| Failure::audit_write_failed(&e))?;
    let ran = result.map_err(|e| Failure::from_postgres(&e))?;
    Ok(json!({
        "audit_id": audit_id,
        "rows_affected": ran.rows_affected,
        "preview": preview,
        "returning": ran.returning,
    }))
}

/// The token in `Authorization: Bearer <token>`.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.trim().split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}

/// A valid confirmation token: what is needed to spend it.
#[derive(Debug, PartialEq)]
struct Confirmation {
    signature: String,
    exp: i64,
}

/// Checks a confirmation token (assumption A6): the identity token's envelope signed with the
/// identity secret, `v` 1, `typ` `write_confirmation`, `statement_sha256` the hex SHA-256 of
/// `statement` as sent, `sub` and `project` those of the bearer identity, unexpired, `iat` at
/// most 60 s ahead, lifetime at most 120 s, and a nonce.
fn verify_confirmation(
    token: &str,
    statement: &str,
    identity: &Identity,
    secret: &[u8],
    now: i64,
) -> Option<Confirmation> {
    let claims = identity::signed_payload(token, secret)?;
    let text = |name: &str| claims.get(name).and_then(Value::as_str);
    let iat = claims.get("iat").and_then(Value::as_i64)?;
    let exp = claims.get("exp").and_then(Value::as_i64)?;
    let valid = claims.get("v").and_then(Value::as_i64) == Some(1)
        && text("typ") == Some(CONFIRMATION_TYP)
        && text("statement_sha256") == Some(&hex::encode(Sha256::digest(statement.as_bytes())))
        && text("sub") == Some(identity.sub.as_str())
        && identity.project.is_some()
        && text("project") == identity.project.as_deref()
        && text("nonce").is_some_and(|n| !n.is_empty())
        && now < exp
        && iat <= now + MAX_IAT_SKEW_SECS
        && exp - iat <= MAX_CONFIRMATION_LIFETIME_SECS;
    let (_, signature) = token.trim().split_once('.')?;
    valid.then(|| Confirmation {
        signature: signature.to_string(),
        exp,
    })
}

/// What a statement did.
#[derive(Debug)]
struct Ran {
    rows_affected: usize,
    /// At most [`MAX_RETURNING`] rows, or null when the statement returns no columns.
    returning: Value,
}

/// Runs `sql` in a transaction that is always rolled back, on one write-pool connection. The
/// connection goes back to the pool only after a clean rollback; otherwise it is closed, which
/// ends the transaction too. If the request goes away mid-statement, the backend is cancelled.
async fn preview_statement(target: &Target, sql: &str) -> Result<Ran, DataFusionError> {
    let error = |e| pg_error(&target.source, e);
    let client = target.pool.acquire().await?;
    let mut running = CancelOnDrop(Some(client.cancel_token()));
    client.batch_execute("BEGIN").await.map_err(error)?;
    // Parse/Describe only: one statement at most, and the result's column types.
    let statement = client.prepare(sql).await.map_err(error)?;
    let types: Vec<Type> = statement.columns().iter().map(|c| c.type_().clone()).collect();
    drop(statement);
    let messages = client.simple_query(sql).await.map_err(error)?;
    client.batch_execute("ROLLBACK").await.map_err(error)?;
    running.finished();
    client.release().await;

    let mut rows = vec![];
    let mut rows_affected = 0;
    for message in messages {
        match message {
            SimpleQueryMessage::Row(row) if rows.len() < MAX_RETURNING => {
                let mut object = Map::new();
                for (i, column) in row.columns().iter().enumerate() {
                    let ty = types.get(i).unwrap_or(&Type::TEXT);
                    object.insert(column.name().to_string(), json_value(ty, row.get(i)));
                }
                rows.push(Value::Object(object));
            }
            SimpleQueryMessage::CommandComplete(n) => {
                rows_affected = usize::try_from(n).unwrap_or(usize::MAX);
            }
            _ => {}
        }
    }
    let returning = if types.is_empty() {
        Value::Null
    } else {
        Value::Array(rows)
    };
    Ok(Ran {
        rows_affected,
        returning,
    })
}

/// A value as Postgres prints it, as JSON by its column type: booleans and integers natively,
/// floats as numbers when finite, `json`/`jsonb` parsed, everything else (including `numeric`,
/// to stay exact) as the text Postgres printed. SQL NULL is null.
fn json_value(ty: &Type, text: Option<&str>) -> Value {
    let Some(text) = text else {
        return Value::Null;
    };
    let as_text = || Value::String(text.to_string());
    match *ty {
        Type::BOOL => match text {
            "t" => Value::Bool(true),
            "f" => Value::Bool(false),
            _ => as_text(),
        },
        Type::INT2 | Type::INT4 | Type::INT8 | Type::OID => {
            text.parse::<i64>().map(Value::from).unwrap_or_else(|_| as_text())
        }
        Type::FLOAT4 | Type::FLOAT8 => text
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(as_text),
        Type::JSON | Type::JSONB => serde_json::from_str(text).unwrap_or_else(|_| as_text()),
        _ => as_text(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use hmac::{Hmac, Mac};

    const SECRET: &[u8] = b"secret-not-real";
    const NOW: i64 = 1_767_225_600;

    fn mint(payload: &Value, secret: &[u8]) -> String {
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let p = b64.encode(serde_json::to_vec(payload).unwrap());
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret).unwrap();
        mac.update(p.as_bytes());
        format!("{p}.{}", b64.encode(mac.finalize().into_bytes()))
    }

    fn identity() -> Identity {
        Identity {
            sub: "u-1".into(),
            email: "a@example.com".into(),
            agent: false,
            sys: false,
            telemetry_restricted: false,
            platform_read: false,
            platform_explain: false,
            platform_write: true,
            project: Some("p-1".into()),
            description: None,
            ticket: None,
        }
    }

    fn payload(stmt: &str) -> Value {
        json!({"v": 1, "typ": "write_confirmation",
               "statement_sha256": hex::encode(Sha256::digest(stmt.as_bytes())),
               "sub": "u-1", "project": "p-1", "iat": NOW, "exp": NOW + 120, "nonce": "n"})
    }

    #[test]
    fn confirmations_are_bound_to_statement_user_project_and_time() {
        let stmt = "UPDATE w SET a = 1";
        let id = identity();
        let ok = mint(&payload(stmt), SECRET);
        let c = verify_confirmation(&ok, stmt, &id, SECRET, NOW).expect("valid");
        assert_eq!(c.exp, NOW + 120);
        assert!(verify_confirmation(&ok, "UPDATE w SET a = 2", &id, SECRET, NOW).is_none());
        assert!(verify_confirmation(&ok, stmt, &id, b"other", NOW).is_none());
        assert!(verify_confirmation(&ok, stmt, &id, SECRET, NOW + 120).is_none());
        let other_user = Identity {
            sub: "u-2".into(),
            ..identity()
        };
        assert!(verify_confirmation(&ok, stmt, &other_user, SECRET, NOW).is_none());
        let no_project = Identity {
            project: None,
            ..identity()
        };
        assert!(verify_confirmation(&ok, stmt, &no_project, SECRET, NOW).is_none());
        for (key, value) in [
            ("typ", json!("identity")),
            ("v", json!(2)),
            ("project", json!("p-2")),
            ("exp", json!(NOW + 121)),
            ("iat", json!(NOW + 61)),
            ("nonce", json!("")),
        ] {
            let mut p = payload(stmt);
            p[key] = value;
            let token = mint(&p, SECRET);
            assert!(
                verify_confirmation(&token, stmt, &id, SECRET, NOW).is_none(),
                "{key}"
            );
        }
        assert!(verify_confirmation("garbage", stmt, &id, SECRET, NOW).is_none());
    }

    #[test]
    fn values_become_json_by_column_type() {
        assert_eq!(json_value(&Type::INT8, Some("42")), json!(42));
        assert_eq!(json_value(&Type::BOOL, Some("t")), json!(true));
        assert_eq!(json_value(&Type::FLOAT8, Some("1.5")), json!(1.5));
        assert_eq!(json_value(&Type::FLOAT8, Some("NaN")), json!("NaN"));
        assert_eq!(json_value(&Type::NUMERIC, Some("1.10")), json!("1.10"));
        assert_eq!(json_value(&Type::JSONB, Some(r#"{"a": 1}"#)), json!({"a": 1}));
        assert_eq!(json_value(&Type::TEXT, Some("x")), json!("x"));
        assert_eq!(json_value(&Type::TEXT, None), Value::Null);
    }
}
