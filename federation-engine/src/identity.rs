//! Identity tokens (CONTRACTS §3) and the access rules for Restricted Telemetry and the Platform
//! Database (§1.2).
//!
//! A client sends `SET hrx.identity = '<token>'` before each query. The token is
//! `<base64url(payload_json)>.<base64url(HMAC-SHA256(secret, base64url(payload_json)))>`. It is
//! verified each time a statement is planned or executed; a token that fails any check counts as
//! no identity at all, never as a partial one.
//!
//! Planning a statement puts an [`Access`] into the DataFusion session config. A table function
//! that picks a restricted source asks it with [`Access::require_restricted`] (the Platform
//! Database: [`Access::require`] with [`Claim::PlatformRead`]), which refuses with SQLSTATE 42501
//! or remembers the source, so the statement becomes an Audited Query (§6).

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use datafusion::catalog::Session;
use datafusion::error::DataFusionError;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

use crate::session::{Settings, sqlstate};

/// The session setting that carries the identity token.
pub const IDENTITY_SETTING: &str = "hrx.identity";

/// How far in the future `iat` may be (clock skew).
const MAX_IAT_SKEW_SECS: i64 = 60;
/// The longest lifetime (`exp - iat`) a token may have.
const MAX_LIFETIME_SECS: i64 = 300;

/// A verified identity: the claims the engine acts on.
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub sub: String,
    pub email: String,
    /// `agent = true`, or a token minted by the MCP server (`iss = telemetry-mcp`).
    pub agent: bool,
    /// The system identity (`sys = true`). It counts as `agent = false` (§1.2).
    pub sys: bool,
    pub telemetry_restricted: bool,
    /// `attrs.platform_read`: may read the Platform Database (agents too, §1.2).
    pub platform_read: bool,
    /// `audit.description`, when it is a non-blank string.
    pub description: Option<String>,
    /// `audit.ticket`, when it is a non-blank string.
    pub ticket: Option<String>,
}

impl Identity {
    /// The identity in a session's `hrx.identity`, if it holds a valid token.
    pub fn of(settings: &Settings, secret: &[u8]) -> Option<Identity> {
        let token = settings.get(IDENTITY_SETTING)?;
        verify(token, secret, chrono::Utc::now().timestamp())
    }

    /// The portal's `action` for a query by this identity (§6).
    pub fn action(&self) -> &'static str {
        if self.agent {
            "ai_ask"
        } else if self.sys {
            "assertion"
        } else {
            "query"
        }
    }

    /// May this identity run an Audited Query on Restricted Telemetry source `source`?
    pub fn check_restricted(
        identity: Option<&Identity>,
        source: &str,
    ) -> Result<(), DataFusionError> {
        // AI agents (and every MCP token) never read it, whatever their attrs say (§2, §8).
        // The system identity is not an agent and is checked like a person.
        if identity.is_some_and(|id| id.agent) {
            return Err(sqlstate(
                "42501",
                format!(
                    "source \"{source}\" is Restricted Telemetry, which an AI agent identity \
                     (agent = true) may never read"
                ),
            ));
        }
        let Some(id) = identity.filter(|id| id.telemetry_restricted) else {
            return Err(sqlstate(
                "42501",
                format!(
                    "source \"{source}\" is Restricted Telemetry and needs telemetry_restricted"
                ),
            ));
        };
        if id.description.is_none() {
            return Err(sqlstate(
                "42501",
                "audited query requires a description".to_string(),
            ));
        }
        Ok(())
    }

    /// May this identity run an Audited Query that needs `claim` on source `source`?
    pub fn check(
        identity: Option<&Identity>,
        source: &str,
        claim: Claim,
    ) -> Result<(), DataFusionError> {
        match claim {
            Claim::TelemetryRestricted => Identity::check_restricted(identity, source),
            Claim::PlatformRead => {
                let Some(id) = identity.filter(|id| id.platform_read) else {
                    return Err(sqlstate(
                        "42501",
                        format!(
                            "source \"{source}\" is the Platform Database and needs platform_read"
                        ),
                    ));
                };
                if id.description.is_none() {
                    return Err(sqlstate(
                        "42501",
                        "audited query requires a description".to_string(),
                    ));
                }
                Ok(())
            }
        }
    }
}

/// The claim an Audited Query needs on the source it reads (§1.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    /// Restricted Telemetry: `attrs.telemetry_restricted`, never an agent.
    TelemetryRestricted,
    /// The Platform Database: `attrs.platform_read`.
    PlatformRead,
}

/// A source an Audited Query reads, and the claim reading it needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditedRead {
    pub source: String,
    pub claim: Claim,
}

/// Verifies a token against `secret` at `now` (epoch seconds). `None` unless the signature
/// matches, `v` is 1, `exp` has not passed, `iat` is at most 60 s ahead, the lifetime is at most
/// 300 s, and `sub` and `email` are strings.
pub fn verify(token: &str, secret: &[u8], now: i64) -> Option<Identity> {
    let (payload, signature) = token.trim().split_once('.')?;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let signature = b64.decode(signature).ok()?;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature).ok()?;
    let claims: Value = serde_json::from_slice(&b64.decode(payload).ok()?).ok()?;
    if claims.get("v").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    let iat = claims.get("iat").and_then(Value::as_i64)?;
    let exp = claims.get("exp").and_then(Value::as_i64)?;
    if now >= exp || iat > now + MAX_IAT_SKEW_SECS || exp - iat > MAX_LIFETIME_SECS {
        return None;
    }
    let text = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    };
    let audit = claims.get("audit");
    let attr =
        |name: &str| claims.get("attrs").and_then(|a| a.get(name)) == Some(&Value::Bool(true));
    Some(Identity {
        sub: text(claims.get("sub"))?,
        email: text(claims.get("email"))?,
        // Anything but an explicit `false` is an agent: unclear tokens get less access.
        agent: claims.get("agent") != Some(&Value::Bool(false))
            || claims.get("iss").and_then(Value::as_str) == Some("telemetry-mcp"),
        sys: claims.get("sys") == Some(&Value::Bool(true)),
        telemetry_restricted: attr("telemetry_restricted"),
        platform_read: attr("platform_read"),
        description: text(audit.and_then(|a| a.get("description"))),
        ticket: text(audit.and_then(|a| a.get("ticket"))),
    })
}

/// What one statement may read, put into its DataFusion session config while it is planned.
#[derive(Debug, Default)]
pub struct Access {
    identity: Option<Identity>,
    /// Audited sources the statement reads, in the order it names them, without repeats.
    audited: Mutex<Vec<AuditedRead>>,
}

impl Access {
    pub fn new(identity: Option<Identity>) -> Access {
        Access {
            identity,
            audited: Mutex::default(),
        }
    }

    /// Lets a table function read restricted source `source` (42501 otherwise), and makes the
    /// statement an Audited Query. A session without an [`Access`] gets no access.
    pub fn require_restricted(session: &dyn Session, source: &str) -> Result<(), DataFusionError> {
        Access::require(session, source, Claim::TelemetryRestricted)
    }

    /// Lets a table function read `source` when the session's identity has `claim` (42501
    /// otherwise), and makes the statement an Audited Query. A session without an [`Access`]
    /// gets no access.
    pub fn require(
        session: &dyn Session,
        source: &str,
        claim: Claim,
    ) -> Result<(), DataFusionError> {
        let access: Option<Arc<Access>> = session.config().get_extension();
        let identity = access.as_ref().and_then(|a| a.identity.as_ref());
        Identity::check(identity, source, claim)?;
        if let Some(access) = access {
            let mut audited = access.audited.lock().unwrap_or_else(|e| e.into_inner());
            let read = AuditedRead {
                source: source.to_string(),
                claim,
            };
            if !audited.contains(&read) {
                audited.push(read);
            }
        }
        Ok(())
    }

    /// The audited sources the planned statement reads.
    pub fn audited(&self) -> Vec<AuditedRead> {
        self.audited
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SECRET: &[u8] = b"unit-test-secret-not-real";
    const NOW: i64 = 1_762_560_000;

    fn mint(claims: &Value, secret: &[u8]) -> String {
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let payload = b64.encode(serde_json::to_vec(claims).unwrap());
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret).unwrap();
        mac.update(payload.as_bytes());
        format!("{payload}.{}", b64.encode(mac.finalize().into_bytes()))
    }

    fn claims() -> Value {
        json!({"v": 1, "iss": "lightdash", "sub": "u-1", "email": "a@example.com",
               "agent": false, "sys": false,
               "attrs": {"telemetry_restricted": true},
               "audit": {"description": "why", "ticket": null},
               "iat": NOW, "exp": NOW + 300})
    }

    fn with(key: &str, v: Value) -> Value {
        let mut c = claims();
        c[key] = v;
        c
    }

    #[test]
    fn valid_tokens_carry_their_claims() {
        let id = verify(&mint(&claims(), SECRET), SECRET, NOW).unwrap();
        assert_eq!(id.sub, "u-1");
        assert_eq!(id.email, "a@example.com");
        assert!(id.telemetry_restricted && !id.agent && !id.sys);
        assert_eq!(id.description.as_deref(), Some("why"));
        assert_eq!(id.ticket, None);
        assert_eq!(id.action(), "query");
        // iat up to 60 s ahead is clock skew.
        let skewed = with("iat", json!(NOW + 60));
        let skewed = {
            let mut c = skewed;
            c["exp"] = json!(NOW + 300);
            c
        };
        assert!(verify(&mint(&skewed, SECRET), SECRET, NOW).is_some());
    }

    #[test]
    fn anything_else_is_no_identity() {
        let ok = mint(&claims(), SECRET);
        let rejected = [
            mint(&claims(), b"another-secret"),
            mint(&with("v", json!(2)), SECRET),
            mint(&with("exp", json!(NOW)), SECRET),
            mint(&with("iat", json!(NOW + 61)), SECRET),
            mint(&with("exp", json!(NOW + 301)), SECRET),
            mint(&with("sub", Value::Null), SECRET),
            format!("{ok}x"),
            ok.replace('.', ""),
            String::new(),
        ];
        for t in rejected {
            assert_eq!(verify(&t, SECRET, NOW), None, "{t}");
        }
    }

    #[test]
    fn agents_and_missing_descriptions_cannot_read_restricted_sources() {
        let id = |c: Value| verify(&mint(&c, SECRET), SECRET, NOW);
        let code = |r: Result<(), DataFusionError>| match r {
            Err(DataFusionError::External(e)) => e.to_string(),
            other => panic!("{other:?}"),
        };
        assert!(Identity::check_restricted(id(claims()).as_ref(), "s").is_ok());
        assert!(code(Identity::check_restricted(None, "s")).contains("telemetry_restricted"));
        for agent in [with("agent", json!(true)), with("iss", json!("telemetry-mcp"))] {
            let agent = id(agent).unwrap();
            assert_eq!(agent.action(), "ai_ask");
            let refusal = code(Identity::check_restricted(Some(&agent), "s"));
            assert!(refusal.contains("agent"), "{refusal}");
        }
        let system = id(with("sys", json!(true))).unwrap();
        assert!(Identity::check_restricted(Some(&system), "s").is_ok());
        let quiet = id(with("audit", json!({"description": "  "}))).unwrap();
        assert!(code(Identity::check_restricted(Some(&quiet), "s")).contains("description"));
        assert_eq!(id(with("sys", json!(true))).unwrap().action(), "assertion");
    }

    #[test]
    fn the_platform_database_needs_platform_read_and_a_description() {
        let id = |c: Value| verify(&mint(&c, SECRET), SECRET, NOW);
        let check = |c: Value| Identity::check(id(c).as_ref(), "p", Claim::PlatformRead);
        let code = |r: Result<(), DataFusionError>| match r {
            Err(DataFusionError::External(e)) => e.to_string(),
            other => panic!("{other:?}"),
        };
        let reader = with("attrs", json!({"platform_read": true}));
        assert!(check(reader.clone()).is_ok());
        // Agents may read it (MCP platform_query); the attr is what counts.
        let mut agent = reader.clone();
        agent["agent"] = json!(true);
        assert!(check(agent).is_ok());
        assert!(code(check(claims())).contains("platform_read"));
        let stringly = with("attrs", json!({"platform_read": "true"}));
        assert!(code(check(stringly)).contains("platform_read"));
        assert!(code(Identity::check(None, "p", Claim::PlatformRead)).contains("platform_read"));
        let mut quiet = reader;
        quiet["audit"] = json!({"description": ""});
        assert!(code(check(quiet)).contains("description"));
    }
}
