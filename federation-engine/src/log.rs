//! Structured logs (eng-json-logs): every line the serving engine writes is one JSON object on
//! stderr with `timestamp` (RFC 3339, UTC, milliseconds), `level` and `message`, plus optional
//! fields.
//!
//! What may be logged: engine-authored messages, addresses, counts, source names and error
//! causes from the engine's own plumbing. What must never be logged: query results, identity
//! tokens or their payload (user, email, description, ticket), passwords, the identity secret
//! or the audit key. Call sites pass only the former; nothing here logs a statement or a row.
//!
//! `engine --check-config` and command-line usage errors are interactive answers, not logs, and
//! stay plain text (main.rs).

use std::io::Write;

use serde_json::{Map, Value};

#[derive(Clone, Copy)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

/// One log line as JSON text (without the trailing newline).
fn line(level: Level, message: &str, fields: &[(&str, Value)]) -> String {
    let mut obj = Map::new();
    obj.insert(
        "timestamp".into(),
        Value::String(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    obj.insert("level".into(), Value::String(level.as_str().into()));
    obj.insert("message".into(), Value::String(message.into()));
    for (k, v) in fields {
        if !matches!(*k, "timestamp" | "level" | "message") {
            obj.insert((*k).to_string(), v.clone());
        }
    }
    Value::Object(obj).to_string()
}

/// Writes one line to stderr in a single write, so concurrent lines never interleave.
pub fn emit(level: Level, message: &str, fields: &[(&str, Value)]) {
    let mut text = line(level, message, fields);
    text.push('\n');
    let _ = std::io::stderr().lock().write_all(text.as_bytes());
}

pub fn info(message: &str, fields: &[(&str, Value)]) {
    emit(Level::Info, message, fields);
}

pub fn warn(message: &str, fields: &[(&str, Value)]) {
    emit(Level::Warn, message, fields);
}

pub fn error(message: &str, fields: &[(&str, Value)]) {
    emit(Level::Error, message, fields);
}

/// Replaces the default panic message (plain text) with a JSON line. Only the panic location
/// and message are logged; panic messages in this crate never carry query data.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        error(
            "engine panicked",
            &[
                ("panic", Value::String(message)),
                ("location", Value::String(location)),
            ],
        );
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_is_one_json_object_with_timestamp_level_and_message() {
        let text = line(
            Level::Warn,
            "multi\nline \"quoted\"",
            &[
                ("source", Value::String("prom-a".into())),
                ("level", Value::Null),
            ],
        );
        assert!(!text.contains('\n'));
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["level"], "warn", "a field can't override the level");
        assert_eq!(v["message"], "multi\nline \"quoted\"");
        assert_eq!(v["source"], "prom-a");
        let ts = v["timestamp"].as_str().unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(ts).is_ok(), "{ts}");
        assert!(ts.ends_with('Z'));
    }
}
