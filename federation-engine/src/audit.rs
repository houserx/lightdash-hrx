//! Audit records (CONTRACTS §6): every Audited Query writes one item to db-query-portal's DynamoDB
//! `executions` table, with exactly the fields of the portal's `Execution`
//! (`api/src/dynamo/executions.ts`) and its `computeIntegrityHash`
//! (`api/src/services/audit.service.ts`).
//!
//! The same record is also written to the S3 Object Lock bucket, as the portal does: the body is
//! `JSON.stringify(record, null, 2)`, the key `executions/<createdAt>/<id>.json`, COMPLIANCE mode
//! retained for `s3_retention_days`.
//!
//! The put is append-only (`attribute_not_exists(id)`). Both writes happen after the query ran
//! and before any row is sent: if either fails, the client gets SQLSTATE 58000 and no rows.

use std::time::Duration;

use aws_config::Region;
use aws_sdk_dynamodb::types::AttributeValue;
use engine_config::Audit;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;

use crate::identity::Identity;

/// One audited execution, ready to write.
#[derive(Debug, Clone)]
pub struct Execution<'a> {
    pub identity: &'a Identity,
    /// The SQL statement as the client sent it.
    pub sql: &'a str,
    /// The audited sources the statement read (the portal's `database`).
    pub sources: &'a [String],
    /// The rows returned, or the error the client got (the portal's `errorMessage`).
    pub outcome: Result<usize, &'a str>,
    pub duration: Duration,
}

/// Writes audit records to the configured store.
pub struct AuditWriter {
    settings: Audit,
    connect_timeout: Duration,
    shared: OnceCell<aws_config::SdkConfig>,
    dynamodb: OnceCell<aws_sdk_dynamodb::Client>,
    s3: OnceCell<aws_sdk_s3::Client>,
}

impl AuditWriter {
    pub fn new(settings: Audit, connect_timeout: Duration) -> AuditWriter {
        AuditWriter {
            settings,
            connect_timeout,
            shared: OnceCell::new(),
            dynamodb: OnceCell::new(),
            s3: OnceCell::new(),
        }
    }

    /// Writes the record of an Audited Query, successful or not. The error text is for the engine's log
    /// only; clients get "audit write failed".
    pub async fn write(&self, execution: &Execution<'_>) -> Result<(), String> {
        let created_at = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let key = self.settings.integrity_key.as_ref().map(|k| k.expose());
        let record = record(execution, &id, &created_at, key);
        let item = record
            .iter()
            .map(|(k, v)| (k.to_string(), attribute(v)))
            .collect();
        self.dynamodb()
            .await
            .put_item()
            .table_name(&self.settings.dynamodb_table)
            .set_item(Some(item))
            .condition_expression("attribute_not_exists(id)")
            .send()
            .await
            .map_err(|e| {
                format!(
                    "DynamoDB PutItem on {}: {}",
                    self.settings.dynamodb_table,
                    aws_sdk_dynamodb::error::DisplayErrorContext(e)
                )
            })?;

        let key = format!("executions/{created_at}/{id}.json");
        let days = self.settings.s3_retention_days;
        let retain_until = i64::try_from(days)
            .ok()
            .and_then(chrono::TimeDelta::try_days)
            .and_then(|d| chrono::Utc::now().checked_add_signed(d))
            .ok_or_else(|| format!("s3_retention_days {days} is out of range"))?;
        self.s3()
            .await
            .put_object()
            .bucket(&self.settings.s3_bucket)
            .key(&key)
            .body(js_pretty(&record).into_bytes().into())
            .content_type("application/json")
            .object_lock_mode(aws_sdk_s3::types::ObjectLockMode::Compliance)
            .object_lock_retain_until_date(aws_sdk_s3::primitives::DateTime::from_millis(
                retain_until.timestamp_millis(),
            ))
            .send()
            .await
            .map_err(|e| {
                format!(
                    "S3 PutObject s3://{}/{key}: {}",
                    self.settings.s3_bucket,
                    aws_sdk_s3::error::DisplayErrorContext(e)
                )
            })?;
        Ok(())
    }

    /// The shared AWS config: the default credential chain in `[audit] region` (else the
    /// chain's region).
    async fn shared(&self) -> &aws_config::SdkConfig {
        self.shared
            .get_or_init(|| async {
                let timeouts = aws_config::timeout::TimeoutConfig::builder()
                    .connect_timeout(self.connect_timeout)
                    .build();
                let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .timeout_config(timeouts);
                if let Some(region) = &self.settings.region {
                    loader = loader.region(Region::new(region.clone()));
                }
                loader.load().await
            })
            .await
    }

    /// The DynamoDB client, at `dynamodb_endpoint_url` when one is set.
    async fn dynamodb(&self) -> &aws_sdk_dynamodb::Client {
        self.dynamodb
            .get_or_init(|| async {
                let mut config = aws_sdk_dynamodb::config::Builder::from(self.shared().await);
                if let Some(url) = &self.settings.dynamodb_endpoint_url {
                    config = config.endpoint_url(url);
                }
                aws_sdk_dynamodb::Client::from_conf(config.build())
            })
            .await
    }

    /// The S3 client, at `s3_endpoint_url` (path-style) when one is set.
    async fn s3(&self) -> &aws_sdk_s3::Client {
        self.s3
            .get_or_init(|| async {
                let mut config = aws_sdk_s3::config::Builder::from(self.shared().await);
                if let Some(url) = &self.settings.s3_endpoint_url {
                    config = config.endpoint_url(url).force_path_style(true);
                }
                aws_sdk_s3::Client::from_conf(config.build())
            })
            .await
    }
}

/// The portal's `Execution` for a read, in the portal's key order: status `success` with its
/// `rowCount`, or status `error` with its `errorMessage` and a null `rowCount`. `linearTicketId`
/// is left out without a ticket (the `byTicket` index is sparse); `savedScriptId` is never set.
pub fn record(
    e: &Execution<'_>,
    id: &str,
    created_at: &str,
    integrity_key: Option<&str>,
) -> Vec<(&'static str, Value)> {
    let id_ = e.identity;
    let (status, row_count, error_message) = match e.outcome {
        Ok(rows) => ("success", json!(rows), Value::Null),
        Err(message) => ("error", Value::Null, json!(message)),
    };
    let mut fields: Vec<(&'static str, Value)> = vec![
        ("id", json!(id)),
        ("sql", json!(e.sql)),
        ("mode", json!("read")),
        ("description", json!(id_.description)),
        ("database", json!(e.sources.join(","))),
    ];
    if let Some(ticket) = &id_.ticket {
        fields.push(("linearTicketId", json!(ticket)));
    }
    fields.extend([
        ("executedByEmail", json!(id_.email)),
        ("executedBySub", json!(id_.sub)),
        ("status", json!(status)),
        ("rowCount", row_count),
        (
            "durationMs",
            json!(u64::try_from(e.duration.as_millis()).unwrap_or(u64::MAX)),
        ),
        ("errorMessage", error_message),
        ("preview", json!(false)),
        ("action", json!(id_.action())),
        ("integrityHash", Value::Null),
        ("createdAt", json!(created_at)),
        ("createdAtMonth", json!(&created_at[..7])),
    ]);
    let hash = integrity_hash(&fields, integrity_key);
    if let Some(slot) = fields.iter_mut().find(|(k, _)| *k == "integrityHash") {
        slot.1 = json!(hash);
    }
    fields
}

/// The portal's `computeIntegrityHash`: `JSON.stringify` of {sql, mode, description, database,
/// linearTicketId, executedBySub, status, rowCount, preview, action, createdAt} in that order (a
/// missing ticket is null), then `hmac-sha256:<hex>` under the key, or `sha256:<hex>` without one.
pub fn integrity_hash(fields: &[(&'static str, Value)], key: Option<&str>) -> String {
    let get = |name: &str| {
        fields
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.clone())
            .unwrap_or(Value::Null)
    };
    let canonical = [
        "sql",
        "mode",
        "description",
        "database",
        "linearTicketId",
        "executedBySub",
        "status",
        "rowCount",
        "preview",
        "action",
        "createdAt",
    ]
    .iter()
    .map(|k| format!("{}:{}", js_json(&json!(k)), js_json(&get(k))))
    .collect::<Vec<_>>()
    .join(",");
    let canonical = format!("{{{canonical}}}");
    match key {
        Some(key) => {
            let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key.as_bytes())
                .expect("HMAC takes keys of any length");
            mac.update(canonical.as_bytes());
            format!("hmac-sha256:{}", hex::encode(mac.finalize().into_bytes()))
        }
        None => format!("sha256:{}", hex::encode(Sha256::digest(canonical.as_bytes()))),
    }
}

/// `JSON.stringify` of a scalar as V8 writes it: `"`, `\` and control characters escaped,
/// everything else (non-ASCII, U+2028/2029) raw.
pub fn js_json(v: &Value) -> String {
    let Value::String(s) = v else {
        return v.to_string();
    };
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

/// `JSON.stringify(record, null, 2)` of a flat record, in its key order.
pub fn js_pretty(fields: &[(&'static str, Value)]) -> String {
    let lines = fields
        .iter()
        .map(|(k, v)| format!("  {}: {}", js_json(&json!(k)), js_json(v)))
        .collect::<Vec<_>>()
        .join(",\n");
    format!("{{\n{lines}\n}}")
}

/// A record field as a DynamoDB attribute, as the portal's DocumentClient marshals it.
fn attribute(v: &Value) -> AttributeValue {
    match v {
        Value::Null => AttributeValue::Null(true),
        Value::Bool(b) => AttributeValue::Bool(*b),
        Value::Number(n) => AttributeValue::N(n.to_string()),
        Value::String(s) => AttributeValue::S(s.clone()),
        other => AttributeValue::S(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(ticket: Option<&str>) -> Identity {
        Identity {
            sub: "u-1".into(),
            email: "a@example.com".into(),
            agent: false,
            sys: false,
            telemetry_restricted: true,
            platform_read: false,
            platform_explain: false,
            description: Some("why".into()),
            ticket: ticket.map(str::to_string),
        }
    }

    #[test]
    fn records_have_the_portal_fields_and_hash() {
        let id = identity(Some("ENG-1"));
        let sources = vec!["prom-restricted".to_string()];
        let e = Execution {
            identity: &id,
            sql: "SELECT \"x\"\n -- ü",
            sources: &sources,
            outcome: Ok(2),
            duration: Duration::from_millis(1234),
        };
        let created = "2026-11-08T10:00:00.123Z";
        let r = record(&e, "id-1", created, Some("k"));
        let keys: Vec<&str> = r.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            keys,
            [
                "id", "sql", "mode", "description", "database", "linearTicketId",
                "executedByEmail", "executedBySub", "status", "rowCount", "durationMs",
                "errorMessage", "preview", "action", "integrityHash", "createdAt",
                "createdAtMonth"
            ]
        );
        let get = |k: &str| r.iter().find(|(n, _)| *n == k).unwrap().1.clone();
        assert_eq!(get("durationMs"), json!(1234));
        assert_eq!(get("createdAtMonth"), json!("2026-11"));
        let canonical = r#"{"sql":"SELECT \"x\"\n -- ü","mode":"read","description":"why","database":"prom-restricted","linearTicketId":"ENG-1","executedBySub":"u-1","status":"success","rowCount":2,"preview":false,"action":"query","createdAt":"2026-11-08T10:00:00.123Z"}"#;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(b"k").unwrap();
        mac.update(canonical.as_bytes());
        assert_eq!(
            get("integrityHash"),
            json!(format!("hmac-sha256:{}", hex::encode(mac.finalize().into_bytes())))
        );
        // Without a ticket the field is left out, and hashed as null.
        let id = identity(None);
        let r = record(&Execution { identity: &id, ..e }, "id-1", created, None);
        assert!(r.iter().all(|(k, _)| *k != "linearTicketId"));
        let canonical = canonical.replace("\"ENG-1\"", "null");
        assert_eq!(
            r.iter().find(|(k, _)| *k == "integrityHash").unwrap().1,
            json!(format!("sha256:{}", hex::encode(Sha256::digest(canonical.as_bytes()))))
        );
    }

    #[test]
    fn failed_executions_have_status_error_and_a_null_row_count() {
        let id = identity(None);
        let sources = vec!["platform".to_string()];
        let e = Execution {
            identity: &id,
            sql: "SELECT 1",
            sources: &sources,
            outcome: Err("division by zero"),
            duration: Duration::from_millis(5),
        };
        let created = "2026-11-08T10:00:00.123Z";
        let r = record(&e, "id-1", created, None);
        let get = |k: &str| r.iter().find(|(n, _)| *n == k).unwrap().1.clone();
        assert_eq!(get("status"), json!("error"));
        assert_eq!(get("rowCount"), Value::Null);
        assert_eq!(get("errorMessage"), json!("division by zero"));
        let canonical = r#"{"sql":"SELECT 1","mode":"read","description":"why","database":"platform","linearTicketId":null,"executedBySub":"u-1","status":"error","rowCount":null,"preview":false,"action":"query","createdAt":"2026-11-08T10:00:00.123Z"}"#;
        assert_eq!(
            get("integrityHash"),
            json!(format!("sha256:{}", hex::encode(Sha256::digest(canonical.as_bytes()))))
        );
    }

    #[test]
    fn js_pretty_is_two_space_json_stringify() {
        let fields = vec![
            ("id", json!("x")),
            ("description", json!("a\nb \"q\" ü")),
            ("rowCount", json!(2)),
            ("errorMessage", Value::Null),
            ("preview", json!(false)),
        ];
        assert_eq!(
            js_pretty(&fields),
            "{\n  \"id\": \"x\",\n  \"description\": \"a\\nb \\\"q\\\" ü\",\n  \"rowCount\": 2,\n  \"errorMessage\": null,\n  \"preview\": false\n}"
        );
    }

    #[test]
    fn js_json_escapes_like_v8() {
        assert_eq!(js_json(&json!("a\u{1}\u{2028}✓\t")), "\"a\\u0001\u{2028}✓\\t\"");
        assert_eq!(js_json(&Value::Null), "null");
        assert_eq!(js_json(&json!(false)), "false");
    }
}
