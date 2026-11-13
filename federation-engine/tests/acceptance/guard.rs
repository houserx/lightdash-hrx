//! The write guard (§5), a port of db-query-portal `api/src/services/query-guard.ts` @ aea73de.
//! Every case of the portal's `query-guard.test.ts` is here: read mode through `platform_query`
//! (a rejection is SQLSTATE 42501 with the portal's message), write mode through
//! `POST /v1/write` Preview (a rejection is HTTP 422, or 400 for empty SQL, with the message in
//! `error`).

use serde_json::json;

use crate::harness::*;
use crate::platform::{platform_setup, pq, reader};
use crate::write::{write_req, writer};

pub const GUARD_PHRASES: [&str; 7] = [
    "single SQL statement",
    "disallowed keyword",
    "disallowed function",
    "disallowed construct",
    "requires write mode",
    "must start with",
    "SQL statement is required",
];

enum Expect {
    Allow,
    /// Rejected, and the message contains one of these.
    Reject(&'static [&'static str]),
}
use Expect::*;

const ANY: &[&str] = &GUARD_PHRASES;

fn read_cases() -> Vec<(&'static str, Expect)> {
    vec![
        // guardQuery dblink
        (
            "SELECT dblink_exec('host=x', 'select 1')",
            Reject(&["dblink"]),
        ),
        (
            "SELECT * FROM dblink('host=x', 'select 1') AS t(a int)",
            Reject(&["dblink"]),
        ),
        (
            "SELECT \"dblink_connect\"('c', 'host=x')",
            Reject(&["dblink"]),
        ),
        (
            "SELECT public.DBLINK_open('c', 'k', 'select 1')",
            Reject(&["dblink"]),
        ),
        ("SELECT 1", Allow),
        // U&"..." identifiers and spellings
        (
            "SELECT U&\"dbl\\0069nk_exec\"('a', 'b')",
            Reject(&["U&\"...\""]),
        ),
        ("SELECT U&\"a\" FROM t", Reject(&["U&\"...\""])),
        ("SELECT u&\"a\" FROM t", Reject(&["U&\"...\""])),
        ("SELECT U& \"a\" FROM t", Reject(&["U&\"...\""])),
        (
            "SELECT dblink('x', 'y'), U&\"a\" FROM t",
            Reject(&["function: dblink"]),
        ),
        // SQL-string executors
        (
            "SELECT query_to_xml('SELECT dbl' || 'ink_exec(''host=x'', ''select 1'')', true, false, '')",
            Reject(&["disallowed function"]),
        ),
        (
            "SELECT query_to_xml_and_xmlschema('select 1', true, false, '')",
            Reject(&["disallowed function"]),
        ),
        (
            "SELECT query_to_xmlschema('select 1', true, false, '')",
            Reject(&["disallowed function"]),
        ),
        (
            "SELECT \"query_to_xml\"(chr(115) || 'elect 1', true, false, '')",
            Reject(&["disallowed function"]),
        ),
        (
            "SELECT * FROM ts_stat('select to_tsvector(''a'')')",
            Reject(&["disallowed function"]),
        ),
        (
            "SELECT ts_rewrite('a'::tsquery, 'select null::tsquery, null::tsquery')",
            Reject(&["disallowed function"]),
        ),
        // no false positives
        (
            "SELECT 1 FROM pg_indexes WHERE indexname = 'scripts_status'",
            Allow,
        ),
        (
            "SELECT status::enum_quality_related_events_status FROM t",
            Allow,
        ),
        (
            "SELECT scripts_status, state_requirements_status FROM t",
            Allow,
        ),
        ("SELECT my_ts_stats FROM t", Allow),
        // E'...' strings
        (
            "SELECT E'\\''; SELECT (SELECT 1)::integer; -- '",
            Reject(&["single SQL statement"]),
        ),
        (
            "SELECT e'\\''; SELECT 1; -- '",
            Reject(&["single SQL statement"]),
        ),
        ("SELECT e'\\''; DROP TABLE x; -- '", Reject(ANY)),
        ("SELECT name'a\\'; DROP TABLE x", Reject(ANY)),
        (
            "SELECT E'\\''; DROP TABLE x; -- '",
            Reject(&["single SQL statement", "disallowed keyword"]),
        ),
        ("SELECT E'it''s ; DROP \\\\' AS a", Allow),
        ("SELECT 'a\\'; DROP TABLE x", Reject(ANY)),
        // basics
        ("SELECT * FROM patients", Allow),
        ("SELECT 1;", Allow),
        ("   ", Reject(&["SQL statement is required"])),
        (
            "SELECT 1; DROP TABLE patients;",
            Reject(&["single SQL statement"]),
        ),
        (
            "SELECT '1' ; DELETE FROM patients",
            Reject(&["single SQL statement"]),
        ),
        (
            "SELECT * FROM patients WHERE full_name = 'Doe; Jane'",
            Allow,
        ),
        // dollar quotes
        ("SELECT $$ ; DROP TABLE patients $$ AS note", Allow),
        ("SELECT $tag$ DELETE FROM x ; $tag$ AS note", Allow),
        (
            "SELECT $$x$$ AS a; DROP TABLE patients",
            Reject(&["single SQL statement"]),
        ),
        (
            "SELECT 1 AS a$q$; DELETE FROM patients; SELECT 2 AS b$q$",
            Reject(&["single SQL statement"]),
        ),
        (
            "SELECT 1 AS a$$; DROP TABLE patients; SELECT 2 AS b$$",
            Reject(&["single SQL statement", "disallowed keyword"]),
        ),
        ("SELECT 'x' , $tag$ ; DELETE $tag$ AS note", Allow),
        // write keywords in read mode
        (
            "INSERT INTO patients (full_name) VALUES ('x')",
            Reject(&["write mode"]),
        ),
        (
            "UPDATE patients SET full_name = 'x'",
            Reject(&["write mode"]),
        ),
        ("DELETE FROM patients", Reject(&["write mode"])),
        (
            "WITH deleted AS (DELETE FROM patients RETURNING *) SELECT * FROM deleted",
            Reject(&["write mode"]),
        ),
        // DDL is blocked in read mode as well
        ("DROP TABLE patients", Reject(&["disallowed keyword"])),
        ("BEGIN", Reject(&["must start with"])),
    ]
}

/// eng-guard-read-mode
#[tokio::test]
async fn eng_guard_read_mode() {
    let p = platform_setup(Cfg::new(), false).await;
    let c = p.engine.connect().await;
    set_identity(&c, &reader().token()).await;
    let before = p.cluster.count("patients").await;
    for (sql, expect) in read_cases() {
        let r = c.query(&pq(sql), &[]).await;
        match expect {
            Allow => {
                if let Err(e) = &r {
                    let (code, msg) = e
                        .as_db_error()
                        .map(|d| (d.code().code().to_string(), d.message().to_string()))
                        .unwrap_or_default();
                    assert!(
                        !(code == "42501" && GUARD_PHRASES.iter().any(|g| msg.contains(g))),
                        "the guard must allow {sql:?}, but it said: {msg}"
                    );
                }
            }
            Reject(needles) => {
                let (code, msg) = match r {
                    Ok(_) => panic!("the guard must reject {sql:?}"),
                    Err(e) => e
                        .as_db_error()
                        .map(|d| (d.code().code().to_string(), d.message().to_string()))
                        .unwrap_or_else(|| panic!("{sql:?}: not a server error: {e}")),
                };
                assert_eq!(code, "42501", "guard rejection of {sql:?} ({msg})");
                assert!(
                    needles.iter().any(|n| msg.contains(n)),
                    "{sql:?}: message {msg:?} should contain one of {needles:?}"
                );
                if sql.starts_with("SELECT U&\"dbl") {
                    assert!(
                        !msg.contains("function: dblink"),
                        "an escaped spelling must not be reported as dblink"
                    );
                }
            }
        }
    }
    assert_eq!(p.cluster.count("patients").await, before);
    let rows = c.query(&pq("SELECT * FROM patients"), &[]).await.unwrap();
    assert_eq!(rows.len(), 2);
}

/// eng-guard-write-mode
#[tokio::test]
async fn eng_guard_write_mode() {
    let p = platform_setup(Cfg::new(), true).await;
    let id = writer();
    let preview = |stmt: &str| {
        json!({"statement": stmt, "mode": "preview",
               "confirmation_token": confirmation_token(stmt, &id.sub(), crate::harness::tokens::PROJECT_UUID),
               "description": "guard check", "ticket": null})
    };
    let rejected: Vec<(&str, &[&str])> = vec![
        ("SELECT dblink_exec('host=x', 'select 1')", &["dblink"]),
        (
            "SELECT * FROM dblink('host=x', 'select 1') AS t(a int)",
            &["dblink"],
        ),
        ("SELECT \"dblink_connect\"('c', 'host=x')", &["dblink"]),
        (
            "SELECT public.DBLINK_open('c', 'k', 'select 1')",
            &["dblink"],
        ),
        ("SELECT U&\"dbl\\0069nk_exec\"('a', 'b')", &["U&\"...\""]),
        (
            "SELECT query_to_xml('SELECT dbl' || 'ink_exec(''host=x'', ''select 1'')', true, false, '')",
            &["disallowed function"],
        ),
        (
            "SELECT query_to_xml_and_xmlschema('select 1', true, false, '')",
            &["disallowed function"],
        ),
        (
            "SELECT query_to_xmlschema('select 1', true, false, '')",
            &["disallowed function"],
        ),
        (
            "SELECT \"query_to_xml\"(chr(115) || 'elect 1', true, false, '')",
            &["disallowed function"],
        ),
        (
            "SELECT * FROM ts_stat('select to_tsvector(''a'')')",
            &["disallowed function"],
        ),
        (
            "SELECT ts_rewrite('a'::tsquery, 'select null::tsquery, null::tsquery')",
            &["disallowed function"],
        ),
        ("DROP TABLE patients", &["disallowed keyword"]),
        (
            "ALTER TABLE patients ADD COLUMN x TEXT",
            &["disallowed keyword"],
        ),
        ("TRUNCATE patients", &["disallowed keyword"]),
        (
            "GRANT SELECT ON patients TO someone",
            &["disallowed keyword"],
        ),
        ("CREATE TABLE evil (id INT)", &["disallowed keyword"]),
        ("VACUUM patients", &["disallowed keyword"]),
        (
            "UPDATE patients SET full_name = 'x'; DROP TABLE patients",
            &["single SQL statement"],
        ),
        ("BEGIN", &["must start with"]),
    ];
    for (stmt, needles) in rejected {
        let (status, body) = write_req(&p.engine, Some(&id.token()), &preview(stmt)).await;
        assert_eq!(status, 422, "{stmt:?} must be rejected: {body}");
        let msg = body["error"].as_str().unwrap_or_default();
        assert!(
            needles.iter().any(|n| msg.contains(n)),
            "{stmt:?}: {msg:?} should contain {needles:?}"
        );
    }
    let (status, body) = write_req(&p.engine, Some(&id.token()), &preview("   ")).await;
    assert_eq!(status, 400, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("SQL statement is required")
    );

    for stmt in [
        "INSERT INTO patients (full_name) VALUES ('x')",
        "UPDATE patients SET full_name = 'x'",
        "DELETE FROM patients",
        "WITH deleted AS (DELETE FROM patients RETURNING *) SELECT * FROM deleted",
    ] {
        let (status, body) = write_req(&p.engine, Some(&id.token()), &preview(stmt)).await;
        assert_eq!(status, 200, "write mode allows {stmt:?}: {body}");
        assert_eq!(body["preview"], json!(true));
    }
    assert_eq!(
        p.cluster.count("patients").await,
        2,
        "Preview always rolls back"
    );
}
