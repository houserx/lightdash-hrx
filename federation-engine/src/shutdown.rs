//! Graceful shutdown (CONTRACTS A28): SIGTERM stops accepting, drains in-flight queries, and
//! exits 0.
//!
//! Every pg-wire statement holds an [`InFlight`] guard while it runs. Once shutdown begins, no
//! new guard is handed out: a statement sent on an already open connection fails with 57P01
//! (admin_shutdown) instead of starting, so the drain can only shrink. The server waits for the
//! count to reach zero (bounded by [`DRAIN_LIMIT`]) and then returns, closing every remaining,
//! idle connection when the process exits.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::Notify;

/// The longest the engine waits for in-flight work after SIGTERM. Kubernetes sends SIGKILL 30 s
/// after SIGTERM by default; exiting before that keeps the exit clean and the log complete.
pub const DRAIN_LIMIT: Duration = Duration::from_secs(25);

/// Time for the last responses, already handed to the socket layer, to be written out before
/// the process exits. Rows are encoded before a statement's guard is released, so only the
/// socket write remains.
pub const FLUSH_GRACE: Duration = Duration::from_millis(250);

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
static IDLE: Notify = Notify::const_new();

/// Marks one running pg-wire statement; dropping it ends the statement.
pub struct InFlight(());

impl InFlight {
    /// A guard for a new statement, or `None` once shutdown has begun.
    pub fn start() -> Option<Self> {
        IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            release();
            return None;
        }
        Some(Self(()))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        release();
    }
}

fn release() {
    if IN_FLIGHT.fetch_sub(1, Ordering::SeqCst) == 1 {
        IDLE.notify_waiters();
    }
}

/// Stops handing out new [`InFlight`] guards.
pub fn begin() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
}

/// Resolves once no statement is running. Call after [`begin`].
pub async fn drained() {
    loop {
        let idle = IDLE.notified();
        tokio::pin!(idle);
        // Register before reading the count so a release in between is not missed.
        idle.as_mut().enable();
        if IN_FLIGHT.load(Ordering::SeqCst) == 0 {
            return;
        }
        idle.await;
    }
}

/// Installs the SIGTERM and SIGINT (Ctrl-C) handlers now, before the engine reports it is
/// serving, and returns a future that resolves with the name of the first one received.
pub fn signals() -> Result<impl Future<Output = &'static str>, String> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term =
        signal(SignalKind::terminate()).map_err(|e| format!("cannot watch SIGTERM: {e}"))?;
    let mut int =
        signal(SignalKind::interrupt()).map_err(|e| format!("cannot watch SIGINT: {e}"))?;
    Ok(async move {
        tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
        }
    })
}
