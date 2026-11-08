//! A small HTTP/1.1 mock server on 127.0.0.1:0. It records every request and answers with a
//! handler closure. A reply may be delayed; if the client hangs up during the delay, the request
//! counts as `cancelled()`. That is how tests see that the engine stopped in-flight source work.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    /// Path without the query string, percent-decoded.
    pub path: String,
    /// Raw path including the query string, as sent.
    pub raw_target: String,
    /// Decoded query parameters, in order.
    pub query: Vec<(String, String)>,
    /// Header names lower-cased.
    pub headers: Vec<(String, String)>,
    /// Body after transfer decoding (chunked and aws-chunked are undone).
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.as_str())
    }
    pub fn param(&self, key: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    /// Query-string params, or form-encoded body params for a POST with a form body.
    pub fn param_or_form(&self, key: &str) -> Option<String> {
        if let Some(v) = self.param(key) {
            return Some(v.to_string());
        }
        self.form()
            .into_iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }
    pub fn body_str(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("request body is not JSON ({e}): {}", self.body_str()))
    }
    pub fn form(&self) -> Vec<(String, String)> {
        let ct = self.header("content-type").unwrap_or("");
        if !ct.contains("x-www-form-urlencoded") {
            return vec![];
        }
        parse_query(&self.body_str())
    }
}

#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub delay: Duration,
}

impl Reply {
    pub fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Reply {
            status,
            headers: vec![("content-type".into(), content_type.into())],
            body: body.into(),
            delay: Duration::ZERO,
        }
    }
    pub fn json(v: &serde_json::Value) -> Self {
        Self::json_status(200, v)
    }
    pub fn json_status(status: u16, v: &serde_json::Value) -> Self {
        Self::new(status, "application/json", serde_json::to_vec(v).unwrap())
    }
    pub fn text(status: u16, s: &str) -> Self {
        Self::new(status, "text/plain", s.as_bytes().to_vec())
    }
    pub fn not_found() -> Self {
        Self::text(404, "not found")
    }
    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.to_ascii_lowercase(), v.into()));
        self
    }
    pub fn delayed(mut self, d: Duration) -> Self {
        self.delay = d;
        self
    }
}

pub type Handler = Arc<dyn Fn(&Recorded) -> Reply + Send + Sync>;

pub struct MockServer {
    pub port: u16,
    requests: Arc<Mutex<Vec<Recorded>>>,
    cancelled: Arc<AtomicUsize>,
    in_flight: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockServer {
    /// Starts a mock that answers every request with `handler`.
    pub async fn start(handler: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock");
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let cancelled = Arc::new(AtomicUsize::new(0));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let handler: Handler = Arc::new(handler);
        let (rq, ca, inf) = (requests.clone(), cancelled.clone(), in_flight.clone());
        let task = tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else {
                    continue;
                };
                let (h, rq, ca, inf) = (handler.clone(), rq.clone(), ca.clone(), inf.clone());
                tokio::spawn(async move {
                    let _ = serve_conn(sock, h, rq, ca, inf).await;
                });
            }
        });
        MockServer {
            port,
            requests,
            cancelled,
            in_flight,
            task,
        }
    }

    /// `http://127.0.0.1:<port>`
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
    /// Requests whose path starts with `prefix`.
    pub fn requests_to(&self, prefix: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|r| r.path.starts_with(prefix))
            .collect()
    }
    /// Requests whose client disconnected while the reply was being delayed.
    pub fn cancelled(&self) -> usize {
        self.cancelled.load(Ordering::SeqCst)
    }
    /// Requests currently waiting on a delayed reply.
    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }
    /// Waits up to `timeout` for `cancelled() >= n`.
    pub async fn wait_cancelled(&self, n: usize, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if self.cancelled() >= n {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        self.cancelled() >= n
    }
    /// Waits up to `timeout` for at least `n` recorded requests.
    pub async fn wait_requests(&self, n: usize, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if self.requests.lock().unwrap().len() >= n {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }
}

/// A URL on which nothing listens (a port that was free a moment ago).
pub fn dead_url() -> String {
    format!("http://127.0.0.1:{}", super::free_port())
}

struct InFlight(Arc<AtomicUsize>);
impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn serve_conn(
    mut sock: TcpStream,
    handler: Handler,
    requests: Arc<Mutex<Vec<Recorded>>>,
    cancelled: Arc<AtomicUsize>,
    in_flight: Arc<AtomicUsize>,
) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        // Request head.
        let head_end = loop {
            if let Some(p) = find(&buf, b"\r\n\r\n") {
                break p;
            }
            let mut tmp = [0u8; 16384];
            let n = sock.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&tmp[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        buf.drain(..head_end + 4);
        let mut lines = head.split("\r\n");
        let request_line = lines.next().unwrap_or("");
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let target = parts.next().unwrap_or("/").to_string();
        let headers: Vec<(String, String)> = lines
            .filter_map(|l| {
                let (k, v) = l.split_once(':')?;
                Some((k.trim().to_ascii_lowercase(), v.trim().to_string()))
            })
            .collect();
        let hget = |n: &str| headers.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
        if hget("expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue")) {
            sock.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await?;
        }
        // Body.
        let mut body = Vec::new();
        if hget("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
            loop {
                let line_end = loop {
                    if let Some(p) = find(&buf, b"\r\n") {
                        break p;
                    }
                    read_more(&mut sock, &mut buf).await?;
                };
                let size_str = String::from_utf8_lossy(&buf[..line_end]).into_owned();
                let size = usize::from_str_radix(size_str.split(';').next().unwrap().trim(), 16)
                    .unwrap_or(0);
                buf.drain(..line_end + 2);
                if size == 0 {
                    // Trailers until an empty line.
                    loop {
                        let e = loop {
                            if let Some(p) = find(&buf, b"\r\n") {
                                break p;
                            }
                            read_more(&mut sock, &mut buf).await?;
                        };
                        let empty = e == 0;
                        buf.drain(..e + 2);
                        if empty {
                            break;
                        }
                    }
                    break;
                }
                while buf.len() < size + 2 {
                    read_more(&mut sock, &mut buf).await?;
                }
                body.extend_from_slice(&buf[..size]);
                buf.drain(..size + 2);
            }
        } else {
            let len: usize = hget("content-length")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            while buf.len() < len {
                read_more(&mut sock, &mut buf).await?;
            }
            body = buf.drain(..len).collect();
        }
        let aws_chunked = hget("content-encoding").is_some_and(|v| v.contains("aws-chunked"))
            || hget("x-amz-content-sha256").is_some_and(|v| v.starts_with("STREAMING-"));
        if aws_chunked {
            body = decode_aws_chunked(&body);
        }
        let (raw_path, raw_query) = match target.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (target.clone(), String::new()),
        };
        let rec = Recorded {
            method,
            path: percent_decode(&raw_path),
            raw_target: target.clone(),
            query: parse_query(&raw_query),
            headers,
            body,
        };
        requests.lock().unwrap().push(rec.clone());
        let reply = handler(&rec);

        if !reply.delay.is_zero() {
            in_flight.fetch_add(1, Ordering::SeqCst);
            let _guard = InFlight(in_flight.clone());
            let sleep = tokio::time::sleep(reply.delay);
            tokio::pin!(sleep);
            loop {
                let mut tmp = [0u8; 4096];
                tokio::select! {
                    _ = &mut sleep => break,
                    r = sock.read(&mut tmp) => match r {
                        Ok(0) | Err(_) => {
                            cancelled.fetch_add(1, Ordering::SeqCst);
                            return Ok(());
                        }
                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    }
                }
            }
        }

        let mut out = format!(
            "HTTP/1.1 {} {}\r\ncontent-length: {}\r\nconnection: keep-alive\r\n",
            reply.status,
            reason(reply.status),
            reply.body.len()
        );
        for (k, v) in &reply.headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str("\r\n");
        sock.write_all(out.as_bytes()).await?;
        sock.write_all(&reply.body).await?;
        sock.flush().await?;
    }
}

async fn read_more(sock: &mut TcpStream, buf: &mut Vec<u8>) -> std::io::Result<()> {
    let mut tmp = [0u8; 65536];
    let n = sock.read(&mut tmp).await?;
    if n == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "client closed mid-request",
        ));
    }
    buf.extend_from_slice(&tmp[..n]);
    Ok(())
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

/// Undoes `Content-Encoding: aws-chunked` (SigV4 streaming, with or without trailers).
pub fn decode_aws_chunked(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < body.len() {
        let Some(rel) = find(&body[i..], b"\r\n") else {
            break;
        };
        let line = String::from_utf8_lossy(&body[i..i + rel]).into_owned();
        let Ok(size) = usize::from_str_radix(line.split(';').next().unwrap().trim(), 16) else {
            break;
        };
        i += rel + 2;
        if size == 0 {
            break;
        }
        out.extend_from_slice(&body[i..(i + size).min(body.len())]);
        i += size + 2;
    }
    out
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len())
            .then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok())
            .flatten()
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        if let Some(v) = hex {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (
                percent_decode(&k.replace('+', " ")),
                percent_decode(&v.replace('+', " ")),
            )
        })
        .collect()
}

fn reason(s: u16) -> &'static str {
    match s {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}
