//! A minimal pg-wire v3 frontend that sends exactly the messages a test chooses. Used to emulate
//! node-postgres + pg-cursor (Lightdash's `PgQueryStream`) byte for byte: Parse, Bind to a named
//! portal, Describe portal, Flush, then Execute(max_rows=100) + Flush until CommandComplete, then Sync.
//! Supports cleartext, MD5 and SCRAM-SHA-256 password authentication.

use std::collections::HashMap;

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, Clone)]
pub struct Field {
    pub name: String,
    pub type_oid: u32,
    pub format: i16,
}

#[derive(Debug, Clone)]
pub enum Msg {
    ParseComplete,
    BindComplete,
    CloseComplete,
    NoData,
    ParameterDescription(Vec<u32>),
    RowDescription(Vec<Field>),
    DataRow(Vec<Option<Vec<u8>>>),
    PortalSuspended,
    CommandComplete(String),
    EmptyQuery,
    Ready(u8),
    Error(HashMap<char, String>),
    Other(u8),
}

impl Msg {
    pub fn sqlstate(&self) -> Option<&str> {
        match self {
            Msg::Error(f) => f.get(&'C').map(|s| s.as_str()),
            _ => None,
        }
    }
}

pub struct RawPg {
    sock: TcpStream,
    buf: Vec<u8>,
    pub params: HashMap<String, String>,
    pub backend_pid: i32,
    pub backend_secret: i32,
}

/// Rows of one batch as text values.
pub type Batch = Vec<Vec<Option<String>>>;

impl RawPg {
    /// Connects and authenticates; returns the error fields if the server refuses the login.
    pub async fn connect(
        port: u16,
        user: &str,
        password: &str,
        database: &str,
    ) -> Result<RawPg, HashMap<char, String>> {
        let sock = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("tcp connect to engine");
        let mut c = RawPg {
            sock,
            buf: vec![],
            params: HashMap::new(),
            backend_pid: 0,
            backend_secret: 0,
        };
        let mut body = Vec::new();
        body.extend_from_slice(&196608i32.to_be_bytes());
        for (k, v) in [
            ("user", user),
            ("database", database),
            ("client_encoding", "UTF8"),
        ] {
            body.extend_from_slice(k.as_bytes());
            body.push(0);
            body.extend_from_slice(v.as_bytes());
            body.push(0);
        }
        body.push(0);
        let mut m = ((body.len() + 4) as i32).to_be_bytes().to_vec();
        m.extend_from_slice(&body);
        c.sock.write_all(&m).await.unwrap();

        let mut scram: Option<(String, String)> = None; // (client_first_bare, nonce)
        let mut server_sig_expected: Option<Vec<u8>> = None;
        loop {
            let (tag, body) = c.read_raw().await;
            match tag {
                b'R' => {
                    let code = i32::from_be_bytes(body[0..4].try_into().unwrap());
                    match code {
                        0 => {}
                        3 => {
                            let mut p = password.as_bytes().to_vec();
                            p.push(0);
                            c.send(b'p', &p).await;
                        }
                        5 => {
                            let salt = &body[4..8];
                            let inner = hex::encode(md5::Md5::digest(
                                [password.as_bytes(), user.as_bytes()].concat(),
                            ));
                            let outer =
                                hex::encode(md5::Md5::digest([inner.as_bytes(), salt].concat()));
                            let mut p = format!("md5{outer}").into_bytes();
                            p.push(0);
                            c.send(b'p', &p).await;
                        }
                        10 => {
                            let nonce = base64::engine::general_purpose::STANDARD
                                .encode(uuid::Uuid::new_v4().as_bytes());
                            let bare = format!("n=,r={nonce}");
                            let first = format!("n,,{bare}");
                            let mut p = b"SCRAM-SHA-256\0".to_vec();
                            p.extend_from_slice(&(first.len() as i32).to_be_bytes());
                            p.extend_from_slice(first.as_bytes());
                            c.send(b'p', &p).await;
                            scram = Some((bare, nonce));
                        }
                        11 => {
                            let server_first = String::from_utf8_lossy(&body[4..]).into_owned();
                            let (bare, nonce) = scram.clone().expect("SASL started");
                            let attrs: HashMap<&str, &str> = server_first
                                .split(',')
                                .filter_map(|kv| kv.split_once('='))
                                .collect();
                            let r = attrs["r"];
                            assert!(r.starts_with(&nonce), "server nonce must extend ours");
                            let salt = base64::engine::general_purpose::STANDARD
                                .decode(attrs["s"])
                                .unwrap();
                            let iters: u32 = attrs["i"].parse().unwrap();
                            let salted = pbkdf2_sha256(password.as_bytes(), &salt, iters);
                            let client_key = hmac256(&salted, b"Client Key");
                            let stored_key = Sha256::digest(&client_key);
                            let without_proof = format!("c=biws,r={r}");
                            let auth_msg = format!("{bare},{server_first},{without_proof}");
                            let client_sig = hmac256(&stored_key, auth_msg.as_bytes());
                            let proof: Vec<u8> = client_key
                                .iter()
                                .zip(client_sig.iter())
                                .map(|(a, b)| a ^ b)
                                .collect();
                            let server_key = hmac256(&salted, b"Server Key");
                            server_sig_expected = Some(hmac256(&server_key, auth_msg.as_bytes()));
                            let fin = format!(
                                "{without_proof},p={}",
                                base64::engine::general_purpose::STANDARD.encode(proof)
                            );
                            c.send(b'p', fin.as_bytes()).await;
                        }
                        12 => {
                            let s = String::from_utf8_lossy(&body[4..]).into_owned();
                            if let (Some(v), Some(exp)) =
                                (s.strip_prefix("v="), &server_sig_expected)
                            {
                                let got = base64::engine::general_purpose::STANDARD
                                    .decode(v.trim())
                                    .unwrap_or_default();
                                assert_eq!(&got, exp, "SCRAM server signature mismatch");
                            }
                        }
                        other => panic!("unsupported auth request {other}"),
                    }
                }
                b'S' => {
                    let parts: Vec<&[u8]> = body.split(|b| *b == 0).collect();
                    if parts.len() >= 2 {
                        c.params.insert(
                            String::from_utf8_lossy(parts[0]).into(),
                            String::from_utf8_lossy(parts[1]).into(),
                        );
                    }
                }
                b'K' => {
                    c.backend_pid = i32::from_be_bytes(body[0..4].try_into().unwrap());
                    c.backend_secret = i32::from_be_bytes(body[4..8].try_into().unwrap());
                }
                b'E' => return Err(parse_fields(&body)),
                b'Z' => return Ok(c),
                b'N' => {}
                _ => {}
            }
        }
    }

    async fn read_raw(&mut self) -> (u8, Vec<u8>) {
        loop {
            if self.buf.len() >= 5 {
                let len = i32::from_be_bytes(self.buf[1..5].try_into().unwrap()) as usize;
                if self.buf.len() > len {
                    let tag = self.buf[0];
                    let body = self.buf[5..1 + len].to_vec();
                    self.buf.drain(..1 + len);
                    return (tag, body);
                }
            }
            let mut tmp = [0u8; 65536];
            let n = self.sock.read(&mut tmp).await.expect("read from engine");
            assert!(n > 0, "engine closed the connection");
            self.buf.extend_from_slice(&tmp[..n]);
        }
    }

    async fn send(&mut self, tag: u8, body: &[u8]) {
        let mut m = vec![tag];
        m.extend_from_slice(&((body.len() + 4) as i32).to_be_bytes());
        m.extend_from_slice(body);
        self.sock.write_all(&m).await.expect("write to engine");
    }

    /// Next backend message, skipping NoticeResponse and ParameterStatus.
    pub async fn next(&mut self) -> Msg {
        loop {
            let (tag, body) = self.read_raw().await;
            return match tag {
                b'1' => Msg::ParseComplete,
                b'2' => Msg::BindComplete,
                b'3' => Msg::CloseComplete,
                b'n' => Msg::NoData,
                b't' => {
                    let n = u16::from_be_bytes(body[0..2].try_into().unwrap()) as usize;
                    Msg::ParameterDescription(
                        (0..n)
                            .map(|i| {
                                u32::from_be_bytes(body[2 + i * 4..6 + i * 4].try_into().unwrap())
                            })
                            .collect(),
                    )
                }
                b'T' => {
                    let n = u16::from_be_bytes(body[0..2].try_into().unwrap()) as usize;
                    let mut i = 2;
                    let mut fields = vec![];
                    for _ in 0..n {
                        let end = i + body[i..].iter().position(|b| *b == 0).unwrap();
                        let name = String::from_utf8_lossy(&body[i..end]).into_owned();
                        i = end + 1;
                        let type_oid = u32::from_be_bytes(body[i + 6..i + 10].try_into().unwrap());
                        let format = i16::from_be_bytes(body[i + 16..i + 18].try_into().unwrap());
                        i += 18;
                        fields.push(Field {
                            name,
                            type_oid,
                            format,
                        });
                    }
                    Msg::RowDescription(fields)
                }
                b'D' => {
                    let n = u16::from_be_bytes(body[0..2].try_into().unwrap()) as usize;
                    let mut i = 2;
                    let mut cols = vec![];
                    for _ in 0..n {
                        let len = i32::from_be_bytes(body[i..i + 4].try_into().unwrap());
                        i += 4;
                        if len < 0 {
                            cols.push(None);
                        } else {
                            cols.push(Some(body[i..i + len as usize].to_vec()));
                            i += len as usize;
                        }
                    }
                    Msg::DataRow(cols)
                }
                b's' => Msg::PortalSuspended,
                b'C' => Msg::CommandComplete(
                    String::from_utf8_lossy(&body[..body.len().saturating_sub(1)]).into_owned(),
                ),
                b'I' => Msg::EmptyQuery,
                b'Z' => Msg::Ready(body[0]),
                b'E' => Msg::Error(parse_fields(&body)),
                b'N' | b'S' => continue,
                other => Msg::Other(other),
            };
        }
    }

    pub async fn parse(&mut self, stmt: &str, sql: &str, param_oids: &[u32]) {
        let mut b = cstr(stmt);
        b.extend(cstr(sql));
        b.extend_from_slice(&(param_oids.len() as i16).to_be_bytes());
        for o in param_oids {
            b.extend_from_slice(&o.to_be_bytes());
        }
        self.send(b'P', &b).await;
    }

    /// Bind with text-format parameters and text-format results.
    pub async fn bind(&mut self, portal: &str, stmt: &str, params: &[Option<&str>]) {
        let mut b = cstr(portal);
        b.extend(cstr(stmt));
        b.extend_from_slice(&0i16.to_be_bytes());
        b.extend_from_slice(&(params.len() as i16).to_be_bytes());
        for p in params {
            match p {
                None => b.extend_from_slice(&(-1i32).to_be_bytes()),
                Some(v) => {
                    b.extend_from_slice(&(v.len() as i32).to_be_bytes());
                    b.extend_from_slice(v.as_bytes());
                }
            }
        }
        b.extend_from_slice(&0i16.to_be_bytes());
        self.send(b'B', &b).await;
    }

    pub async fn describe_portal(&mut self, portal: &str) {
        let mut b = vec![b'P'];
        b.extend(cstr(portal));
        self.send(b'D', &b).await;
    }
    pub async fn describe_statement(&mut self, stmt: &str) {
        let mut b = vec![b'S'];
        b.extend(cstr(stmt));
        self.send(b'D', &b).await;
    }
    pub async fn execute(&mut self, portal: &str, max_rows: i32) {
        let mut b = cstr(portal);
        b.extend_from_slice(&max_rows.to_be_bytes());
        self.send(b'E', &b).await;
    }
    pub async fn close_portal(&mut self, portal: &str) {
        let mut b = vec![b'P'];
        b.extend(cstr(portal));
        self.send(b'C', &b).await;
    }
    pub async fn flush(&mut self) {
        self.send(b'H', &[]).await;
    }
    pub async fn sync(&mut self) {
        self.send(b'S', &[]).await;
    }
    pub async fn simple_query_send(&mut self, sql: &str) {
        self.send(b'Q', &cstr(sql)).await;
    }
    pub async fn terminate(&mut self) {
        self.send(b'X', &[]).await;
    }

    /// Runs a simple query; returns (fields, rows, error) after ReadyForQuery.
    pub async fn simple_query(&mut self, sql: &str) -> (Vec<Field>, Batch, Option<Msg>) {
        self.simple_query_send(sql).await;
        let mut fields = vec![];
        let mut rows = vec![];
        let mut err = None;
        loop {
            match self.next().await {
                Msg::RowDescription(f) => fields = f,
                Msg::DataRow(r) => rows.push(text_row(&r)),
                e @ Msg::Error(_) => err = Some(e),
                Msg::Ready(_) => return (fields, rows, err),
                _ => {}
            }
        }
    }

    /// Emulates pg-cursor (node-postgres `pg-cursor`, used by Lightdash's `PgQueryStream`):
    /// Parse(unnamed) + Bind(portal) + Describe(portal) + Flush, then Execute(portal, batch) + Flush
    /// until CommandComplete, then Sync. Returns the RowDescription and every batch.
    /// Panics on an ErrorResponse (returned as Err with its fields instead).
    pub async fn cursor_read_all(
        &mut self,
        portal: &str,
        sql: &str,
        params: &[Option<&str>],
        batch: i32,
    ) -> Result<(Vec<Field>, Vec<Batch>), HashMap<char, String>> {
        self.parse("", sql, &[]).await;
        self.bind(portal, "", params).await;
        self.describe_portal(portal).await;
        self.flush().await;
        let mut fields = vec![];
        loop {
            match self.next().await {
                Msg::ParseComplete | Msg::BindComplete => {}
                Msg::RowDescription(f) => {
                    fields = f;
                    break;
                }
                Msg::NoData => break,
                Msg::Error(e) => {
                    self.sync().await;
                    self.drain_until_ready().await;
                    return Err(e);
                }
                other => panic!("unexpected message before rows: {other:?}"),
            }
        }
        let mut batches = vec![];
        loop {
            self.execute(portal, batch).await;
            self.flush().await;
            let mut rows = vec![];
            let done = loop {
                match self.next().await {
                    Msg::DataRow(r) => rows.push(text_row(&r)),
                    Msg::PortalSuspended => break false,
                    Msg::CommandComplete(_) => break true,
                    Msg::Error(e) => {
                        self.sync().await;
                        self.drain_until_ready().await;
                        return Err(e);
                    }
                    other => panic!("unexpected message during fetch: {other:?}"),
                }
            };
            batches.push(rows);
            if done {
                break;
            }
        }
        self.sync().await;
        self.drain_until_ready().await;
        Ok((fields, batches))
    }

    pub async fn drain_until_ready(&mut self) -> Vec<Msg> {
        let mut seen = vec![];
        loop {
            let m = self.next().await;
            if let Msg::Ready(_) = m {
                return seen;
            }
            seen.push(m);
        }
    }

    /// Drops the TCP connection without a Terminate message.
    pub fn hard_close(self) {
        drop(self.sock);
    }
}

/// Sends a CancelRequest for (pid, secret) on a new connection.
pub async fn send_cancel(port: u16, pid: i32, secret: i32) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut m = 16i32.to_be_bytes().to_vec();
    m.extend_from_slice(&80877102i32.to_be_bytes());
    m.extend_from_slice(&pid.to_be_bytes());
    m.extend_from_slice(&secret.to_be_bytes());
    s.write_all(&m).await.unwrap();
    let _ = s.shutdown().await;
}

/// Sends an SSLRequest and returns the one-byte answer (`b'S'` or `b'N'`).
pub async fn ssl_request_answer(port: u16) -> u8 {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut m = 8i32.to_be_bytes().to_vec();
    m.extend_from_slice(&80877103i32.to_be_bytes());
    s.write_all(&m).await.unwrap();
    let mut b = [0u8; 1];
    s.read_exact(&mut b).await.unwrap();
    b[0]
}

pub fn text_row(r: &[Option<Vec<u8>>]) -> Vec<Option<String>> {
    r.iter()
        .map(|c| c.as_ref().map(|b| String::from_utf8_lossy(b).into_owned()))
        .collect()
}

fn cstr(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    v
}

fn parse_fields(body: &[u8]) -> HashMap<char, String> {
    let mut out = HashMap::new();
    let mut i = 0;
    while i < body.len() && body[i] != 0 {
        let code = body[i] as char;
        i += 1;
        let end = i + body[i..].iter().position(|b| *b == 0).unwrap_or(0);
        out.insert(code, String::from_utf8_lossy(&body[i..end]).into_owned());
        i = end + 1;
    }
    out
}

fn hmac256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).unwrap();
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

fn pbkdf2_sha256(password: &[u8], salt: &[u8], iters: u32) -> Vec<u8> {
    let mut u = hmac256(password, &[salt, &1u32.to_be_bytes()].concat());
    let mut out = u.clone();
    for _ in 1..iters {
        u = hmac256(password, &u);
        for (o, x) in out.iter_mut().zip(u.iter()) {
            *o ^= x;
        }
    }
    out
}
