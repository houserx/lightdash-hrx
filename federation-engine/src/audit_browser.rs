//! The audit browser (CONTRACTS §1.3, §6): `GET /v1/audit` pages the audit records in the
//! `executions` table through db-query-portal's GSIs and answers `{items: Execution[],
//! nextCursor}`, 25 items a page, newest first (contract assumption A14 in PROGRESS.md).
//!
//! A request needs a valid bearer identity token (else 401) holding `attrs.platform_read` (else
//! 403); both are checked before the store is touched. Then, in the portal's precedence:
//!
//! - `ticket=` queries the `byTicket` index (`linearTicketId`, `createdAt`);
//! - else `user=` (an email) queries the `byUser` index (`executedByEmail`, `createdAt`). For
//!   both, the cursor is the portal's: base64 of the JSON of DynamoDB's `LastEvaluatedKey`;
//! - else `month=YYYY-MM` queries the `byMonth` index (`createdAtMonth`, `createdAt`), that one
//!   partition. A month that is not `YYYY-MM` with a month 01-12 is 400. Its cursor is the
//!   portal's: base64 of the JSON `{month, key}`, `key` being DynamoDB's `LastEvaluatedKey`.
//!
//! An empty parameter counts as absent; with none of the three the answer is 400 (the portal's
//! last-30-days browse is not built). `nextCursor` is null on the last page. A cursor that does
//! not decode, or a month cursor that belongs to another month, is 400. A store that cannot be queried is 502; an engine without `[audit]` 503.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use engine_config::Config;
use serde_json::{Map, Value, json};

use crate::audit::AuditWriter;
use crate::identity;

/// Items per page, as in the portal.
const PAGE_SIZE: i32 = 25;

/// The audit browser's state: the identity secret and the audit store.
pub struct AuditBrowser {
    identity_secret: Vec<u8>,
    store: Option<AuditWriter>,
}

impl AuditBrowser {
    pub fn new(config: &Config, connect_timeout: Duration) -> AuditBrowser {
        AuditBrowser {
            identity_secret: config.identity_secret.expose().as_bytes().to_vec(),
            store: config
                .audit
                .clone()
                .map(|a| AuditWriter::new(a, connect_timeout)),
        }
    }
}

/// `GET /v1/audit`.
pub async fn handle(
    State(browser): State<Arc<AuditBrowser>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    match browse(&browser, &headers, &params).await {
        Ok(page) => Json(page).into_response(),
        Err((status, message)) => (status, Json(json!({"error": message}))).into_response(),
    }
}

type Refusal = (StatusCode, String);

fn refuse(status: StatusCode, message: impl Into<String>) -> Refusal {
    (status, message.into())
}

async fn browse(
    browser: &AuditBrowser,
    headers: &HeaderMap,
    params: &HashMap<String, String>,
) -> Result<Value, Refusal> {
    let now = chrono::Utc::now().timestamp();
    let identity = crate::write::bearer(headers)
        .and_then(|token| identity::verify(token, &browser.identity_secret, now))
        .ok_or_else(|| {
            refuse(
                StatusCode::UNAUTHORIZED,
                "the audit browser needs a valid identity token (Authorization: Bearer)",
            )
        })?;
    if !identity.platform_read {
        return Err(refuse(
            StatusCode::FORBIDDEN,
            "the audit browser needs attrs.platform_read",
        ));
    }
    // Precedence as in the portal: ticket, then user, then month. An empty value counts as absent.
    let param = |name: &str| params.get(name).filter(|v| !v.is_empty());
    let cursor = param("cursor");
    let (index, key_attr, key_value, start, month) = if let Some(ticket) = param("ticket") {
        let start = cursor.map(|c| plain_cursor_key(c)).transpose()?;
        ("byTicket", "linearTicketId", ticket, start, None)
    } else if let Some(user) = param("user") {
        let start = cursor.map(|c| plain_cursor_key(c)).transpose()?;
        ("byUser", "executedByEmail", user, start, None)
    } else {
        let month = param("month").ok_or_else(|| {
            refuse(
                StatusCode::BAD_REQUEST,
                "one of ticket, user or month=YYYY-MM is required",
            )
        })?;
        if !is_month(month) {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                format!("month must be YYYY-MM, got {month:?}"),
            ));
        }
        let start = cursor.map(|c| month_cursor_key(c, month)).transpose()?;
        ("byMonth", "createdAtMonth", month, start, Some(month))
    };
    let store = browser.store.as_ref().ok_or_else(|| {
        refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "the audit store is not configured ([audit])",
        )
    })?;
    let (items, next) = store
        .query_page(index, key_attr, key_value, PAGE_SIZE, start.as_ref())
        .await
        .map_err(|e| {
            crate::log::error(
                "audit browser query failed",
                &[("error", serde_json::json!(e.to_string()))],
            );
            refuse(StatusCode::BAD_GATEWAY, "audit store query failed")
        })?;
    let next_cursor = next.map(|key| {
        let cursor = match month {
            Some(month) => json!({"month": month, "key": key}),
            None => key,
        };
        base64::engine::general_purpose::STANDARD.encode(cursor.to_string())
    });
    Ok(json!({"items": items, "nextCursor": next_cursor}))
}

/// `YYYY-MM` with a month 01-12.
fn is_month(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && b[..4].iter().chain(&b[5..]).all(u8::is_ascii_digit)
        && matches!(s[5..].parse::<u8>(), Ok(1..=12))
}

/// 400 for a cursor this browser did not hand out.
fn bad_cursor() -> Refusal {
    refuse(
        StatusCode::BAD_REQUEST,
        "cursor is not a valid audit cursor",
    )
}

/// The JSON a cursor encodes in base64. A `+` left unescaped in the query string arrives as a
/// space.
fn decode_cursor(cursor: &str) -> Result<Value, Refusal> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cursor.replace(' ', "+"))
        .map_err(|_| bad_cursor())?;
    serde_json::from_slice(&bytes).map_err(|_| bad_cursor())
}

/// The `LastEvaluatedKey` of a ticket or user cursor (base64 of the key's JSON, as in the portal).
fn plain_cursor_key(cursor: &str) -> Result<Map<String, Value>, Refusal> {
    match decode_cursor(cursor)? {
        Value::Object(key) => Ok(key),
        _ => Err(bad_cursor()),
    }
}

/// The `key` of a month cursor (base64 of `{month, key}`) that belongs to `month`.
fn month_cursor_key(cursor: &str, month: &str) -> Result<Map<String, Value>, Refusal> {
    let value = decode_cursor(cursor)?;
    if value.get("month").and_then(Value::as_str) != Some(month) {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "cursor belongs to another month",
        ));
    }
    match value.get("key") {
        Some(Value::Object(key)) => Ok(key.clone()),
        _ => Err(bad_cursor()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months_are_yyyy_mm() {
        assert!(is_month("2026-10"));
        assert!(is_month("2026-01"));
        assert!(is_month("2026-12"));
        for bad in [
            "2026-13", "2026-00", "2026-1", "26-10", "2026/10", "2026-1a", "+026-10", "",
        ] {
            assert!(!is_month(bad), "{bad}");
        }
    }

    #[test]
    fn month_cursors_round_trip_and_stay_in_their_month() {
        let key = json!({"id": "x", "createdAtMonth": "2026-10", "createdAt": "2026-10-05T10:00:00.000Z"});
        let cursor = base64::engine::general_purpose::STANDARD
            .encode(json!({"month": "2026-10", "key": key}).to_string());
        assert_eq!(
            Value::Object(month_cursor_key(&cursor, "2026-10").unwrap()),
            key
        );
        assert!(month_cursor_key(&cursor.replace('+', " "), "2026-10").is_ok());
        assert_eq!(
            month_cursor_key(&cursor, "2026-09").unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            month_cursor_key("not base64!", "2026-10").unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn plain_cursors_are_the_last_evaluated_key() {
        let key =
            json!({"id": "x", "linearTicketId": "ENG-7", "createdAt": "2026-10-05T10:00:00.000Z"});
        let cursor = base64::engine::general_purpose::STANDARD.encode(key.to_string());
        assert_eq!(Value::Object(plain_cursor_key(&cursor).unwrap()), key);
        let not_object = base64::engine::general_purpose::STANDARD.encode("[1]");
        for bad in [not_object.as_str(), "not base64!", "bm90IGpzb24="] {
            assert_eq!(
                plain_cursor_key(bad).unwrap_err().0,
                StatusCode::BAD_REQUEST,
                "{bad}"
            );
        }
    }
}
