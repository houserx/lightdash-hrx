//! Binds the pg-wire and HTTP listeners and serves until the process is stopped.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::routing::{get, post};
use engine_config::{Config, TlsFiles};
use pgwire::tokio::TlsAcceptor;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::io::Interest;
use tokio::net::{TcpListener, TcpStream};

use crate::audit_browser::AuditBrowser;
use crate::pg::{PgHandlers, SOURCE_CONNECT_TIMEOUT};
use crate::write::WriteMode;

pub async fn run(config: Config) -> Result<(), String> {
    // Load the certificate before binding: a bad tls_cert_file/tls_key_file stops the engine
    // instead of serving plaintext to clients that were promised TLS.
    let tls = config.tls.as_ref().map(load_tls).transpose()?;
    let pg = TcpListener::bind(config.listen_pg)
        .await
        .map_err(|e| format!("cannot listen on listen_pg {}: {e}", config.listen_pg))?;
    let http = TcpListener::bind(config.listen_http)
        .await
        .map_err(|e| format!("cannot listen on listen_http {}: {e}", config.listen_http))?;
    let tls_note = if tls.is_some() { " (TLS available)" } else { "" };
    eprintln!(
        "engine: serving pg-wire{tls_note} on {} and HTTP on {} ({} users, {} sources)",
        config.listen_pg,
        config.listen_http,
        config.users.len(),
        config.sources.len()
    );

    let cert_pem = tls.as_ref().map(|t| t.cert_pem.as_slice());
    let handlers = Arc::new(PgHandlers::new(&config, cert_pem)?);
    let acceptor = tls.map(|t| t.acceptor);
    let http_server = axum::serve(http, http_router(&config));
    tokio::select! {
        r = http_server => r.map_err(|e| format!("HTTP server failed: {e}")),
        () = serve_pg(pg, acceptor, handlers) => Ok(()),
    }
}

/// The pg-wire TLS setup built from `tls_cert_file` and `tls_key_file`.
struct Tls {
    acceptor: TlsAcceptor,
    /// The certificate chain as PEM, for SCRAM-SHA-256-PLUS channel binding.
    cert_pem: Vec<u8>,
}

/// Reads the PEM certificate chain and private key and builds the TLS acceptor.
///
/// With an acceptor, pgwire answers an SSLRequest with `S` and runs the handshake; without one
/// it answers `N` and the client may go on in plaintext (CONTRACTS §1: TLS is optional and is
/// terminated by the engine when a certificate is configured).
fn load_tls(files: &TlsFiles) -> Result<Tls, String> {
    let cert_file = files.cert_file.display();
    let key_file = files.key_file.display();
    let cert_pem = std::fs::read(&files.cert_file)
        .map_err(|e| format!("cannot read tls_cert_file {cert_file}: {e}"))?;
    let certs = CertificateDer::pem_slice_iter(&cert_pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("tls_cert_file {cert_file} is not valid PEM: {e}"))?;
    if certs.is_empty() {
        return Err(format!("tls_cert_file {cert_file} holds no certificate"));
    }
    let key = PrivateKeyDer::from_pem_file(&files.key_file)
        .map_err(|e| format!("cannot load a private key from tls_key_file {key_file}: {e}"))?;
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut server = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("cannot set up TLS: {e}"))?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| {
            format!("tls_cert_file {cert_file} and tls_key_file {key_file} do not match: {e}")
        })?;
    // Postgres 17's direct TLS (sslnegotiation=direct) requires this ALPN protocol.
    server.alpn_protocols = vec![b"postgresql".to_vec()];
    Ok(Tls {
        acceptor: TlsAcceptor::from(Arc::new(server)),
        cert_pem,
    })
}

async fn serve_pg(listener: TcpListener, tls: Option<TlsAcceptor>, handlers: Arc<PgHandlers>) {
    loop {
        match listener.accept().await {
            Ok((socket, _)) => {
                let handlers = handlers.clone();
                tokio::spawn(serve_connection(socket, tls.clone(), handlers));
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
/// Postgres' client_connection_check_interval, a half-close (FIN) counts as a hang-up. The
/// watcher sees the raw TCP socket, so it works the same under TLS.
async fn serve_connection(socket: TcpStream, tls: Option<TlsAcceptor>, handlers: Arc<PgHandlers>) {
    let (socket, watcher) = match with_hangup_watcher(socket) {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("engine: dropping pg-wire connection, cannot set it up: {e}");
            return;
        }
    };
    let conn = pgwire::tokio::process_socket(socket, tls, handlers);
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
/// `POST /v1/write` is Write Mode (§4.2). `POST /v1/write/confirmations/verify` exists only with
/// `test_mode = true`; otherwise it is 404 like any unknown path. `GET /v1/audit` is the audit
/// browser.
fn http_router(config: &Config) -> Router {
    let write = Arc::new(WriteMode::new(config, SOURCE_CONNECT_TIMEOUT));
    let mut router = Router::new()
        .route("/healthz", get(|| async { "ok\n" }))
        .route("/v1/write", post(crate::write::handle));
    if config.test_mode {
        router = router.route(
            "/v1/write/confirmations/verify",
            post(crate::write::handle_verify),
        );
    }
    let audit = Arc::new(AuditBrowser::new(config, SOURCE_CONNECT_TIMEOUT));
    let browser = Router::new()
        .route("/v1/audit", get(crate::audit_browser::handle))
        .with_state(audit);
    router.with_state(write).merge(browser)
}
