//! `GET /metrics` (CONTRACTS §1.3): Prometheus text exposition of per-source query counts,
//! latency histograms and errors, and of audit write failures. No auth.
//!
//! A "query" is one read of a source: one table-function call (`promql()`, `logql()`, ...), one
//! Ops Mart table scan or one Platform Database statement, timed from the request to the rows
//! being ready. A statement that reads two sources counts once for each. A read that fails (the
//! source is unreachable or answers an error, the answer is malformed or over `max_rows`) is
//! also an error. A read cut short (statement timeout, cancel request, client gone) still counts
//! as a query with the time it ran, but not as an error: the source did not fail.
//!
//! The registry is process-wide, like the process it describes. It holds no query text, user or
//! address: only source names (which are config) and numbers.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use axum::http::header;
use axum::response::IntoResponse;
use engine_config::Config;

/// Upper bounds (seconds) of the latency buckets: Prometheus' defaults, plus the long reads a
/// Logs Insights query or a wide range can take.
const BUCKETS: [f64; 15] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0,
];

/// The Prometheus text format version this endpoint speaks.
const CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

#[derive(Default, Clone)]
struct SourceStats {
    queries: u64,
    errors: u64,
    /// Observations at or below each of [`BUCKETS`] (not yet cumulative).
    buckets: [u64; BUCKETS.len()],
    seconds: f64,
}

#[derive(Default)]
struct Metrics {
    sources: Mutex<BTreeMap<String, SourceStats>>,
    audit_write_failures: AtomicU64,
}

static METRICS: LazyLock<Metrics> = LazyLock::new(Metrics::default);

/// Registers every configured source, so each has its series (at zero) before its first read.
pub fn init(config: &Config) {
    let mut sources = lock();
    for s in &config.sources {
        sources.entry(s.name.clone()).or_default();
    }
}

/// Runs one read of `source`, recording it as a query, its duration and whether it failed.
pub async fn observe<T, E>(source: &str, read: impl Future<Output = Result<T, E>>) -> Result<T, E> {
    let mut timer = Timer {
        source,
        started: Instant::now(),
        failed: false,
    };
    let result = read.await;
    timer.failed = result.is_err();
    result
}

/// Records one failed write of an audit record to the store.
pub fn audit_write_failed() {
    METRICS.audit_write_failures.fetch_add(1, Ordering::Relaxed);
}

/// Records the read on drop, so a read whose future is dropped mid-way (a cancel) counts too.
struct Timer<'a> {
    source: &'a str,
    started: Instant,
    failed: bool,
}

impl Drop for Timer<'_> {
    fn drop(&mut self) {
        record(
            self.source,
            self.started.elapsed().as_secs_f64(),
            self.failed,
        );
    }
}

fn record(source: &str, seconds: f64, failed: bool) {
    let mut sources = lock();
    let stats = sources.entry(source.to_string()).or_default();
    stats.queries += 1;
    stats.errors += u64::from(failed);
    stats.seconds += seconds;
    if let Some(i) = BUCKETS.iter().position(|&le| seconds <= le) {
        stats.buckets[i] += 1;
    }
}

fn lock() -> std::sync::MutexGuard<'static, BTreeMap<String, SourceStats>> {
    // A panic while holding the lock leaves plain counters behind; keep serving them.
    METRICS
        .sources
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `GET /metrics`.
pub async fn handle() -> impl IntoResponse {
    let sources = lock().clone();
    let failures = METRICS.audit_write_failures.load(Ordering::Relaxed);
    (
        [(header::CONTENT_TYPE, CONTENT_TYPE)],
        exposition(&sources, failures),
    )
}

fn exposition(sources: &BTreeMap<String, SourceStats>, audit_write_failures: u64) -> String {
    let mut text = String::new();
    family(
        &mut text,
        "federation_engine_queries_total",
        "counter",
        "Reads of a source (table-function calls, Ops Mart scans, Platform Database statements).",
    );
    for (name, s) in sources {
        let _ = writeln!(
            text,
            "federation_engine_queries_total{{source=\"{}\"}} {}",
            escape(name),
            s.queries
        );
    }
    family(
        &mut text,
        "federation_engine_query_errors_total",
        "counter",
        "Reads of a source that failed.",
    );
    for (name, s) in sources {
        let _ = writeln!(
            text,
            "federation_engine_query_errors_total{{source=\"{}\"}} {}",
            escape(name),
            s.errors
        );
    }
    family(
        &mut text,
        "federation_engine_query_duration_seconds",
        "histogram",
        "Time from sending a read to a source to its rows being ready.",
    );
    for (name, s) in sources {
        let label = escape(name);
        let mut cumulative = 0;
        for (le, n) in BUCKETS.iter().zip(s.buckets) {
            cumulative += n;
            let _ = writeln!(
                text,
                "federation_engine_query_duration_seconds_bucket{{source=\"{label}\",le=\"{le}\"}} {cumulative}"
            );
        }
        let _ = writeln!(
            text,
            "federation_engine_query_duration_seconds_bucket{{source=\"{label}\",le=\"+Inf\"}} {}\n\
             federation_engine_query_duration_seconds_sum{{source=\"{label}\"}} {}\n\
             federation_engine_query_duration_seconds_count{{source=\"{label}\"}} {}",
            s.queries, s.seconds, s.queries
        );
    }
    family(
        &mut text,
        "federation_engine_audit_write_failures_total",
        "counter",
        "Audit records (Audited Queries, Write Mode requests) the audit store did not accept.",
    );
    let _ = writeln!(
        text,
        "federation_engine_audit_write_failures_total {audit_write_failures}"
    );
    text
}

/// The `# HELP` and `# TYPE` lines that open a metric family.
fn family(text: &mut String, name: &str, kind: &str, help: &str) {
    let _ = writeln!(text, "# HELP {name} {help}\n# TYPE {name} {kind}");
}

/// A label value as the text format wants it: `\`, `"` and newlines escaped.
fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(observations: &[(f64, bool)]) -> SourceStats {
        let mut s = SourceStats::default();
        for &(seconds, failed) in observations {
            s.queries += 1;
            s.errors += u64::from(failed);
            s.seconds += seconds;
            if let Some(i) = BUCKETS.iter().position(|&le| seconds <= le) {
                s.buckets[i] += 1;
            }
        }
        s
    }

    #[test]
    fn histogram_buckets_are_cumulative_and_end_in_inf() {
        let sources = BTreeMap::from([(
            "prom".to_string(),
            stats(&[(0.003, false), (0.2, true), (1000.0, false)]),
        )]);
        let text = exposition(&sources, 0);
        let line = |prefix: &str| {
            text.lines()
                .find(|l| l.starts_with(prefix))
                .unwrap_or_else(|| panic!("no {prefix} in {text}"))
                .rsplit(' ')
                .next()
                .unwrap()
                .to_string()
        };
        let bucket = "federation_engine_query_duration_seconds_bucket{source=\"prom\",le=";
        assert_eq!(line(&format!("{bucket}\"0.005\"}}")), "1");
        assert_eq!(line(&format!("{bucket}\"0.25\"}}")), "2");
        assert_eq!(line(&format!("{bucket}\"300\"}}")), "2");
        assert_eq!(line(&format!("{bucket}\"+Inf\"}}")), "3");
        assert_eq!(
            line("federation_engine_query_duration_seconds_count{source=\"prom\"}"),
            "3"
        );
        assert_eq!(
            line("federation_engine_queries_total{source=\"prom\"}"),
            "3"
        );
        assert_eq!(
            line("federation_engine_query_errors_total{source=\"prom\"}"),
            "1"
        );
        assert_eq!(line("federation_engine_audit_write_failures_total "), "0");
        assert!(text.contains("# TYPE federation_engine_query_duration_seconds histogram"));
    }

    #[test]
    fn label_values_are_escaped() {
        assert_eq!(escape("a\"b\\c\nd"), "a\\\"b\\\\c\\nd");
    }

    #[tokio::test]
    async fn a_dropped_read_counts_as_a_query_but_not_an_error() {
        let source = "metrics-test-dropped";
        let read = observe(source, std::future::pending::<Result<(), ()>>());
        let _ = tokio::time::timeout(std::time::Duration::from_millis(1), read).await;
        let _ = observe(source, async { Err::<(), ()>(()) }).await;
        let s = lock().get(source).cloned().unwrap();
        assert_eq!((s.queries, s.errors), (2, 1));
    }
}
