//! Starts the real `engine` binary with a generated TOML config on ephemeral ports.
//!
//! The process gets a cleared environment: only PATH, a private HOME, fake AWS credentials, the
//! test secrets below, and whatever the test adds. `AWS_ENDPOINT_URL` points at a dead port so a
//! client that ignores its configured endpoint override can never reach real AWS.

use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use super::*;

/// Builds an engine config. `listen_pg` and `listen_http` are always written by the harness.
#[derive(Clone)]
pub struct Cfg {
    top: Vec<String>,
    tables: Vec<String>,
    env: Vec<(String, String)>,
}

impl Default for Cfg {
    fn default() -> Self {
        Self::new()
    }
}

impl Cfg {
    /// `identity_secret_env = "HRX_IDENTITY_SECRET"` plus the standard `[[users]]` login.
    pub fn new() -> Self {
        Cfg {
            top: vec![r#"identity_secret_env = "HRX_IDENTITY_SECRET""#.into()],
            tables: vec![format!(
                "[[users]]\nname = \"{PG_USER}\"\npassword_env = \"HRX_PG_PASSWORD_OPERATIONS\"\n"
            )],
            env: vec![],
        }
    }
    /// Adds a top-level `key = value` line (value is raw TOML).
    pub fn top(mut self, line: &str) -> Self {
        self.top.push(line.to_string());
        self
    }
    /// Adds a raw TOML table, e.g. a `[[sources]]` block.
    pub fn table(mut self, toml: &str) -> Self {
        self.tables.push(toml.to_string());
        self
    }
    /// Adds an environment variable for the engine process.
    pub fn env(mut self, k: &str, v: &str) -> Self {
        self.env.push((k.into(), v.into()));
        self
    }
    /// `[[sources]]` of `kind` with a `url`.
    pub fn url_source(self, name: &str, kind: &str, url: &str, extra: &str) -> Self {
        self.table(&format!(
            "[[sources]]\nname = \"{name}\"\nkind = \"{kind}\"\nurl = \"{url}\"\n{extra}\n"
        ))
    }
    pub fn prometheus(self, name: &str, url: &str, extra: &str) -> Self {
        self.url_source(name, "prometheus", url, extra)
    }
    pub fn loki(self, name: &str, url: &str, extra: &str) -> Self {
        self.url_source(name, "loki", url, extra)
    }
    pub fn tempo(self, name: &str, url: &str, extra: &str) -> Self {
        self.url_source(name, "tempo", url, extra)
    }
    /// A `platform_postgres` source named `platform` over `cluster`'s read and write roles.
    pub fn platform(self, cluster: &PgCluster, with_write: bool) -> Self {
        let mut c = self
            .env("HRX_PLATFORM_READ_URL", &cluster.read_url())
            .env("HRX_PLATFORM_WRITE_URL", &cluster.write_url());
        let write = if with_write {
            "write_url_env = \"HRX_PLATFORM_WRITE_URL\"\n"
        } else {
            ""
        };
        c = c.table(&format!(
            "[[sources]]\nname = \"platform\"\nkind = \"platform_postgres\"\nread_url_env = \"HRX_PLATFORM_READ_URL\"\n{write}"
        ));
        c
    }
    /// The `[audit]` table pointed at an `aws::AuditStore` mock.
    pub fn audit(self, store: &aws::AuditStore) -> Self {
        self.table(&format!(
            "[audit]\ndynamodb_table = \"{}\"\ns3_bucket = \"{}\"\nintegrity_key_env = \"AUDIT_INTEGRITY_KEY\"\nregion = \"us-east-2\"\ndynamodb_endpoint_url = \"{}\"\ns3_endpoint_url = \"{}\"\n",
            aws::AUDIT_TABLE,
            aws::AUDIT_BUCKET,
            store.url(),
            store.url()
        ))
    }
    pub fn render(&self, pg: &str, http: &str) -> String {
        let mut s = format!("listen_pg = \"{pg}\"\nlisten_http = \"{http}\"\n");
        for l in &self.top {
            s.push_str(l);
            s.push('\n');
        }
        s.push('\n');
        for t in &self.tables {
            s.push_str(t);
            s.push('\n');
        }
        s
    }
}

pub struct Engine {
    pub pg_port: u16,
    pub http_port: u16,
    pub dir: PathBuf,
    pub config_path: PathBuf,
    child: Option<Child>,
}

impl Drop for Engine {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

pub fn engine_bin() -> &'static str {
    env!("CARGO_BIN_EXE_engine")
}

/// The base environment every engine process gets.
pub fn base_env(dir: &std::path::Path) -> Vec<(String, String)> {
    vec![
        ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
        ("HOME".into(), dir.display().to_string()),
        ("TMPDIR".into(), dir.display().to_string()),
        ("HRX_IDENTITY_SECRET".into(), IDENTITY_SECRET.into()),
        ("HRX_PG_PASSWORD_OPERATIONS".into(), PG_PASSWORD.into()),
        ("AUDIT_INTEGRITY_KEY".into(), AUDIT_KEY.into()),
        ("AWS_ACCESS_KEY_ID".into(), AWS_KEY_ID.into()),
        ("AWS_SECRET_ACCESS_KEY".into(), AWS_SECRET.into()),
        ("AWS_REGION".into(), "us-east-2".into()),
        ("AWS_EC2_METADATA_DISABLED".into(), "true".into()),
        (
            "AWS_CONFIG_FILE".into(),
            dir.join("no-aws-config").display().to_string(),
        ),
        (
            "AWS_SHARED_CREDENTIALS_FILE".into(),
            dir.join("no-aws-credentials").display().to_string(),
        ),
        ("AWS_ENDPOINT_URL".into(), "http://127.0.0.1:9".into()),
        ("RUST_BACKTRACE".into(), "1".into()),
    ]
}

/// Runs `engine <args>` to completion with the base environment plus `env`.
/// Returns (exit status, stdout, stderr).
pub fn run_engine_cli(args: &[&str], env: &[(&str, &str)]) -> (ExitStatus, String, String) {
    let dir = unique_dir("cli");
    let mut cmd = Command::new(engine_bin());
    cmd.args(args).env_clear().current_dir(&dir);
    for (k, v) in base_env(&dir) {
        cmd.env(k, v);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("run engine binary");
    (
        out.status,
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

impl Engine {
    /// Starts the engine and waits until both the pg port and `GET /healthz` answer.
    pub async fn start(cfg: Cfg) -> Engine {
        Self::try_start(cfg)
            .await
            .unwrap_or_else(|e| panic!("engine did not start: {e}"))
    }

    pub async fn try_start(cfg: Cfg) -> Result<Engine, String> {
        let dir = unique_dir("engine");
        let pg_port = free_port();
        let mut http_port = free_port();
        while http_port == pg_port {
            http_port = free_port();
        }
        let config_path = dir.join("federation-engine.toml");
        std::fs::write(
            &config_path,
            cfg.render(
                &format!("127.0.0.1:{pg_port}"),
                &format!("127.0.0.1:{http_port}"),
            ),
        )
        .unwrap();
        let stdout = std::fs::File::create(dir.join("stdout.log")).unwrap();
        let stderr = std::fs::File::create(dir.join("stderr.log")).unwrap();
        let mut cmd = Command::new(engine_bin());
        cmd.arg("--config")
            .arg(&config_path)
            .env_clear()
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        for (k, v) in base_env(&dir) {
            cmd.env(k, v);
        }
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }
        let child = cmd.spawn().map_err(|e| format!("spawn engine: {e}"))?;
        let mut engine = Engine {
            pg_port,
            http_port,
            dir,
            config_path,
            child: Some(child),
        };
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(status) = engine.child.as_mut().unwrap().try_wait().unwrap() {
                return Err(format!(
                    "engine exited early with {status}\n--- stderr ---\n{}\n--- stdout ---\n{}",
                    engine.stderr_text(),
                    engine.stdout_text()
                ));
            }
            let pg_up = tokio::net::TcpStream::connect(("127.0.0.1", pg_port))
                .await
                .is_ok();
            let http_up = pg_up && http.get(engine.http("/healthz")).send().await.is_ok();
            if http_up {
                return Ok(engine);
            }
            if Instant::now() > deadline {
                return Err(format!(
                    "engine not answering on pg {pg_port} and http {http_port} after 60s\n--- stderr ---\n{}",
                    engine.stderr_text()
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub fn http(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.http_port, path)
    }

    pub fn pg_config(&self, user: &str, password: &str) -> tokio_postgres::Config {
        let mut c = tokio_postgres::Config::new();
        c.host("127.0.0.1")
            .port(self.pg_port)
            .user(user)
            .password(password)
            .dbname("operations")
            .connect_timeout(Duration::from_secs(10));
        c
    }

    /// Connects with the standard login; panics on failure.
    pub async fn connect(&self) -> tokio_postgres::Client {
        self.connect_as(PG_USER, PG_PASSWORD)
            .await
            .unwrap_or_else(|e| panic!("connect to engine: {e}"))
    }

    pub async fn connect_as(
        &self,
        user: &str,
        password: &str,
    ) -> Result<tokio_postgres::Client, tokio_postgres::Error> {
        let (client, conn) = self
            .pg_config(user, password)
            .connect(tokio_postgres::NoTls)
            .await?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(client)
    }

    pub fn stdout_text(&self) -> String {
        std::fs::read_to_string(self.dir.join("stdout.log")).unwrap_or_default()
    }
    pub fn stderr_text(&self) -> String {
        std::fs::read_to_string(self.dir.join("stderr.log")).unwrap_or_default()
    }

    pub fn pid(&self) -> u32 {
        self.child.as_ref().expect("engine running").id()
    }

    /// Sends SIGTERM.
    pub fn sigterm(&self) {
        let ok = Command::new("/bin/kill")
            .args(["-TERM", &self.pid().to_string()])
            .status()
            .expect("run kill")
            .success();
        assert!(ok, "kill -TERM failed");
    }

    /// Waits up to `timeout` for the process to exit.
    pub async fn wait_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(s) = self.child.as_mut().unwrap().try_wait().unwrap() {
                return Some(s);
            }
            if Instant::now() > deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// A reqwest client with a 30 s timeout.
    pub fn http_client(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap()
    }
}
