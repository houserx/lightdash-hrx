//! `federation-engine.toml` (CONTRACTS §1.4 plus the extensions in PROGRESS.md, A25).
//!
//! [`Config::load`] parses the TOML, validates it and resolves every `*_env` indirection from the
//! process environment. It never binds a port or contacts a source, so `--check-config` is just
//! `load` plus a summary. Secrets are held in [`Secret`], whose `Debug` never shows the value, and
//! error messages name env vars, never their values.

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::Deserialize;

pub const DEFAULT_MAX_ROWS: u64 = 100_000;
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 1_000;
pub const DEFAULT_S3_RETENTION_DAYS: u64 = 2_555;
pub const DEFAULT_BIGQUERY_API_BASE_URL: &str = "https://bigquery.googleapis.com";
pub const DEFAULT_GCP_STS_URL: &str = "https://sts.googleapis.com/v1/token";
pub const DEFAULT_GCP_IAM_CREDENTIALS_URL: &str = "https://iamcredentials.googleapis.com";

/// A secret resolved from an env var. `Debug` and `Display` are redacted.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret {
    env: String,
    value: String,
}

impl Secret {
    /// The secret value. Never log it.
    pub fn expose(&self) -> &str {
        &self.value
    }

    /// The env var the value came from (safe to log).
    pub fn env_name(&self) -> &str {
        &self.env
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Secret(${}, redacted)", self.env)
    }
}

/// Every problem found in a config file, one message per problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub problems: Vec<String>,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, p) in self.problems.iter().enumerate() {
            if i > 0 {
                writeln!(f)?;
            }
            write!(f, "{p}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigError {}

impl ConfigError {
    fn one(msg: impl Into<String>) -> Self {
        ConfigError {
            problems: vec![msg.into()],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SourceKind {
    Prometheus,
    Loki,
    Cloudwatch,
    CloudwatchLogs,
    Tempo,
    PlatformPostgres,
    Bigquery,
}

impl SourceKind {
    pub const ALL: [SourceKind; 7] = [
        SourceKind::Prometheus,
        SourceKind::Loki,
        SourceKind::Cloudwatch,
        SourceKind::CloudwatchLogs,
        SourceKind::Tempo,
        SourceKind::PlatformPostgres,
        SourceKind::Bigquery,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::Prometheus => "prometheus",
            SourceKind::Loki => "loki",
            SourceKind::Cloudwatch => "cloudwatch",
            SourceKind::CloudwatchLogs => "cloudwatch_logs",
            SourceKind::Tempo => "tempo",
            SourceKind::PlatformPostgres => "platform_postgres",
            SourceKind::Bigquery => "bigquery",
        }
    }

    pub fn parse(s: &str) -> Option<SourceKind> {
        SourceKind::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

impl fmt::Display for SourceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub listen_pg: SocketAddr,
    pub listen_http: SocketAddr,
    /// HMAC key for identity and Write Mode confirmation tokens.
    pub identity_secret: Secret,
    pub max_rows: u64,
    pub test_mode: bool,
    pub tls: Option<TlsFiles>,
    pub users: Vec<User>,
    pub sources: Vec<Source>,
    pub audit: Option<Audit>,
}

#[derive(Debug, Clone)]
pub struct TlsFiles {
    pub cert_file: PathBuf,
    pub key_file: PathBuf,
}

#[derive(Debug, Clone)]
pub struct User {
    pub name: String,
    pub password: Secret,
}

#[derive(Debug, Clone)]
pub struct Source {
    pub name: String,
    /// `default = true` in the file. Use [`Config::default_source`] to resolve a kind's default.
    pub default: bool,
    pub restricted: bool,
    /// Per-source override of the top-level `max_rows`.
    pub max_rows: Option<u64>,
    pub settings: SourceSettings,
}

impl Source {
    pub fn kind(&self) -> SourceKind {
        match &self.settings {
            SourceSettings::Prometheus { .. } => SourceKind::Prometheus,
            SourceSettings::Loki { .. } => SourceKind::Loki,
            SourceSettings::Cloudwatch { .. } => SourceKind::Cloudwatch,
            SourceSettings::CloudwatchLogs { .. } => SourceKind::CloudwatchLogs,
            SourceSettings::Tempo { .. } => SourceKind::Tempo,
            SourceSettings::PlatformPostgres { .. } => SourceKind::PlatformPostgres,
            SourceSettings::Bigquery(_) => SourceKind::Bigquery,
        }
    }

    /// Queries against this source are Audited Queries (they need `[audit]`).
    pub fn is_audited(&self) -> bool {
        self.restricted
            || match &self.settings {
                SourceSettings::Loki {
                    restricted_selectors,
                    ..
                } => !restricted_selectors.is_empty(),
                SourceSettings::CloudwatchLogs {
                    restricted_log_groups,
                    ..
                } => !restricted_log_groups.is_empty(),
                SourceSettings::PlatformPostgres { .. } => true,
                _ => false,
            }
    }
}

#[derive(Debug, Clone)]
pub struct AwsSettings {
    pub region: String,
    pub role_arn: Option<String>,
    pub endpoint_url: Option<String>,
    pub sts_endpoint_url: Option<String>,
}

#[derive(Debug, Clone)]
pub enum SourceSettings {
    Prometheus {
        url: String,
    },
    Loki {
        url: String,
        restricted_selectors: Vec<String>,
    },
    Cloudwatch {
        aws: AwsSettings,
    },
    CloudwatchLogs {
        aws: AwsSettings,
        restricted_log_groups: Vec<String>,
        poll_interval_ms: u64,
    },
    Tempo {
        url: String,
    },
    PlatformPostgres {
        read_url: Secret,
        /// `None` when `write_url_env` is absent: Write Mode is off.
        write_url: Option<Secret>,
    },
    Bigquery(BigQuerySettings),
}

#[derive(Debug, Clone)]
pub struct BigQuerySettings {
    pub project: String,
    /// `dataset.table` entries exposed as Ops Marts.
    pub allow: Vec<String>,
    pub api_base_url: String,
    pub auth: BigQueryAuth,
}

#[derive(Debug, Clone)]
pub enum BigQueryAuth {
    StaticToken(Secret),
    WorkloadIdentity {
        audience: String,
        service_account: String,
        sts_url: String,
        iam_credentials_url: String,
    },
}

#[derive(Debug, Clone)]
pub struct Audit {
    pub dynamodb_table: String,
    pub s3_bucket: String,
    /// `None` without `integrity_key_env`: the hash falls back to `sha256:` (A13).
    pub integrity_key: Option<Secret>,
    pub region: Option<String>,
    pub dynamodb_endpoint_url: Option<String>,
    pub s3_endpoint_url: Option<String>,
    pub s3_retention_days: u64,
}

impl Config {
    /// Reads, validates and resolves `path` against the process environment.
    pub fn load(path: &Path) -> Result<Config, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|e| {
            ConfigError::one(format!("cannot read config file {}: {e}", path.display()))
        })?;
        Config::from_toml(&text, |name| std::env::var(name).ok())
    }

    /// Validates `text` and resolves `*_env` names through `env`.
    pub fn from_toml(
        text: &str,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Config, ConfigError> {
        let raw: RawConfig =
            toml::from_str(text).map_err(|e| ConfigError::one(format!("invalid TOML: {e}")))?;
        Validator {
            env: &env,
            problems: Vec::new(),
        }
        .run(raw)
    }

    /// The default source of `kind`: the one with `default = true`, else the only source of that kind.
    pub fn default_source(&self, kind: SourceKind) -> Option<&Source> {
        let of_kind: Vec<&Source> = self.sources.iter().filter(|s| s.kind() == kind).collect();
        match of_kind[..] {
            [only] => Some(only),
            _ => of_kind.into_iter().find(|s| s.default),
        }
    }

    pub fn source(&self, name: &str) -> Option<&Source> {
        self.sources.iter().find(|s| s.name == name)
    }
}

// ---- raw file shape -------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    listen_pg: String,
    listen_http: String,
    identity_secret_env: String,
    max_rows: Option<u64>,
    #[serde(default)]
    test_mode: bool,
    tls_cert_file: Option<PathBuf>,
    tls_key_file: Option<PathBuf>,
    #[serde(default)]
    users: Vec<RawUser>,
    #[serde(default)]
    sources: Vec<RawSource>,
    audit: Option<RawAudit>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawUser {
    name: String,
    password_env: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSource {
    name: String,
    kind: String,
    #[serde(default)]
    default: bool,
    #[serde(default)]
    restricted: bool,
    max_rows: Option<u64>,
    // prometheus | loki | tempo
    url: Option<String>,
    // loki
    restricted_selectors: Option<Vec<String>>,
    // cloudwatch | cloudwatch_logs
    region: Option<String>,
    role_arn: Option<String>,
    endpoint_url: Option<String>,
    sts_endpoint_url: Option<String>,
    restricted_log_groups: Option<Vec<String>>,
    poll_interval_ms: Option<u64>,
    // platform_postgres
    read_url_env: Option<String>,
    write_url_env: Option<String>,
    // bigquery
    project: Option<String>,
    allow: Option<Vec<String>>,
    api_base_url: Option<String>,
    access_token_env: Option<String>,
    workload_identity_audience: Option<String>,
    service_account: Option<String>,
    gcp_sts_url: Option<String>,
    gcp_iam_credentials_url: Option<String>,
}

impl RawSource {
    /// Keys that are set, by name, for the "not valid for this kind" check.
    fn set_keys(&self) -> Vec<&'static str> {
        let opts: [(&'static str, bool); 18] = [
            ("url", self.url.is_some()),
            ("restricted_selectors", self.restricted_selectors.is_some()),
            ("region", self.region.is_some()),
            ("role_arn", self.role_arn.is_some()),
            ("endpoint_url", self.endpoint_url.is_some()),
            ("sts_endpoint_url", self.sts_endpoint_url.is_some()),
            (
                "restricted_log_groups",
                self.restricted_log_groups.is_some(),
            ),
            ("poll_interval_ms", self.poll_interval_ms.is_some()),
            ("read_url_env", self.read_url_env.is_some()),
            ("write_url_env", self.write_url_env.is_some()),
            ("project", self.project.is_some()),
            ("allow", self.allow.is_some()),
            ("api_base_url", self.api_base_url.is_some()),
            ("access_token_env", self.access_token_env.is_some()),
            (
                "workload_identity_audience",
                self.workload_identity_audience.is_some(),
            ),
            ("service_account", self.service_account.is_some()),
            ("gcp_sts_url", self.gcp_sts_url.is_some()),
            (
                "gcp_iam_credentials_url",
                self.gcp_iam_credentials_url.is_some(),
            ),
        ];
        opts.into_iter()
            .filter_map(|(k, set)| set.then_some(k))
            .collect()
    }
}

fn kind_keys(kind: SourceKind) -> &'static [&'static str] {
    const AWS: &[&str] = &["region", "role_arn", "endpoint_url", "sts_endpoint_url"];
    match kind {
        SourceKind::Prometheus | SourceKind::Tempo => &["url"],
        SourceKind::Loki => &["url", "restricted_selectors"],
        SourceKind::Cloudwatch => AWS,
        SourceKind::CloudwatchLogs => &[
            "region",
            "role_arn",
            "endpoint_url",
            "sts_endpoint_url",
            "restricted_log_groups",
            "poll_interval_ms",
        ],
        SourceKind::PlatformPostgres => &["read_url_env", "write_url_env"],
        SourceKind::Bigquery => &[
            "project",
            "allow",
            "api_base_url",
            "access_token_env",
            "workload_identity_audience",
            "service_account",
            "gcp_sts_url",
            "gcp_iam_credentials_url",
        ],
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAudit {
    dynamodb_table: String,
    s3_bucket: String,
    integrity_key_env: Option<String>,
    region: Option<String>,
    dynamodb_endpoint_url: Option<String>,
    s3_endpoint_url: Option<String>,
    s3_retention_days: Option<u64>,
}

// ---- validation -----------------------------------------------------------------------------

struct Validator<'a> {
    env: &'a dyn Fn(&str) -> Option<String>,
    problems: Vec<String>,
}

/// Placeholder used after a problem was recorded, so validation can go on and report everything.
fn placeholder_addr() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 0))
}

impl Validator<'_> {
    fn problem(&mut self, msg: String) {
        self.problems.push(msg);
    }

    /// Resolves the env var `name` referenced by `key`. Messages name the variable, never a value.
    fn secret(&mut self, key: &str, name: &str) -> Secret {
        let value = if name.trim().is_empty() {
            self.problem(format!(
                "{key} is empty; it must name an environment variable"
            ));
            String::new()
        } else {
            match (self.env)(name) {
                Some(v) if !v.is_empty() => v,
                Some(_) => {
                    self.problem(format!(
                        "environment variable {name} (from {key}) is set but empty"
                    ));
                    String::new()
                }
                None => {
                    self.problem(format!(
                        "environment variable {name} (from {key}) is not set"
                    ));
                    String::new()
                }
            }
        };
        Secret {
            env: name.to_string(),
            value,
        }
    }

    fn addr(&mut self, key: &str, value: &str) -> SocketAddr {
        value.parse().unwrap_or_else(|e| {
            self.problem(format!(
                "{key} = \"{value}\" is not a socket address (host:port): {e}"
            ));
            placeholder_addr()
        })
    }

    fn positive(&mut self, key: &str, value: Option<u64>, default: u64) -> u64 {
        match value {
            Some(0) => {
                self.problem(format!("{key} must be greater than 0"));
                default
            }
            Some(v) => v,
            None => default,
        }
    }

    fn http_url(&mut self, key: &str, value: &str) {
        let rest = value
            .strip_prefix("http://")
            .or_else(|| value.strip_prefix("https://"));
        if rest.is_none_or(|r| r.is_empty() || r.starts_with('/')) {
            self.problem(format!("{key} = \"{value}\" is not an http(s) URL"));
        }
    }

    fn required<'s>(&mut self, src: &str, key: &str, value: &'s Option<String>) -> &'s str {
        match value.as_deref() {
            Some(v) if !v.trim().is_empty() => v,
            _ => {
                self.problem(format!("source \"{src}\": {key} is required"));
                ""
            }
        }
    }

    fn run(mut self, raw: RawConfig) -> Result<Config, ConfigError> {
        let listen_pg = self.addr("listen_pg", &raw.listen_pg);
        let listen_http = self.addr("listen_http", &raw.listen_http);
        if raw.listen_pg == raw.listen_http {
            self.problem("listen_pg and listen_http must differ".into());
        }
        let identity_secret = self.secret("identity_secret_env", &raw.identity_secret_env);
        let max_rows = self.positive("max_rows", raw.max_rows, DEFAULT_MAX_ROWS);
        let tls = match (raw.tls_cert_file, raw.tls_key_file) {
            (Some(cert_file), Some(key_file)) => Some(TlsFiles {
                cert_file,
                key_file,
            }),
            (None, None) => None,
            _ => {
                self.problem("tls_cert_file and tls_key_file must be set together".into());
                None
            }
        };

        let mut user_names = HashSet::new();
        let mut users = Vec::with_capacity(raw.users.len());
        for u in raw.users {
            if u.name.is_empty() {
                self.problem("[[users]] entry has an empty name".into());
            } else if !user_names.insert(u.name.clone()) {
                self.problem(format!("duplicate user name \"{}\"", u.name));
            }
            let key = format!("users \"{}\" password_env", u.name);
            let password = self.secret(&key, &u.password_env);
            users.push(User {
                name: u.name,
                password,
            });
        }

        let mut source_names = HashSet::new();
        let mut defaults: BTreeMap<SourceKind, Vec<String>> = BTreeMap::new();
        let mut sources = Vec::with_capacity(raw.sources.len());
        for s in raw.sources {
            if s.name.is_empty() {
                self.problem("[[sources]] entry has an empty name".into());
            } else if !source_names.insert(s.name.clone()) {
                self.problem(format!("duplicate source name \"{}\"", s.name));
            }
            let Some(kind) = SourceKind::parse(&s.kind) else {
                let known: Vec<&str> = SourceKind::ALL.iter().map(|k| k.as_str()).collect();
                self.problem(format!(
                    "source \"{}\": unknown kind \"{}\" (expected one of: {})",
                    s.name,
                    s.kind,
                    known.join(", ")
                ));
                continue;
            };
            if s.default {
                defaults.entry(kind).or_default().push(s.name.clone());
            }
            let source = self.source(kind, s);
            sources.push(source);
        }
        for (kind, names) in &defaults {
            if names.len() > 1 {
                self.problem(format!(
                    "more than one default {kind} source: {} (at most one source per kind may set default = true)",
                    names
                        .iter()
                        .map(|n| format!("\"{n}\""))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
        }

        let audit = raw.audit.map(|a| self.audit(a));
        if audit.is_none() {
            let audited: Vec<String> = sources
                .iter()
                .filter(|s| s.is_audited())
                .map(|s| format!("\"{}\"", s.name))
                .collect();
            if !audited.is_empty() {
                self.problem(format!(
                    "audited sources {} need an [audit] table (dynamodb_table, s3_bucket)",
                    audited.join(", ")
                ));
            }
        }

        if !self.problems.is_empty() {
            return Err(ConfigError {
                problems: self.problems,
            });
        }
        Ok(Config {
            listen_pg,
            listen_http,
            identity_secret,
            max_rows,
            test_mode: raw.test_mode,
            tls,
            users,
            sources,
            audit,
        })
    }

    fn source(&mut self, kind: SourceKind, s: RawSource) -> Source {
        let name = s.name.clone();
        let allowed = kind_keys(kind);
        for key in s.set_keys() {
            if !allowed.contains(&key) {
                self.problem(format!("source \"{name}\": {key} is not a {kind} setting"));
            }
        }
        let max_rows = s
            .max_rows
            .map(|v| self.positive(&format!("source \"{name}\": max_rows"), Some(v), 1));
        let aws = |v: &mut Self, s: &RawSource| AwsSettings {
            region: v.required(&name, "region", &s.region).to_string(),
            role_arn: s.role_arn.clone(),
            endpoint_url: s.endpoint_url.clone(),
            sts_endpoint_url: s.sts_endpoint_url.clone(),
        };
        let url = |v: &mut Self, s: &RawSource| {
            let url = v.required(&name, "url", &s.url).to_string();
            if !url.is_empty() {
                v.http_url(&format!("source \"{name}\": url"), &url);
            }
            url
        };
        let settings = match kind {
            SourceKind::Prometheus => SourceSettings::Prometheus { url: url(self, &s) },
            SourceKind::Tempo => SourceSettings::Tempo { url: url(self, &s) },
            SourceKind::Loki => SourceSettings::Loki {
                url: url(self, &s),
                restricted_selectors: s.restricted_selectors.clone().unwrap_or_default(),
            },
            SourceKind::Cloudwatch => SourceSettings::Cloudwatch { aws: aws(self, &s) },
            SourceKind::CloudwatchLogs => SourceSettings::CloudwatchLogs {
                aws: aws(self, &s),
                restricted_log_groups: s.restricted_log_groups.clone().unwrap_or_default(),
                poll_interval_ms: self.positive(
                    &format!("source \"{name}\": poll_interval_ms"),
                    s.poll_interval_ms,
                    DEFAULT_POLL_INTERVAL_MS,
                ),
            },
            SourceKind::PlatformPostgres => {
                let read_env = self
                    .required(&name, "read_url_env", &s.read_url_env)
                    .to_string();
                let read_url = if read_env.is_empty() {
                    Secret {
                        env: String::new(),
                        value: String::new(),
                    }
                } else {
                    self.secret(&format!("source \"{name}\": read_url_env"), &read_env)
                };
                let write_url = s
                    .write_url_env
                    .as_deref()
                    .map(|w| self.secret(&format!("source \"{name}\": write_url_env"), w));
                SourceSettings::PlatformPostgres {
                    read_url,
                    write_url,
                }
            }
            SourceKind::Bigquery => SourceSettings::Bigquery(self.bigquery(&name, &s)),
        };
        Source {
            name,
            default: s.default,
            restricted: s.restricted,
            max_rows,
            settings,
        }
    }

    fn bigquery(&mut self, name: &str, s: &RawSource) -> BigQuerySettings {
        let project = self.required(name, "project", &s.project).to_string();
        let allow = s.allow.clone().unwrap_or_default();
        for entry in &allow {
            let ok = matches!(entry.split_once('.'), Some((d, t)) if !d.is_empty() && !t.is_empty() && !t.contains('.'));
            if !ok {
                self.problem(format!(
                    "source \"{name}\": allow entry \"{entry}\" must be dataset.table"
                ));
            }
        }
        let api_base_url = s
            .api_base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BIGQUERY_API_BASE_URL.to_string());
        self.http_url(&format!("source \"{name}\": api_base_url"), &api_base_url);
        let auth = match (
            &s.access_token_env,
            &s.workload_identity_audience,
            &s.service_account,
        ) {
            (Some(env), None, None) => BigQueryAuth::StaticToken(
                self.secret(&format!("source \"{name}\": access_token_env"), env),
            ),
            (None, Some(audience), Some(service_account)) => BigQueryAuth::WorkloadIdentity {
                audience: audience.clone(),
                service_account: service_account.clone(),
                sts_url: s
                    .gcp_sts_url
                    .clone()
                    .unwrap_or_else(|| DEFAULT_GCP_STS_URL.to_string()),
                iam_credentials_url: s
                    .gcp_iam_credentials_url
                    .clone()
                    .unwrap_or_else(|| DEFAULT_GCP_IAM_CREDENTIALS_URL.to_string()),
            },
            _ => {
                self.problem(format!(
                    "source \"{name}\": set either access_token_env, or both workload_identity_audience and service_account"
                ));
                BigQueryAuth::StaticToken(Secret {
                    env: String::new(),
                    value: String::new(),
                })
            }
        };
        BigQuerySettings {
            project,
            allow,
            api_base_url,
            auth,
        }
    }

    fn audit(&mut self, a: RawAudit) -> Audit {
        if a.dynamodb_table.trim().is_empty() {
            self.problem("[audit] dynamodb_table is empty".into());
        }
        if a.s3_bucket.trim().is_empty() {
            self.problem("[audit] s3_bucket is empty".into());
        }
        let integrity_key = a
            .integrity_key_env
            .as_deref()
            .map(|env| self.secret("[audit] integrity_key_env", env));
        let s3_retention_days = self.positive(
            "[audit] s3_retention_days",
            a.s3_retention_days,
            DEFAULT_S3_RETENTION_DAYS,
        );
        Audit {
            dynamodb_table: a.dynamodb_table,
            s3_bucket: a.s3_bucket,
            integrity_key,
            region: a.region,
            dynamodb_endpoint_url: a.dynamodb_endpoint_url,
            s3_endpoint_url: a.s3_endpoint_url,
            s3_retention_days,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = r#"
listen_pg = "127.0.0.1:5433"
listen_http = "127.0.0.1:8088"
identity_secret_env = "ID_SECRET"

[[users]]
name = "lightdash-operations"
password_env = "PG_PASSWORD"

[[sources]]
name = "prom-a"
kind = "prometheus"
url = "http://127.0.0.1:9"

[[sources]]
name = "platform"
kind = "platform_postgres"
read_url_env = "READ_URL"

[audit]
dynamodb_table = "t"
s3_bucket = "b"
"#;

    fn env(name: &str) -> Option<String> {
        match name {
            "ID_SECRET" | "PG_PASSWORD" | "READ_URL" => Some(format!("test-{name}-not-real")),
            _ => None,
        }
    }

    fn problems(text: &str) -> Vec<String> {
        Config::from_toml(text, env).unwrap_err().problems
    }

    #[test]
    fn valid_config_resolves_secrets_and_defaults() {
        let cfg = Config::from_toml(BASE, env).unwrap();
        assert_eq!(cfg.max_rows, DEFAULT_MAX_ROWS);
        assert_eq!(cfg.identity_secret.expose(), "test-ID_SECRET-not-real");
        assert!(
            !format!("{cfg:?}").contains("not-real"),
            "Debug must redact secrets"
        );
        assert_eq!(
            cfg.default_source(SourceKind::Prometheus).unwrap().name,
            "prom-a",
            "a lone source of a kind is its default"
        );
        let SourceSettings::PlatformPostgres { write_url, .. } =
            &cfg.source("platform").unwrap().settings
        else {
            panic!("platform kind");
        };
        assert!(write_url.is_none(), "no write_url_env means Write Mode off");
    }

    #[test]
    fn default_source_with_two_of_a_kind() {
        let two = BASE.replace(
            "[[sources]]\nname = \"platform\"",
            "[[sources]]\nname = \"prom-b\"\nkind = \"prometheus\"\nurl = \"http://x\"\ndefault = true\n\n[[sources]]\nname = \"platform\"",
        );
        let cfg = Config::from_toml(&two, env).unwrap();
        assert_eq!(
            cfg.default_source(SourceKind::Prometheus).unwrap().name,
            "prom-b"
        );
        let none = two.replace("default = true\n", "");
        let cfg = Config::from_toml(&none, env).unwrap();
        assert!(cfg.default_source(SourceKind::Prometheus).is_none());
    }

    #[test]
    fn reports_every_problem_without_values() {
        let bad = BASE
            .replace("\"PG_PASSWORD\"", "\"MISSING_PW\"")
            .replace("kind = \"prometheus\"", "kind = \"graphite\"");
        let p = problems(&bad);
        assert_eq!(p.len(), 2, "{p:?}");
        assert!(p[0].contains("MISSING_PW"), "{p:?}");
        assert!(p[1].contains("graphite"), "{p:?}");
    }

    #[test]
    fn audited_sources_need_audit() {
        let no_audit = BASE.split("[audit]").next().unwrap();
        let p = problems(no_audit);
        assert!(
            p[0].contains("\"platform\"") && p[0].contains("[audit]"),
            "{p:?}"
        );
        let restricted_only = no_audit
            .replace("[[sources]]\nname = \"platform\"\nkind = \"platform_postgres\"\nread_url_env = \"READ_URL\"\n", "")
            .replace("url = \"http://127.0.0.1:9\"", "url = \"http://127.0.0.1:9\"\nrestricted = true");
        assert!(problems(&restricted_only)[0].contains("prom-a"));
    }

    #[test]
    fn rejects_keys_of_other_kinds_and_unknown_keys() {
        let p = problems(&BASE.replace(
            "url = \"http://127.0.0.1:9\"",
            "url = \"http://127.0.0.1:9\"\nregion = \"us-east-2\"",
        ));
        assert!(p[0].contains("region is not a prometheus setting"), "{p:?}");
        let p = problems(
            &BASE
                .replace("max_rows", "x")
                .replace("[audit]", "[audit]\nbogus = 1"),
        );
        assert!(p[0].contains("bogus"), "{p:?}");
    }

    #[test]
    fn bigquery_needs_one_auth_and_dataset_table_allow() {
        let bq = format!(
            "{BASE}\n[[sources]]\nname = \"marts\"\nkind = \"bigquery\"\nproject = \"p\"\nallow = [\"just_table\"]\n"
        )
        .replace("[audit]\ndynamodb_table = \"t\"\ns3_bucket = \"b\"\n", "")
            + "\n[audit]\ndynamodb_table = \"t\"\ns3_bucket = \"b\"\n";
        let p = problems(&bq);
        assert!(p.iter().any(|m| m.contains("just_table")), "{p:?}");
        assert!(p.iter().any(|m| m.contains("access_token_env")), "{p:?}");
    }
}
