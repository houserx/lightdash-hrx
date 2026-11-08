//! Picking the source a table-function call reads: the named one or the kind's default
//! (CONTRACTS §1.1), with its row cap, and for the HTTP sources (`prometheus`, `loki`) its base
//! URL.

use std::collections::HashMap;

use datafusion::error::DataFusionError;
use engine_config::{Config, SourceKind, SourceSettings};

use crate::session::sqlstate;

/// A resolved source: its name, base URL (no trailing `/`) and row cap.
#[derive(Debug, Clone)]
pub struct HttpSource {
    pub name: String,
    pub url: String,
    /// More rows than this is an error (SQLSTATE 54000), never a silent truncation.
    pub max_rows: usize,
}

/// The configured sources of one HTTP kind.
#[derive(Debug, Clone)]
pub struct HttpSources {
    kind: SourceKind,
    /// Base URL by source name, for every source of `kind`.
    urls: HashMap<String, String>,
    /// Kind by source name, for every source (to name a kind mismatch).
    kinds: HashMap<String, SourceKind>,
    /// Row cap by source name: the source's `max_rows`, else the top-level one.
    max_rows: HashMap<String, usize>,
    /// Sources that need an identity, which this engine doesn't check yet.
    restricted: Vec<String>,
    default: Option<String>,
}

impl HttpSources {
    pub fn new(config: &Config, kind: SourceKind) -> HttpSources {
        HttpSources {
            kind,
            urls: config
                .sources
                .iter()
                .filter(|s| s.kind() == kind)
                .filter_map(|s| {
                    let url = base_url(&s.settings)?.trim_end_matches('/').to_string();
                    Some((s.name.clone(), url))
                })
                .collect(),
            kinds: config
                .sources
                .iter()
                .map(|s| (s.name.clone(), s.kind()))
                .collect(),
            max_rows: config
                .sources
                .iter()
                .map(|s| {
                    let cap = s.max_rows.unwrap_or(config.max_rows);
                    (s.name.clone(), usize::try_from(cap).unwrap_or(usize::MAX))
                })
                .collect(),
            restricted: config
                .sources
                .iter()
                .filter(|s| s.kind() == kind && is_restricted(&s.settings, s.restricted))
                .map(|s| s.name.clone())
                .collect(),
            default: config.default_source(kind).map(|s| s.name.clone()),
        }
    }

    /// The source a call names, or the kind's default source, with its base URL.
    pub fn resolve(&self, name: Option<String>) -> Result<HttpSource, DataFusionError> {
        let (name, max_rows) = self.pick(name)?;
        let url = self.urls.get(&name).cloned().unwrap_or_default();
        Ok(HttpSource {
            name,
            url,
            max_rows,
        })
    }

    /// The name and row cap of the source a call names, or of the kind's default source. Any
    /// kind, including ones without a base URL (`cloudwatch`).
    pub fn pick(&self, name: Option<String>) -> Result<(String, usize), DataFusionError> {
        let kind = self.kind.as_str();
        let name = match name {
            Some(name) => name,
            None => self.default.clone().ok_or_else(|| {
                sqlstate(
                    "42704",
                    format!("there is no default {kind} source; name one as the source argument"),
                )
            })?,
        };
        match self.kinds.get(&name) {
            Some(k) if *k == self.kind => {}
            Some(other) => {
                return Err(sqlstate(
                    "42809",
                    format!("source \"{name}\" is a {} source, not {kind}", other.as_str()),
                ));
            }
            None => return Err(sqlstate("42704", format!("source \"{name}\" does not exist"))),
        }
        if self.restricted.contains(&name) {
            // Fail closed until identity tokens are verified (CONTRACTS §1.2).
            return Err(sqlstate(
                "42501",
                format!("source \"{name}\" is Restricted Telemetry and needs telemetry_restricted"),
            ));
        }
        let max_rows = self.max_rows.get(&name).copied().unwrap_or(usize::MAX);
        Ok((name, max_rows))
    }
}

/// The base URL of an HTTP source.
fn base_url(settings: &SourceSettings) -> Option<&String> {
    match settings {
        SourceSettings::Prometheus { url } | SourceSettings::Loki { url, .. } => Some(url),
        _ => None,
    }
}

/// A `restricted = true` source, a Loki source with `restricted_selectors` or a CloudWatch Logs
/// source with `restricted_log_groups`: until identity tokens are verified and selectors and log
/// groups are checked for overlap, every query to it may touch Restricted Telemetry.
fn is_restricted(settings: &SourceSettings, restricted: bool) -> bool {
    restricted
        || match settings {
            SourceSettings::Loki {
                restricted_selectors,
                ..
            } => !restricted_selectors.is_empty(),
            SourceSettings::CloudwatchLogs {
                restricted_log_groups,
                ..
            } => !restricted_log_groups.is_empty(),
            _ => false,
        }
}
