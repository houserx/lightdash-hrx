//! Identity tokens (CONTRACTS.md §3), Write Mode confirmation tokens (contract assumption, see
//! PROGRESS.md), and the portal's audit integrity hash.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::*;

pub fn b64url(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).unwrap();
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

/// `<base64url(payload_json)>.<base64url(HMAC-SHA256(secret, base64url(payload_json)))>`
pub fn mint_token(payload: &Value, secret: &str) -> String {
    let p = b64url(&serde_json::to_vec(payload).unwrap());
    let sig = b64url(&hmac_sha256(secret.as_bytes(), p.as_bytes()));
    format!("{p}.{sig}")
}

pub const PERSON_SUB: &str = "00000000-0000-4000-8000-000000000001";
pub const PERSON_EMAIL: &str = "test.person@example.com";
pub const ORG_UUID: &str = "00000000-0000-4000-8000-0000000000aa";
pub const PROJECT_UUID: &str = "00000000-0000-4000-8000-0000000000bb";

/// Builder for §3 identity token payloads.
#[derive(Clone, Debug)]
pub struct Identity {
    pub claims: Value,
}

impl Identity {
    /// A person from Lightdash: v1, agent=false, sys=false, every attr false, no description,
    /// iat = now, exp = now + 300.
    pub fn person() -> Identity {
        let now = now_secs();
        Identity {
            claims: json!({
                "v": 1, "iss": "lightdash", "sub": PERSON_SUB, "email": PERSON_EMAIL,
                "org": ORG_UUID, "project": PROJECT_UUID, "agent": false, "sys": false,
                "attrs": {"telemetry_restricted": false, "platform_read": false,
                          "platform_write": false, "platform_explain": false},
                "audit": {"description": null, "ticket": null, "source": "investigate",
                          "resource_uuid": null},
                "iat": now, "exp": now + 300,
                "nonce": b64url(uuid::Uuid::new_v4().as_bytes()),
            }),
        }
    }
    /// The alert evaluator's system identity (`sys = true`, source `alert_rule`).
    pub fn system() -> Identity {
        Identity::person()
            .set("sub", json!("system:alert-evaluator"))
            .set("email", json!("system@example.com"))
            .set("sys", json!(true))
            .audit("source", json!("alert_rule"))
    }
    /// The MCP server minting for an agent (`iss = telemetry-mcp`, `agent = true`).
    pub fn mcp_agent() -> Identity {
        Identity::person()
            .set("iss", json!("telemetry-mcp"))
            .set("agent", json!(true))
            .audit("source", json!("mcp"))
    }
    pub fn set(mut self, key: &str, v: Value) -> Identity {
        self.claims[key] = v;
        self
    }
    pub fn attr(mut self, key: &str, on: bool) -> Identity {
        self.claims["attrs"][key] = json!(on);
        self
    }
    pub fn audit(mut self, key: &str, v: Value) -> Identity {
        self.claims["audit"][key] = v;
        self
    }
    pub fn description(self, d: &str) -> Identity {
        self.audit("description", json!(d))
    }
    pub fn ticket(self, t: &str) -> Identity {
        self.audit("ticket", json!(t))
    }
    pub fn agent(self, on: bool) -> Identity {
        self.set("agent", json!(on))
    }
    /// Shifts iat and exp (seconds relative to now).
    pub fn times(self, iat_offset: i64, exp_offset: i64) -> Identity {
        let now = now_secs();
        self.set("iat", json!(now + iat_offset))
            .set("exp", json!(now + exp_offset))
    }
    pub fn sub(&self) -> String {
        self.claims["sub"].as_str().unwrap().to_string()
    }
    pub fn email(&self) -> String {
        self.claims["email"].as_str().unwrap().to_string()
    }
    pub fn token(&self) -> String {
        mint_token(&self.claims, IDENTITY_SECRET)
    }
    pub fn token_with_secret(&self, secret: &str) -> String {
        mint_token(&self.claims, secret)
    }
}

/// Write Mode confirmation token (contract assumption A6 in PROGRESS.md): same envelope as the
/// identity token, signed with the identity secret, payload
/// `{"v":1,"typ":"write_confirmation","statement_sha256":<hex sha256 of the statement's UTF-8>,
///   "sub":<user>,"project":<project uuid>,"iat":<s>,"exp":<s, ≤ iat+120>,"nonce":<b64url>}`.
pub fn confirmation_token(statement: &str, sub: &str, project: &str) -> String {
    confirmation_token_with(statement, sub, project, 0, 120, IDENTITY_SECRET)
}

pub fn confirmation_token_with(
    statement: &str,
    sub: &str,
    project: &str,
    iat_offset: i64,
    exp_offset: i64,
    secret: &str,
) -> String {
    let now = now_secs();
    mint_token(
        &json!({
            "v": 1, "typ": "write_confirmation",
            "statement_sha256": hex::encode(Sha256::digest(statement.as_bytes())),
            "sub": sub, "project": project,
            "iat": now + iat_offset, "exp": now + exp_offset,
            "nonce": b64url(uuid::Uuid::new_v4().as_bytes()),
        }),
        secret,
    )
}

/// db-query-portal `computeIntegrityHash` (api/src/services/audit.service.ts @ aea73de):
/// JSON.stringify of {sql, mode, description, database, linearTicketId, executedBySub, status,
/// rowCount, preview, action, createdAt} in that key order, then `hmac-sha256:<hex>` under `key`,
/// or `sha256:<hex>` without a key. `record` holds those fields (as the DynamoDB item does);
/// a missing linearTicketId means null.
pub fn portal_integrity_hash(record: &Value, key: Option<&str>) -> String {
    let canonical = portal_canonical_json(record);
    match key {
        Some(k) => format!(
            "hmac-sha256:{}",
            hex::encode(hmac_sha256(k.as_bytes(), canonical.as_bytes()))
        ),
        None => format!(
            "sha256:{}",
            hex::encode(Sha256::digest(canonical.as_bytes()))
        ),
    }
}

pub fn portal_canonical_json(r: &Value) -> String {
    let get = |k: &str| r.get(k).cloned().unwrap_or(Value::Null);
    let action = match get("action") {
        Value::Null => json!("query"),
        v => v,
    };
    let fields: [(&str, Value); 11] = [
        ("sql", get("sql")),
        ("mode", get("mode")),
        ("description", get("description")),
        ("database", get("database")),
        ("linearTicketId", get("linearTicketId")),
        ("executedBySub", get("executedBySub")),
        ("status", get("status")),
        ("rowCount", get("rowCount")),
        ("preview", get("preview")),
        ("action", action),
        ("createdAt", get("createdAt")),
    ];
    let body: Vec<String> = fields
        .iter()
        .map(|(k, v)| format!("{}:{}", js_json(&json!(k)), js_json(v)))
        .collect();
    format!("{{{}}}", body.join(","))
}

/// JSON.stringify for scalars and nested values (no whitespace), matching V8's escaping:
/// `"` `\` and control characters are escaped, U+2028/2029 and non-ASCII are emitted raw.
pub fn js_json(v: &Value) -> String {
    match v {
        Value::String(s) => js_string(s),
        Value::Array(a) => format!("[{}]", a.iter().map(js_json).collect::<Vec<_>>().join(",")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}:{}", js_string(k), js_json(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

pub fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// JSON.stringify(record, null, 2) for a flat record whose keys are given in order
/// (the portal's S3 Object Lock body). Absent keys are skipped, like `undefined` in JS.
pub fn js_pretty_flat(record: &Value, key_order: &[&str]) -> String {
    let mut lines = vec![];
    for k in key_order {
        if let Some(v) = record.get(*k) {
            lines.push(format!("  {}: {}", js_string(k), js_json(v)));
        }
    }
    format!("{{\n{}\n}}", lines.join(",\n"))
}

/// Key order of the portal's `Execution` object as built by `createExecution`.
pub const EXECUTION_KEY_ORDER: [&str; 18] = [
    "id",
    "sql",
    "mode",
    "description",
    "database",
    "linearTicketId",
    "savedScriptId",
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
