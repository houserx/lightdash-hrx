//! Binds the pg-wire and HTTP listeners and serves until the process is stopped.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::routing::get;
use engine_config::Config;
use tokio::io::Interest;
use tokio::net::{TcpListener, TcpStream};

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

    let handlers = Arc::new(PgHandlers::new(&config)?);
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
                tokio::spawn(serve_connection(socket, handlers));
            }
            Err(e) => {
                // Usually EMFILE: back off instead of spinning.
                eprintln!("engine: pg-wire accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Serves one pg-wire connection until it ends or the client hangs up.
///
/// pgwire reads the next message only after the current one is handled, so on its own it would
/// not notice a hang-up until a slow query finished. A second handle on the same socket watches
/// for the peer closing its side; when it does, the connection future is dropped, which drops the
/// running query and abandons its in-flight source request (eng-pg-disconnect-cleanup). Like
/// Postgres' client_connection_check_interval, a half-close (FIN) counts as a hang-up.
async fn serve_connection(socket: TcpStream, handlers: Arc<PgHandlers>) {
    let (socket, watcher) = match with_hangup_watcher(socket) {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("engine: dropping pg-wire connection, cannot set it up: {e}");
            return;
        }
    };
    let conn = pgwire::tokio::process_socket(socket, None, handlers);
    tokio::pin!(conn);
    tokio::select! {
        _ = &mut conn => return,
        () = hung_up(&watcher) => {}
    }
    // A client may send its last messages and close at once: a CancelRequest connection does
    // exactly that. Give pgwire a moment to handle what is already buffered before dropping it.
    let _ = tokio::time::timeout(HANGUP_GRACE, conn).await;
    // `watcher` shares the socket: it is dropped here, so the socket closes with the connection.
}

/// How long a connection whose client hung up may keep running to handle buffered messages.
const HANGUP_GRACE: Duration = Duration::from_millis(250);

/// Returns the socket plus a second tokio handle on it, used only to wait for readiness.
fn with_hangup_watcher(socket: TcpStream) -> std::io::Result<(TcpStream, TcpStream)> {
    // `into_std` leaves the socket non-blocking, and the clone shares that flag.
    let socket = socket.into_std()?;
    let watcher = socket.try_clone()?;
    Ok((TcpStream::from_std(socket)?, TcpStream::from_std(watcher)?))
}

/// Resolves once the peer has closed or reset the connection.
async fn hung_up(watcher: &TcpStream) {
    loop {
        match watcher.ready(Interest::READABLE).await {
            Ok(r) if !r.is_read_closed() => {
                // Plain data for pgwire to read. Clear this handle's readiness without
                // consuming anything, then wait for the next edge (more data, FIN or RST).
                let _ = watcher.try_io(Interest::READABLE, || {
                    Err::<(), _>(std::io::ErrorKind::WouldBlock.into())
                });
            }
            _ => return,
        }
    }
}

/// The HTTP side port (CONTRACTS §1.3). `/healthz` does not probe sources yet (eng-healthz).
fn http_router() -> Router {
    Router::new().route("/healthz", get(|| async { "ok\n" }))
}
