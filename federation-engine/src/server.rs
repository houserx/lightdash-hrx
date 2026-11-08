//! Binds the pg-wire and HTTP listeners and serves until the process is stopped.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::routing::get;
use engine_config::Config;
use tokio::net::TcpListener;

use crate::pg::PgHandlers;

pub async fn run(config: Config) -> Result<(), String> {
    if config.tls.is_some() {
        // Fail closed rather than serve plaintext to clients that were promised TLS.
        return Err("[tls] is configured but TLS is not implemented yet".into());
    }
    let pg = TcpListener::bind(config.listen_pg)
        .await
        .map_err(|e| format!("cannot listen on listen_pg {}: {e}", config.listen_pg))?;
    let http = TcpListener::bind(config.listen_http)
        .await
        .map_err(|e| format!("cannot listen on listen_http {}: {e}", config.listen_http))?;
    eprintln!(
        "engine: serving pg-wire on {} and HTTP on {} ({} users, {} sources)",
        config.listen_pg,
        config.listen_http,
        config.users.len(),
        config.sources.len()
    );

    let handlers = Arc::new(PgHandlers::new(&config.users));
    let http_server = axum::serve(http, http_router());
    tokio::select! {
        r = http_server => r.map_err(|e| format!("HTTP server failed: {e}")),
        () = serve_pg(pg, handlers) => Ok(()),
    }
}

async fn serve_pg(listener: TcpListener, handlers: Arc<PgHandlers>) {
    loop {
        match listener.accept().await {
            Ok((socket, _)) => {
                let handlers = handlers.clone();
                tokio::spawn(async move {
                    let _ = pgwire::tokio::process_socket(socket, None, handlers).await;
                });
            }
            Err(e) => {
                // Usually EMFILE: back off instead of spinning.
                eprintln!("engine: pg-wire accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// The HTTP side port (CONTRACTS §1.3). `/healthz` does not probe sources yet (eng-healthz).
fn http_router() -> Router {
    Router::new().route("/healthz", get(|| async { "ok\n" }))
}
