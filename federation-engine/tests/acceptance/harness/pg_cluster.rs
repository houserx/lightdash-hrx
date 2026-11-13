//! A throwaway Postgres cluster in `<repo>/tmp/acceptance`, listening on 127.0.0.1 only (no unix
//! socket: macOS's 104-byte socket path limit), stopped and deleted on drop.
//!
//! `setup_platform()` creates the synthetic Platform Database used by the platform and write tests:
//! roles `engine_read` (SELECT only) and `engine_write` (DML), tables `widgets` and `patients`
//! (synthetic rows only), and sequence `probe_seq`.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use super::*;

const PG_BIN: &str = "/opt/homebrew/bin";
pub const SUPERUSER_PASSWORD: &str = "test-superuser-password-not-real";
pub const READ_ROLE: &str = "engine_read";
pub const READ_PASSWORD: &str = "test-read-password-not-real";
pub const WRITE_ROLE: &str = "engine_write";
pub const WRITE_PASSWORD: &str = "test-write-password-not-real";

pub struct PgCluster {
    pub port: u16,
    pub dir: PathBuf,
    data: PathBuf,
}

impl Drop for PgCluster {
    fn drop(&mut self) {
        let _ = Command::new(format!("{PG_BIN}/pg_ctl"))
            .arg("-D")
            .arg(&self.data)
            .args(["-m", "immediate", "-w", "stop"])
            .output();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl PgCluster {
    pub async fn start() -> PgCluster {
        let dir = unique_dir("pg");
        let data = dir.join("data");
        let pwfile = dir.join("pwfile");
        std::fs::write(&pwfile, SUPERUSER_PASSWORD).unwrap();
        let out = Command::new(format!("{PG_BIN}/initdb"))
            .arg("-D")
            .arg(&data)
            .args([
                "-U",
                "postgres",
                "-A",
                "scram-sha-256",
                "-E",
                "UTF8",
                "--locale=C",
                "--no-sync",
            ])
            .arg(format!("--pwfile={}", pwfile.display()))
            .output()
            .expect("run initdb");
        assert!(
            out.status.success(),
            "initdb failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let port = free_port();
        let mut conf = std::fs::read_to_string(data.join("postgresql.conf")).unwrap();
        conf.push_str(&format!(
            "\nport = {port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\nmax_connections = 60\n"
        ));
        std::fs::write(data.join("postgresql.conf"), conf).unwrap();
        let cluster = PgCluster { port, dir, data };
        let out = Command::new(format!("{PG_BIN}/pg_ctl"))
            .arg("-D")
            .arg(&cluster.data)
            .arg("-l")
            .arg(cluster.dir.join("postgres.log"))
            .args(["-w", "-t", "60", "start"])
            .output()
            .expect("run pg_ctl start");
        assert!(
            out.status.success(),
            "pg_ctl start failed: {}\n{}",
            String::from_utf8_lossy(&out.stderr),
            std::fs::read_to_string(cluster.dir.join("postgres.log")).unwrap_or_default()
        );
        // Wait for TCP readiness.
        for _ in 0..200 {
            if cluster.try_superuser().await.is_ok() {
                return cluster;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("postgres did not accept connections");
    }

    /// A started cluster with the synthetic Platform Database.
    pub async fn start_platform() -> PgCluster {
        let c = Self::start().await;
        c.setup_platform().await;
        c
    }

    async fn try_superuser(&self) -> Result<tokio_postgres::Client, tokio_postgres::Error> {
        let (client, conn) = tokio_postgres::Config::new()
            .host("127.0.0.1")
            .port(self.port)
            .user("postgres")
            .password(SUPERUSER_PASSWORD)
            .dbname("postgres")
            .connect(tokio_postgres::NoTls)
            .await?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(client)
    }

    /// A superuser client, for seeding and for checking what the engine did.
    pub async fn superuser(&self) -> tokio_postgres::Client {
        self.try_superuser().await.expect("superuser connect")
    }

    pub fn url(&self, user: &str, password: &str) -> String {
        format!(
            "postgres://{user}:{password}@127.0.0.1:{}/postgres",
            self.port
        )
    }
    pub fn read_url(&self) -> String {
        self.url(READ_ROLE, READ_PASSWORD)
    }
    pub fn write_url(&self) -> String {
        self.url(WRITE_ROLE, WRITE_PASSWORD)
    }

    pub async fn setup_platform(&self) {
        let su = self.superuser().await;
        su.batch_execute(&format!(
            r#"
            CREATE ROLE {READ_ROLE} LOGIN PASSWORD '{READ_PASSWORD}';
            CREATE ROLE {WRITE_ROLE} LOGIN PASSWORD '{WRITE_PASSWORD}';
            CREATE TABLE widgets (
                id bigint PRIMARY KEY,
                name text NOT NULL,
                active boolean NOT NULL DEFAULT true,
                created_at timestamptz NOT NULL,
                score double precision,
                note text
            );
            INSERT INTO widgets (id, name, active, created_at, score, note)
            SELECT g, 'widget-' || g, g % 2 = 0,
                   timestamptz '2026-01-01 00:00:00+00' + g * interval '1 hour',
                   g * 1.5, NULL
            FROM generate_series(1, 200) AS g;
            CREATE TABLE patients (
                id bigint GENERATED BY DEFAULT AS IDENTITY (START WITH 1000) PRIMARY KEY,
                full_name text NOT NULL
            );
            INSERT INTO patients (id, full_name) VALUES (1, 'Synthetic Person One'), (2, 'Synthetic Person Two');
            CREATE TABLE t (status text, my_ts_stats text, scripts_status text, state_requirements_status text, a text);
            CREATE SEQUENCE probe_seq;
            GRANT SELECT ON ALL TABLES IN SCHEMA public TO {READ_ROLE};
            GRANT USAGE, SELECT ON SEQUENCE probe_seq TO {READ_ROLE};
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {WRITE_ROLE};
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {WRITE_ROLE};
            "#
        ))
        .await
        .expect("seed platform database");
    }

    /// `SELECT count(*) FROM <table>` as the superuser.
    pub async fn count(&self, table: &str) -> i64 {
        self.superuser()
            .await
            .query_one(&format!("SELECT count(*) FROM {table}"), &[])
            .await
            .unwrap()
            .get(0)
    }

    /// Queries currently running in Postgres whose text contains `needle` (excluding this probe).
    pub async fn active_queries_containing(&self, needle: &str) -> i64 {
        self.superuser()
            .await
            .query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%' || $1 || '%' AND pid <> pg_backend_pid()",
                &[&needle],
            )
            .await
            .unwrap()
            .get(0)
    }
}
