//! `GET /healthz` (CONTRACTS §1.3): 200 when every configured source is reachable, otherwise 503
//! with the unhealthy sources listed. No auth.
//!
//! "Reachable" is a TCP connect to the source's endpoint within [`PROBE_TIMEOUT`]. It needs no
//! credentials and means the same for every kind:
//! - `prometheus`, `loki`, `tempo`: the source `url`;
//! - `cloudwatch`, `cloudwatch_logs`: `endpoint_url`, else the regional AWS endpoint
//!   (`monitoring.<region>.amazonaws.com`, `logs.<region>.amazonaws.com`) on 443;
//! - `platform_postgres`: every host of the read URL (default port 5432);
//! - `bigquery`: `api_base_url`.
//!
//! All sources are probed concurrently on each request. The body is JSON and names each source,
//! its kind and whether it is reachable; it never carries addresses or credentials, since the
//! endpoint is unauthenticated.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use engine_config::{Config, Source, SourceSettings};
use serde_json::{Value, json};
use tokio::net::TcpStream;

/// How long one source's connect may take before it counts as unreachable.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// One source to probe: its name, kind and the `host:port` endpoints that must all accept a
/// connection (or the reason none could be derived from its config).
#[derive(Debug, Clone)]
struct Target {
    name: String,
    kind: &'static str,
    endpoints: Result<Vec<(String, u16)>, String>,
}

#[derive(Debug, Clone)]
pub struct Health {
    targets: Vec<Target>,
}

impl Health {
    pub fn new(config: &Config) -> Health {
        let targets = config
            .sources
            .iter()
            .map(|s| Target {
                name: s.name.clone(),
                kind: s.kind().as_str(),
                endpoints: endpoints(s),
            })
            .collect();
        Health { targets }
    }

    /// Probes every source and returns the HTTP status and body.
    pub async fn check(&self) -> (StatusCode, Value) {
        let results = futures::future::join_all(
            self.targets
                .iter()
                .map(|t| async move { (t, probe(&t.endpoints).await) }),
        )
        .await;
        let unhealthy: Vec<&str> = results
            .iter()
            .filter(|(_, r)| r.is_err())
            .map(|(t, _)| t.name.as_str())
            .collect();
        let sources: Vec<Value> = results
            .iter()
            .map(|(t, r)| match r {
                Ok(()) => json!({"name": t.name, "kind": t.kind, "reachable": true}),
                Err(e) => json!({"name": t.name, "kind": t.kind, "reachable": false, "error": e}),
            })
            .collect();
        let (status, word) = if unhealthy.is_empty() {
            (StatusCode::OK, "ok")
        } else {
            (StatusCode::SERVICE_UNAVAILABLE, "unhealthy")
        };
        let body = json!({"status": word, "sources": sources, "unhealthy": unhealthy});
        (status, body)
    }
}

pub async fn handle(State(health): State<Arc<Health>>) -> (StatusCode, Json<Value>) {
    let (status, body) = health.check().await;
    (status, Json(body))
}

/// Connects to every endpoint; the first failure is the source's error.
async fn probe(endpoints: &Result<Vec<(String, u16)>, String>) -> Result<(), String> {
    let endpoints = endpoints.as_ref().map_err(Clone::clone)?;
    let connects = endpoints.iter().map(|(host, port)| async move {
        match tokio::time::timeout(PROBE_TIMEOUT, TcpStream::connect((host.as_str(), *port))).await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(format!("unreachable: {e}")),
            Err(_) => Err(format!(
                "unreachable: no connection within {} s",
                PROBE_TIMEOUT.as_secs()
            )),
        }
    });
    futures::future::join_all(connects)
        .await
        .into_iter()
        .collect()
}

fn endpoints(source: &Source) -> Result<Vec<(String, u16)>, String> {
    match &source.settings {
        SourceSettings::Prometheus { url }
        | SourceSettings::Loki { url, .. }
        | SourceSettings::Tempo { url } => url_endpoint(url).map(|e| vec![e]),
        SourceSettings::Bigquery(bq) => url_endpoint(&bq.api_base_url).map(|e| vec![e]),
        SourceSettings::Cloudwatch { aws } => {
            aws_endpoint(&aws.endpoint_url, "monitoring", &aws.region)
        }
        SourceSettings::CloudwatchLogs { aws, .. } => {
            aws_endpoint(&aws.endpoint_url, "logs", &aws.region)
        }
        SourceSettings::PlatformPostgres { read_url, .. } => postgres_endpoints(read_url.expose()),
    }
}

fn url_endpoint(url: &str) -> Result<(String, u16), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    let host = parsed.host_str().ok_or("invalid url: no host")?;
    let port = parsed
        .port_or_known_default()
        .ok_or("invalid url: no port")?;
    // `Url` keeps the brackets of an IPv6 literal; `TcpStream::connect` wants it bare.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    Ok((host.to_string(), port))
}

fn aws_endpoint(
    endpoint_url: &Option<String>,
    service: &str,
    region: &str,
) -> Result<Vec<(String, u16)>, String> {
    match endpoint_url {
        Some(url) => url_endpoint(url).map(|e| vec![e]),
        None => Ok(vec![(format!("{service}.{region}.amazonaws.com"), 443)]),
    }
}

/// The read URL's TCP hosts. The error never echoes the URL: it holds the password.
fn postgres_endpoints(read_url: &str) -> Result<Vec<(String, u16)>, String> {
    let config = tokio_postgres::Config::from_str(read_url)
        .map_err(|_| "invalid read_url (not a Postgres connection string)".to_string())?;
    let ports = config.get_ports();
    let port_for = |i: usize| match ports {
        [] => 5432,
        [one] => *one,
        many => many.get(i).copied().unwrap_or(5432),
    };
    let endpoints: Vec<(String, u16)> = config
        .get_hosts()
        .iter()
        .enumerate()
        .filter_map(|(i, h)| match h {
            tokio_postgres::config::Host::Tcp(host) => Some((host.clone(), port_for(i))),
            #[allow(unreachable_patterns)]
            _ => None,
        })
        .collect();
    if endpoints.is_empty() {
        return Err("read_url names no TCP host".to_string());
    }
    Ok(endpoints)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_endpoints_use_the_scheme_default_port() {
        assert_eq!(
            url_endpoint("https://bigquery.googleapis.com/bigquery/v2").unwrap(),
            ("bigquery.googleapis.com".to_string(), 443)
        );
        assert_eq!(
            url_endpoint("http://127.0.0.1:9090/").unwrap(),
            ("127.0.0.1".to_string(), 9090)
        );
        assert_eq!(
            url_endpoint("http://[::1]:3100").unwrap(),
            ("::1".to_string(), 3100)
        );
        assert!(url_endpoint("not a url").is_err());
    }

    #[test]
    fn aws_sources_default_to_the_regional_endpoint() {
        assert_eq!(
            aws_endpoint(&None, "logs", "us-east-2").unwrap(),
            vec![("logs.us-east-2.amazonaws.com".to_string(), 443)]
        );
        assert_eq!(
            aws_endpoint(&Some("http://127.0.0.1:4566".into()), "monitoring", "x").unwrap(),
            vec![("127.0.0.1".to_string(), 4566)]
        );
    }

    #[test]
    fn postgres_hosts_and_ports_without_leaking_the_url() {
        assert_eq!(
            postgres_endpoints("postgres://u:pw@db.internal:6543/app").unwrap(),
            vec![("db.internal".to_string(), 6543)]
        );
        assert_eq!(
            postgres_endpoints("host=a,b port=1,2 user=u").unwrap(),
            vec![("a".to_string(), 1), ("b".to_string(), 2)]
        );
        assert_eq!(
            postgres_endpoints("postgres://u@db/app").unwrap(),
            vec![("db".to_string(), 5432)]
        );
        let err = postgres_endpoints("postgres://u:secretpw@h:notaport/x").unwrap_err();
        assert!(!err.contains("secretpw"), "{err}");
    }
}
