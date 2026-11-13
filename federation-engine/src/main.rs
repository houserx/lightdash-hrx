//! HouseRx Federation Engine entry point.
//!
//! `engine --config <file>` serves pg-wire and HTTP; `engine --check-config --config <file>` only validates the
//! config (CONTRACTS §1.4), resolving secrets from env vars, without binding ports or contacting
//! sources.
//!
//! The serving engine logs JSON lines on stderr (log.rs); `--check-config` answers in plain text.

mod audit;
mod audit_browser;
mod aws;
mod cloudwatch;
mod cloudwatch_logs;
mod gcp_auth;
mod health;
mod identity;
mod labels;
mod log;
mod logql;
mod metrics;
mod ops_marts;
mod pg;
mod platform;
mod promql;
mod selectors;
mod server;
mod session;
mod shutdown;
mod sources;
mod trace;
mod traceql;
mod transaction;
mod write;

use std::path::PathBuf;
use std::process::ExitCode;

use engine_config::Config;
use serde_json::json;

const USAGE: &str = "usage: engine [--check-config] --config <federation-engine.toml>";

struct Args {
    config: PathBuf,
    check_config: bool,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut config = None;
    let mut check_config = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--check-config" => check_config = true,
            "--config" => match args.next() {
                Some(path) => config = Some(PathBuf::from(path)),
                None => return Err("--config needs a file path".into()),
            },
            other => match other.strip_prefix("--config=") {
                Some(path) => config = Some(PathBuf::from(path)),
                None => return Err(format!("unknown argument \"{other}\"")),
            },
        }
    }
    let config = config.ok_or("--config <file> is required")?;
    Ok(Args {
        config,
        check_config,
    })
}

fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(e) => {
            eprintln!("engine: {e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let config = match Config::load(&args.config) {
        Ok(config) => config,
        Err(e) if args.check_config => {
            eprintln!("engine: config {} is invalid:", args.config.display());
            for problem in &e.problems {
                eprintln!("  - {problem}");
            }
            return ExitCode::FAILURE;
        }
        Err(e) => {
            // Config problems name keys and env vars, never their secret values.
            log::error(
                "config is invalid",
                &[
                    ("config", json!(args.config.display().to_string())),
                    ("problems", json!(e.problems)),
                ],
            );
            return ExitCode::FAILURE;
        }
    };
    if args.check_config {
        println!(
            "engine: config {} is valid ({} sources, {} users, audit {})",
            args.config.display(),
            config.sources.len(),
            config.users.len(),
            if config.audit.is_some() { "on" } else { "off" },
        );
        return ExitCode::SUCCESS;
    }
    log::install_panic_hook();
    // rustls is built with both aws-lc-rs and ring, so it can't pick a default on its own.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error(
                "cannot start the async runtime",
                &[("error", json!(e.to_string()))],
            );
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(server::run(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            log::error("engine stopped", &[("error", json!(e))]);
            ExitCode::FAILURE
        }
    }
}
