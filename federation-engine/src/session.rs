//! Per-connection session settings (CONTRACTS §1 "Session SETs"): what `SET` and `RESET` change,
//! and what `current_setting(name)` reports.
//!
//! Settings live in the pg-wire client's metadata, so each connection has its own and they end
//! with it. `timezone` is validated and changes the zone queries are planned in;
//! `statement_timeout` is validated and limits how long a statement may execute (pg.rs). Every
//! other name (`lightdash.agent`, `search_path`, unknown ones) is stored as given and has no other
//! effect here.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use datafusion::arrow::array::{AsArray, StringArray};
use datafusion::arrow::compute::cast;
use datafusion::arrow::datatypes::DataType;
use datafusion::common::ScalarValue;
use datafusion::error::DataFusionError;
use datafusion::logical_expr::{ColumnarValue, ScalarUDF, Volatility, create_udf};
use datafusion::sql::parser::{ResetStatement, Statement as DFStatement};
use datafusion::sql::sqlparser::ast::{ContextModifier, Expr, ObjectName, Set, Statement, Value};

/// Settings are stored in the client metadata as `<prefix><lower-case name>`, apart from the
/// startup parameters pgwire keeps there.
const KEY_PREFIX: &str = "hrx.setting:";

/// The value a setting has before any `SET`, for the settings the engine knows.
fn default_of(name: &str) -> Option<&'static str> {
    match name {
        "timezone" => Some("UTC"),
        "statement_timeout" => Some("0"),
        _ => None,
    }
}

/// An error that carries its own Postgres SQLSTATE, wrapped in `DataFusionError::External`.
#[derive(Debug)]
pub struct SqlStateError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for SqlStateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SqlStateError {}

/// A DataFusion error carrying the given SQLSTATE.
pub fn sqlstate(code: &'static str, message: String) -> DataFusionError {
    DataFusionError::External(Box::new(SqlStateError { code, message }))
}

/// One connection's settings, as of the statement being planned.
#[derive(Debug, Clone, Default)]
pub struct Settings(HashMap<String, String>);

impl Settings {
    /// The settings stored in a client's metadata.
    pub fn of(metadata: &HashMap<String, String>) -> Settings {
        Settings(
            metadata
                .iter()
                .filter_map(|(k, v)| Some((k.strip_prefix(KEY_PREFIX)?.to_string(), v.clone())))
                .collect(),
        )
    }

    /// A setting's value (the name is case-insensitive), else its default.
    pub fn get(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.0.get(&name).map(String::as_str).or(default_of(&name))
    }

    /// The zone set with `SET timezone` (a canonical IANA name), if one was.
    pub fn time_zone(&self) -> Option<&str> {
        self.0.get("timezone").map(String::as_str)
    }

    /// The limit `SET statement_timeout` puts on a statement; `None` when it is `0` (no limit).
    pub fn statement_timeout(&self) -> Option<Duration> {
        self.get("statement_timeout")
            .and_then(timeout_millis)
            .filter(|ms| *ms > 0)
            .map(Duration::from_millis)
    }
}

/// The milliseconds a `statement_timeout` value means, as Postgres reads it: a number of
/// milliseconds, or a number with a unit (`us`, `ms`, `s`, `min`, `h`, `d`), between 0 and
/// 2147483647 ms after rounding. `None` if the value is not one.
fn timeout_millis(value: &str) -> Option<u64> {
    let value = value.trim();
    let split = value
        .find(|c: char| c.is_ascii_alphabetic())
        .unwrap_or(value.len());
    let (number, unit) = value.split_at(split);
    let number: f64 = number.trim().parse().ok()?;
    let per_unit = match unit.trim() {
        "" | "ms" => 1.0,
        "us" => 0.001,
        "s" => 1_000.0,
        "min" => 60_000.0,
        "h" => 3_600_000.0,
        "d" => 86_400_000.0,
        _ => return None,
    };
    let ms = (number * per_unit).round();
    (ms.is_finite() && (0.0..=f64::from(i32::MAX)).contains(&ms)).then_some(ms as u64)
}

/// A validated `SET` or `RESET`.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    /// `SET name = value`; a `None` value is `SET name TO DEFAULT` or `RESET name`.
    Set { name: String, value: Option<String> },
    /// `RESET ALL`.
    ResetAll,
    /// Accepted and without effect: `SET LOCAL` (transaction blocks hold no state to scope it
    /// to), `SET ROLE`, `SET NAMES`, `SET TRANSACTION ...`.
    Ignored,
}

impl Change {
    /// The change a statement makes, `None` if it is not a `SET` or `RESET`.
    pub fn of(statement: &DFStatement) -> Option<Result<Change, DataFusionError>> {
        let change = match statement {
            DFStatement::Reset(ResetStatement::Variable(name)) => {
                let name = setting_name(name);
                if name == "all" {
                    return Some(Ok(Change::ResetAll));
                }
                Change::Set { name, value: None }
            }
            DFStatement::Statement(s) => match s.as_ref() {
                Statement::Set(Set::SingleAssignment {
                    scope: Some(ContextModifier::Local),
                    ..
                })
                | Statement::Set(Set::SetTimeZone { local: true, .. }) => Change::Ignored,
                Statement::Set(Set::SingleAssignment {
                    variable, values, ..
                }) => Change::Set {
                    name: setting_name(variable),
                    value: set_value(values),
                },
                Statement::Set(Set::SetTimeZone { value, .. }) => Change::Set {
                    name: "timezone".to_string(),
                    value: set_value(std::slice::from_ref(value)),
                },
                Statement::Set(_) => Change::Ignored,
                _ => return None,
            },
            _ => return None,
        };
        Some(change.validated())
    }

    /// Checks the value of a setting the engine acts on, and canonicalises it.
    fn validated(self) -> Result<Change, DataFusionError> {
        match self {
            Change::Set {
                name,
                value: Some(value),
            } if name == "timezone" => {
                let zone = canonical_time_zone(&value).ok_or_else(|| {
                    sqlstate(
                        "22023",
                        format!("invalid value for parameter \"TimeZone\": \"{value}\""),
                    )
                })?;
                Ok(Change::Set {
                    name,
                    value: Some(zone.to_string()),
                })
            }
            Change::Set {
                name,
                value: Some(value),
            } if name == "statement_timeout" => match timeout_millis(&value) {
                Some(_) => Ok(Change::Set {
                    name,
                    value: Some(value),
                }),
                None => Err(sqlstate(
                    "22023",
                    format!("invalid value for parameter \"statement_timeout\": \"{value}\""),
                )),
            },
            other => Ok(other),
        }
    }

    /// The command tag Postgres answers with.
    pub fn tag(&self) -> &'static str {
        match self {
            Change::Set { value: None, .. } | Change::ResetAll => "RESET",
            Change::Set { .. } | Change::Ignored => "SET",
        }
    }

    /// Applies the change to a client's metadata.
    pub fn apply(&self, metadata: &mut HashMap<String, String>) {
        match self {
            Change::Set {
                name,
                value: Some(value),
            } => {
                metadata.insert(format!("{KEY_PREFIX}{name}"), value.clone());
            }
            Change::Set { name, value: None } => {
                metadata.remove(&format!("{KEY_PREFIX}{name}"));
            }
            Change::ResetAll => metadata.retain(|k, _| !k.starts_with(KEY_PREFIX)),
            Change::Ignored => {}
        }
    }
}

/// `a.b` as Postgres names a setting: case-insensitive, quotes or not.
fn setting_name(name: &ObjectName) -> String {
    name.0
        .iter()
        .map(|part| match part.as_ident() {
            Some(ident) => ident.value.clone(),
            None => part.to_string(),
        })
        .collect::<Vec<_>>()
        .join(".")
        .to_ascii_lowercase()
}

/// The text of a `SET` value list (`'x'`, `540000`, `public`, `a, b`); `None` for `DEFAULT`.
fn set_value(values: &[Expr]) -> Option<String> {
    if let [Expr::Identifier(ident)] = values
        && ident.quote_style.is_none()
        && ident.value.eq_ignore_ascii_case("default")
    {
        return None;
    }
    let text = values
        .iter()
        .map(|v| match v {
            Expr::Value(v) => match &v.value {
                Value::SingleQuotedString(s) | Value::DoubleQuotedString(s) => s.clone(),
                other => other.to_string(),
            },
            Expr::Identifier(ident) => ident.value.clone(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(text)
}

/// The IANA zone a `SET timezone` value names, spelled canonically (`utc` is `UTC`).
///
/// Postgres's POSIX-style offsets (`'+05:30'` means UTC-5:30) and numeric hour offsets are not
/// accepted, so a zone never means the opposite of what an ISO reader would expect.
fn canonical_time_zone(value: &str) -> Option<&'static str> {
    chrono_tz::TZ_VARIANTS
        .iter()
        .map(|tz| tz.name())
        .find(|name| name.eq_ignore_ascii_case(value))
}

/// `current_setting(name)` over one statement's settings. An unknown name is SQLSTATE 42704.
pub fn current_setting_udf(settings: Settings) -> ScalarUDF {
    let lookup = move |name: &str| -> Result<String, DataFusionError> {
        settings.get(name).map(str::to_string).ok_or_else(|| {
            sqlstate(
                "42704",
                format!("unrecognized configuration parameter \"{name}\""),
            )
        })
    };
    create_udf(
        "current_setting",
        vec![DataType::Utf8],
        DataType::Utf8,
        Volatility::Stable,
        Arc::new(move |args: &[ColumnarValue]| match &args[0] {
            ColumnarValue::Scalar(name) => match name.cast_to(&DataType::Utf8)? {
                ScalarValue::Utf8(Some(name)) => Ok(ColumnarValue::Scalar(ScalarValue::Utf8(
                    Some(lookup(&name)?),
                ))),
                _ => Ok(ColumnarValue::Scalar(ScalarValue::Utf8(None))),
            },
            ColumnarValue::Array(names) => {
                let names = cast(names, &DataType::Utf8)?;
                let values = names
                    .as_string::<i32>()
                    .iter()
                    .map(|name| name.map(&lookup).transpose())
                    .collect::<Result<StringArray, _>>()?;
                Ok(ColumnarValue::Array(Arc::new(values)))
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::config::Dialect;
    use datafusion::prelude::SessionContext;

    fn change(sql: &str) -> Option<Result<Change, DataFusionError>> {
        let state = SessionContext::new().state();
        let statement = state.sql_to_statement(sql, &Dialect::Generic).unwrap();
        Change::of(&statement)
    }

    fn set(name: &str, value: Option<&str>) -> Change {
        Change::Set {
            name: name.to_string(),
            value: value.map(str::to_string),
        }
    }

    #[test]
    fn set_statements_become_changes() {
        let ok = |sql: &str| change(sql).unwrap().unwrap();
        assert_eq!(
            ok("SET statement_timeout = 540000"),
            set("statement_timeout", Some("540000"))
        );
        assert_eq!(
            ok("SET lightdash.agent = 'true'"),
            set("lightdash.agent", Some("true"))
        );
        assert_eq!(
            ok("SET timezone TO 'america/new_york'"),
            set("timezone", Some("America/New_York"))
        );
        assert_eq!(
            ok("SET TIME ZONE 'Europe/Berlin'"),
            set("timezone", Some("Europe/Berlin"))
        );
        assert_eq!(ok("SET \"TimeZone\" = 'UTC'"), set("timezone", Some("UTC")));
        assert_eq!(ok("SET timezone TO DEFAULT"), set("timezone", None));
        assert_eq!(ok("RESET timezone"), set("timezone", None));
        assert_eq!(ok("RESET ALL"), Change::ResetAll);
        assert_eq!(
            ok("SET search_path TO public, other"),
            set("search_path", Some("public, other"))
        );
        assert_eq!(
            ok("SET SESSION application_name = 'x'"),
            set("application_name", Some("x"))
        );
        assert_eq!(ok("SET LOCAL timezone = 'UTC'"), Change::Ignored);
        assert!(change("SELECT 1").is_none());
    }

    #[test]
    fn unknown_time_zones_are_refused_with_22023() {
        for sql in ["SET timezone TO 'Mars/Olympus'", "SET timezone TO '+05:30'"] {
            let e = change(sql).unwrap().unwrap_err();
            let DataFusionError::External(e) = e else {
                panic!("{sql}: not a SQLSTATE error")
            };
            assert_eq!(e.downcast_ref::<SqlStateError>().unwrap().code, "22023");
        }
    }

    #[test]
    fn statement_timeouts_read_as_postgres_reads_them() {
        let limit = |value: &str| {
            let mut meta = HashMap::new();
            set("statement_timeout", Some(value)).apply(&mut meta);
            Settings::of(&meta).statement_timeout()
        };
        assert_eq!(Settings::default().statement_timeout(), None);
        assert_eq!(limit("0"), None);
        assert_eq!(limit("500"), Some(Duration::from_millis(500)));
        assert_eq!(limit("5s"), Some(Duration::from_secs(5)));
        assert_eq!(limit("1.5 s"), Some(Duration::from_millis(1500)));
        assert_eq!(limit("2min"), Some(Duration::from_secs(120)));
        assert_eq!(limit("1h"), Some(Duration::from_secs(3600)));
        assert_eq!(limit("250ms"), Some(Duration::from_millis(250)));
        let ok = |sql: &str| change(sql).unwrap().unwrap();
        assert_eq!(
            ok("SET statement_timeout = '5s'"),
            set("statement_timeout", Some("5s"))
        );
        assert_eq!(ok("SET statement_timeout = 0"), set("statement_timeout", Some("0")));
        for sql in [
            "SET statement_timeout = -1",
            "SET statement_timeout = 'soon'",
            "SET statement_timeout = '5 fortnights'",
            "SET statement_timeout = 3000000000",
        ] {
            let e = change(sql).unwrap().unwrap_err();
            let DataFusionError::External(e) = e else {
                panic!("{sql}: not a SQLSTATE error")
            };
            assert_eq!(e.downcast_ref::<SqlStateError>().unwrap().code, "22023", "{sql}");
        }
    }

    #[test]
    fn changes_apply_per_metadata_map() {
        let mut meta = HashMap::from([("user".to_string(), "u".to_string())]);
        assert_eq!(Settings::of(&meta).get("TIMEZONE"), Some("UTC"));
        set("timezone", Some("Asia/Tokyo")).apply(&mut meta);
        set("some.thing", Some("x")).apply(&mut meta);
        let s = Settings::of(&meta);
        assert_eq!(s.get("TimeZone"), Some("Asia/Tokyo"));
        assert_eq!(s.time_zone(), Some("Asia/Tokyo"));
        assert_eq!(s.get("some.thing"), Some("x"));
        assert_eq!(s.get("nope"), None);
        set("timezone", None).apply(&mut meta);
        assert_eq!(Settings::of(&meta).time_zone(), None);
        Change::ResetAll.apply(&mut meta);
        assert_eq!(meta.len(), 1, "startup metadata is kept");
    }
}
