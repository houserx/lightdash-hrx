//! Picking the source a table-function call reads: the named one or the kind's default
//! (CONTRACTS §1.1), with its row cap, and for the HTTP sources (`prometheus`, `loki`, `tempo`)
//! its base URL.

use std::collections::HashMap;

use datafusion::catalog::Session;
use datafusion::error::DataFusionError;
use engine_config::{Config, SourceKind, SourceSettings};

use crate::identity::Access;
use crate::selectors;
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
    /// `restricted = true` sources: reading one needs `telemetry_restricted` and is audited.
    restricted: Vec<String>,
    /// A Loki source's `restricted_selectors`: a query that may touch one of them is a read of
    /// Restricted Telemetry.
    restricted_selectors: HashMap<String, Vec<String>>,
    /// A CloudWatch Logs source's `restricted_log_groups`: a query naming one of them is a read
    /// of Restricted Telemetry.
    restricted_log_groups: HashMap<String, Vec<String>>,
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
                .filter(|s| s.kind() == kind && s.restricted)
                .map(|s| s.name.clone())
                .collect(),
            restricted_selectors: config
                .sources
                .iter()
                .filter(|s| s.kind() == kind)
                .filter_map(|s| match &s.settings {
                    SourceSettings::Loki {
                        restricted_selectors,
                        ..
                    } if !restricted_selectors.is_empty() => {
                        Some((s.name.clone(), restricted_selectors.clone()))
                    }
                    _ => None,
                })
                .collect(),
            restricted_log_groups: config
                .sources
                .iter()
                .filter(|s| s.kind() == kind)
                .filter_map(|s| match &s.settings {
                    SourceSettings::CloudwatchLogs {
                        restricted_log_groups,
                        ..
                    } if !restricted_log_groups.is_empty() => {
                        Some((s.name.clone(), restricted_log_groups.clone()))
                    }
                    _ => None,
                })
                .collect(),
            default: config.default_source(kind).map(|s| s.name.clone()),
        }
    }

    /// The source a call names, or the kind's default source, with its base URL.
    pub fn resolve(
        &self,
        name: Option<String>,
        session: &dyn Session,
    ) -> Result<HttpSource, DataFusionError> {
        let (name, max_rows) = self.pick(name, session)?;
        Ok(self.http_source(name, max_rows))
    }

    /// [`HttpSources::resolve`] for a LogQL `query`: on a Loki source with
    /// `restricted_selectors`, a query that may touch one of them (unless provably disjoint from
    /// all of them) needs the session's identity to allow it (42501 otherwise) and makes the
    /// statement an Audited Query.
    pub fn resolve_logql(
        &self,
        name: Option<String>,
        query: &str,
        session: &dyn Session,
    ) -> Result<HttpSource, DataFusionError> {
        let (name, max_rows) = self.pick(name, session)?;
        if let Some(selectors) = self.restricted_selectors.get(&name)
            && selectors::may_touch(query, selectors)
        {
            Access::require_restricted(session, &name)?;
        }
        Ok(self.http_source(name, max_rows))
    }

    /// [`HttpSources::pick`] for a `cloudwatch_logs` call over `log_groups` (already trimmed)
    /// running `query`: on a source with `restricted_log_groups`, a call that may touch one of
    /// them ([`touches_log_group`]) needs the session's identity to allow it (42501 otherwise)
    /// and makes the statement an Audited Query.
    pub fn pick_log_groups(
        &self,
        name: Option<String>,
        log_groups: &[String],
        query: &str,
        session: &dyn Session,
    ) -> Result<(String, usize), DataFusionError> {
        let (name, max_rows) = self.pick(name, session)?;
        if let Some(restricted) = self.restricted_log_groups.get(&name)
            && touches_log_group(log_groups, query, restricted)
        {
            Access::require_restricted(session, &name)?;
        }
        Ok((name, max_rows))
    }

    fn http_source(&self, name: String, max_rows: usize) -> HttpSource {
        let url = self.urls.get(&name).cloned().unwrap_or_default();
        HttpSource {
            name,
            url,
            max_rows,
        }
    }

    /// The name and row cap of the source a call names, or of the kind's default source. Any
    /// kind, including ones without a base URL (`cloudwatch`). A restricted source needs the
    /// session's identity to allow it (42501 otherwise) and makes the statement an Audited Query.
    pub fn pick(
        &self,
        name: Option<String>,
        session: &dyn Session,
    ) -> Result<(String, usize), DataFusionError> {
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
            Access::require_restricted(session, &name)?;
        }
        let max_rows = self.max_rows.get(&name).copied().unwrap_or(usize::MAX);
        Ok((name, max_rows))
    }
}

/// The base URL of an HTTP source.
fn base_url(settings: &SourceSettings) -> Option<&String> {
    match settings {
        SourceSettings::Prometheus { url }
        | SourceSettings::Loki { url, .. }
        | SourceSettings::Tempo { url } => Some(url),
        _ => None,
    }
}

/// Whether a Logs Insights call over `log_groups` running `query` may touch one of the
/// `restricted` log groups. Fails closed: a group touches when its name equals a restricted one
/// (both trimmed; names are case-sensitive in CloudWatch), or when it is an ARN
/// (`...:log-group:<name>` or `...:log-group:<name>:*`) of one; and every call whose query
/// starts with a `SOURCE` command (which picks log groups itself) touches.
pub fn touches_log_group(log_groups: &[String], query: &str, restricted: &[String]) -> bool {
    let restricted: Vec<&str> = restricted.iter().map(|g| g.trim()).collect();
    let starts_with_source = query
        .split_whitespace()
        .next()
        .is_some_and(|word| word.eq_ignore_ascii_case("source"));
    starts_with_source
        || log_groups.iter().any(|group| {
            let group = group.trim();
            let arn_name = group
                .rsplit_once(":log-group:")
                .map(|(_, rest)| rest.strip_suffix(":*").unwrap_or(rest));
            restricted.iter().any(|r| group == *r || arn_name == Some(*r))
        })
}

#[cfg(test)]
mod tests {
    use super::touches_log_group;

    fn groups(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn only_restricted_log_groups_touch() {
        let restricted = groups(&["/aws/rds/platform"]);
        let touches =
            |names: &[&str], query: &str| touches_log_group(&groups(names), query, &restricted);
        assert!(!touches(&["/aws/lambda/web"], "fields @message"));
        assert!(!touches(&["/aws/rds/platform-replica"], "fields @message"));
        assert!(!touches(&["/aws/rds/Platform"], "fields @message"));
        assert!(!touches(
            &["/aws/lambda/web"],
            "fields @message | filter @message like /SOURCE/"
        ));
        assert!(touches(&["/aws/rds/platform"], "fields @message"));
        assert!(touches(&["/aws/lambda/web", "/aws/rds/platform"], "fields @message"));
        assert!(touches(&[" /aws/rds/platform "], "fields @message"));
        assert!(touches(
            &["arn:aws:logs:us-east-2:123456789012:log-group:/aws/rds/platform:*"],
            "fields @message"
        ));
        assert!(touches(
            &["arn:aws:logs:us-east-2:123456789012:log-group:/aws/rds/platform"],
            "fields @message"
        ));
        assert!(touches(
            &["/aws/lambda/web"],
            "SOURCE logGroups(namePrefix: ['/aws/rds']) | fields @message"
        ));
        assert!(touches(&["/aws/lambda/web"], "  source logGroups() | fields @message"));
    }
}
