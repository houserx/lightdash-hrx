//! The query guard (CONTRACTS §5): a line-for-line port of db-query-portal
//! `api/src/services/query-guard.ts` @ aea73de, so the engine accepts and refuses exactly what the
//! portal does, with the portal's messages.
//!
//! [`guard`] checks, in the portal's order:
//! 1. the SQL is not empty;
//! 2. it has no `dblink` and no `U&"..."` identifier (scanned on the raw SQL);
//! 3. it calls no function that executes a SQL string (`query_to_xml`, `ts_stat`, ...);
//! 4. it is a single statement;
//! 5. it has no DDL or admin keyword;
//! 6. in read mode, it has no `INSERT`, `UPDATE` or `DELETE` (this blocks data-modifying CTEs);
//! 7. it starts with `SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `INSERT`, `UPDATE` or `DELETE`.
//!
//! Checks 4 to 7 scan a copy of the SQL with comments and quoted content blanked out
//! ([`strip_comments_and_literals`]), so text inside a string can neither hide nor fake a keyword
//! or a `;`.
//!
//! Faithfulness notes: the portal works on JavaScript strings, so "whitespace" here is
//! ECMAScript's (`String.prototype.trim`, regex `\s`), case-insensitive matches are ASCII-only
//! (a JS regex `/i` without the `u` flag never maps a non-ASCII character to an ASCII one), and
//! uppercasing is Unicode's full mapping (as `toUpperCase`).

/// Which statements the caller may run: read (`platform_query`, `platform_explain`) or write
/// (`POST /v1/write`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Read,
    Write,
}

/// Why the guard refused a statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    /// The portal's HTTP status for it: 400 for empty SQL, 422 otherwise.
    pub status: u16,
    /// The portal's message, verbatim.
    pub message: String,
}

impl Rejection {
    fn new(status: u16, message: impl Into<String>) -> Rejection {
        Rejection {
            status,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Rejection {}

const ALWAYS_BLOCKED_KEYWORDS: [&str; 16] = [
    "DROP", "ALTER", "TRUNCATE", "GRANT", "REVOKE", "CREATE", "COPY", "VACUUM", "CALL", "EXECUTE",
    "MERGE", "REFRESH", "LOCK", "REINDEX", "CLUSTER", "SECURITY",
];
// As in the portal: SET/DO/RESET/LISTEN/NOTIFY/PREPARE/DEALLOCATE are deliberately not scanned
// anywhere (SET is legitimate inside `UPDATE ... SET`, and none of them can appear nested inside a
// CTE or subquery), so the leading-keyword check below is what rejects them.

const WRITE_ONLY_KEYWORDS: [&str; 3] = ["INSERT", "UPDATE", "DELETE"];

/// The portal accepts any of these as the leading keyword in either mode; read mode has already
/// refused the write-only ones anywhere in the statement.
const ALL_LEADING_KEYWORDS: [&str; 7] = [
    "SELECT", "WITH", "EXPLAIN", "SHOW", "INSERT", "UPDATE", "DELETE",
];

/// Functions that execute a SQL string given as an argument (the string could assemble a blocked
/// name at run time), in the portal's order.
const SQL_STRING_EXECUTORS: [&str; 5] = [
    "query_to_xml",
    "query_to_xmlschema",
    "query_to_xml_and_xmlschema",
    "ts_stat",
    "ts_rewrite",
];

/// Runs the guard on `raw_sql` for `mode`. On success it returns the statement to run: `raw_sql`
/// trimmed, as the portal runs it.
pub fn guard(raw_sql: &str, mode: Mode) -> Result<String, Rejection> {
    let sql = js_trim(raw_sql);
    if sql.is_empty() {
        return Err(Rejection::new(400, "SQL statement is required."));
    }

    assert_no_dblink(sql)?;
    assert_no_sql_string_executors(sql)?;

    let safe_sql = strip_comments_and_literals(sql);
    assert_single_statement(&safe_sql)?;

    // The specific denylists come first so callers get an actionable reason.
    for keyword in ALWAYS_BLOCKED_KEYWORDS {
        if contains_keyword(&safe_sql, keyword) {
            return Err(Rejection::new(
                422,
                format!("Statement contains a disallowed keyword: {keyword}."),
            ));
        }
    }

    if mode == Mode::Read {
        for keyword in WRITE_ONLY_KEYWORDS {
            if contains_keyword(&safe_sql, keyword) {
                return Err(Rejection::new(
                    422,
                    format!(
                        "Statement contains \"{keyword}\", which requires write mode and the elevated role."
                    ),
                ));
            }
        }
    }

    let leading_keyword = js_trim(&safe_sql)
        .split(is_js_space)
        .next()
        .unwrap_or_default();
    if !ALL_LEADING_KEYWORDS.contains(&leading_keyword) {
        return Err(Rejection::new(
            422,
            format!(
                "Statement must start with one of: {}.",
                ALL_LEADING_KEYWORDS.join(", ")
            ),
        ));
    }

    Ok(sql.to_string())
}

/// ECMAScript's WhiteSpace and LineTerminator characters (what `trim` and regex `\s` match).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `[A-Za-z0-9_$]`: a character that continues an identifier.
fn is_ident_char(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Strips comments and string-literal contents so the keyword and statement-boundary checks
/// can't be fooled by e.g. `SELECT '-- ; DROP TABLE users'`. Returns the uppercased SQL with each
/// comment removed and each quoted string or identifier replaced by one space.
fn strip_comments_and_literals(sql: &str) -> String {
    let s: Vec<char> = sql.chars().collect();
    let at = |i: usize| s.get(i).copied();
    let before = |i: usize, n: usize| i.checked_sub(n).and_then(at);
    let find = |from: usize, pat: &[char]| (from..s.len()).find(|&j| s[j..].starts_with(pat));
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < s.len() {
        if s[i..].starts_with(&['-', '-']) {
            i = find(i, &['\n']).unwrap_or(s.len());
            continue;
        }
        if s[i..].starts_with(&['/', '*']) {
            i = find(i + 2, &['*', '/']).map_or(s.len(), |end| end + 2);
            continue;
        }
        let ch = s[i];
        if ch == '\'' || ch == '"' {
            let quote = ch;
            // E'...' (an escape string) treats backslash as an escape, so E'\'' is ONE literal.
            // Reading `\'` as close + reopen would hide everything up to the next quote.
            let is_escape_string = quote == '\''
                && matches!(before(i, 1), Some('e' | 'E'))
                && !is_ident_char(before(i, 2));
            out.push(' ');
            i += 1;
            while i < s.len() {
                if is_escape_string && s[i] == '\\' {
                    i += 2;
                    continue;
                }
                if s[i] == quote && at(i + 1) == Some(quote) {
                    i += 2;
                    continue;
                }
                if s[i] == quote {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if ch == '$' && !is_ident_char(before(i, 1)) {
            // A dollar quote ($tag$ ... $tag$, tag optional) only starts where a token can begin:
            // Postgres reads the `$tag$` of `foo AS a$tag$` as part of the identifier.
            if let Some(delimiter) = dollar_quote_delimiter(&s[i..]) {
                let close = find(i + delimiter.len(), delimiter);
                out.push(' ');
                i = close.map_or(s.len(), |c| c + delimiter.len());
                continue;
            }
        }
        out.push(ch);
        i += 1;
    }
    out.to_uppercase()
}

/// The `$tag$` (or `$$`) that `s` starts with: `^\$([A-Za-z_][A-Za-z0-9_]*)?\$`.
fn dollar_quote_delimiter(s: &[char]) -> Option<&[char]> {
    if s.first() != Some(&'$') {
        return None;
    }
    let mut end = 1;
    if s.get(1)
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == '_')
    {
        end = 2;
        while s
            .get(end)
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
        {
            end += 1;
        }
    }
    (s.get(end) == Some(&'$')).then(|| &s[..=end])
}

fn assert_single_statement(safe_sql: &str) -> Result<(), Rejection> {
    let trimmed = js_trim(safe_sql);
    let Some(semicolon) = trimmed.find(';') else {
        return Ok(());
    };
    if !js_trim(&trimmed[semicolon + 1..]).is_empty() {
        return Err(Rejection::new(
            422,
            "Only a single SQL statement is allowed per execution (found a second statement after \";\").",
        ));
    }
    Ok(())
}

/// `(^|[^A-Z_])KEYWORD([^A-Z_]|$)` on the uppercased, stripped SQL.
fn contains_keyword(safe_sql: &str, keyword: &str) -> bool {
    let bounds = |c: Option<char>| !c.is_some_and(|c| c.is_ascii_uppercase() || c == '_');
    safe_sql.match_indices(keyword).any(|(at, _)| {
        bounds(safe_sql[..at].chars().next_back())
            && bounds(safe_sql[at + keyword.len()..].chars().next())
    })
}

/// The byte offsets where `needle` (ASCII) occurs in `haystack`, ignoring ASCII case.
fn ascii_ci_matches<'a>(haystack: &'a str, needle: &'a str) -> impl Iterator<Item = usize> + 'a {
    let (h, n) = (haystack.as_bytes(), needle.as_bytes());
    (0..=h.len().saturating_sub(n.len()))
        .filter(move |&at| h.len() >= n.len() && h[at..at + n.len()].eq_ignore_ascii_case(n))
}

/// dblink opens outbound connections (and named ones survive DISCARD ALL), so it is blocked in
/// every mode. Scanned on the raw SQL, since stripping blanks quoted identifiers like
/// `"dblink_exec"`; a string literal that merely mentions dblink is rejected too. `U&"..."`
/// identifiers can spell a name with escapes (`U&"dbl\0069nk"`), so they are rejected outright.
/// The real control is the read role lacking EXECUTE on dblink; this is defence in depth.
fn assert_no_dblink(raw_sql: &str) -> Result<(), Rejection> {
    if ascii_ci_matches(raw_sql, "dblink").next().is_some() {
        return Err(Rejection::new(
            422,
            "Statement contains a disallowed function: dblink.",
        ));
    }
    // /U&\s*"/i
    let unicode_identifier = ascii_ci_matches(raw_sql, "u&").any(|at| {
        raw_sql[at + 2..]
            .trim_start_matches(is_js_space)
            .starts_with('"')
    });
    if unicode_identifier {
        return Err(Rejection::new(
            422,
            "Statement contains a disallowed construct: U&\"...\" identifiers (their escapes can spell a blocked function name).",
        ));
    }
    Ok(())
}

/// Rejects a call to a function that executes a SQL string argument. Matched on the raw SQL at
/// identifier boundaries (`(?<![A-Za-z0-9_$])name(?![A-Za-z0-9_$])`, ignoring case), so
/// `scripts_status` is not `ts_stat` but a quoted `"query_to_xml"(...)` still is.
fn assert_no_sql_string_executors(raw_sql: &str) -> Result<(), Rejection> {
    for function in SQL_STRING_EXECUTORS {
        let found = ascii_ci_matches(raw_sql, function).any(|at| {
            !is_ident_char(raw_sql[..at].chars().next_back())
                && !is_ident_char(raw_sql[at + function.len()..].chars().next())
        });
        if found {
            return Err(Rejection::new(
                422,
                format!("Statement contains a disallowed function: {function}."),
            ));
        }
    }
    Ok(())
}

/// The portal's `query-guard.test.ts` @ aea73de, case for case.
#[cfg(test)]
mod tests {
    use super::Mode::{Read, Write};
    use super::*;

    #[track_caller]
    fn rejects(sql: &str, mode: Mode, any_of: &[&str]) -> Rejection {
        let rejection = guard(sql, mode).expect_err(sql);
        assert!(
            any_of.is_empty() || any_of.iter().any(|n| rejection.message.contains(n)),
            "{sql:?} ({mode:?}): {:?} should contain one of {any_of:?}",
            rejection.message
        );
        rejection
    }

    #[track_caller]
    fn allows(sql: &str, mode: Mode) -> String {
        guard(sql, mode).unwrap_or_else(|r| panic!("{sql:?} ({mode:?}): {r}"))
    }

    #[test]
    fn dblink_is_rejected_in_both_modes() {
        for sql in [
            "SELECT dblink_exec('host=x', 'select 1')",
            "SELECT * FROM dblink('host=x', 'select 1') AS t(a int)",
            "SELECT \"dblink_connect\"('c', 'host=x')",
            "SELECT public.DBLINK_open('c', 'k', 'select 1')",
        ] {
            rejects(sql, Read, &["dblink"]);
            rejects(sql, Write, &["dblink"]);
        }
        assert_eq!(allows("SELECT 1", Read), "SELECT 1");
    }

    #[test]
    fn unicode_identifiers_have_their_own_message() {
        let sql = "SELECT U&\"dbl\\0069nk_exec\"('a', 'b')";
        for mode in [Read, Write] {
            let r = rejects(sql, mode, &["U&\"...\""]);
            assert_eq!(r.status, 422);
            assert!(!r.message.contains("function: dblink"));
        }
        for sql in [
            "SELECT U&\"a\" FROM t",
            "SELECT u&\"a\" FROM t",
            "SELECT U& \"a\" FROM t",
        ] {
            rejects(sql, Read, &["U&\"...\""]);
        }
        rejects(
            "SELECT dblink('x', 'y'), U&\"a\" FROM t",
            Read,
            &["function: dblink"],
        );
    }

    #[test]
    fn sql_string_executors_are_rejected_in_both_modes() {
        for sql in [
            "SELECT query_to_xml('SELECT dbl' || 'ink_exec(''host=x'', ''select 1'')', true, false, '')",
            "SELECT query_to_xml_and_xmlschema('select 1', true, false, '')",
            "SELECT query_to_xmlschema('select 1', true, false, '')",
            "SELECT \"query_to_xml\"(chr(115) || 'elect 1', true, false, '')",
            "SELECT * FROM ts_stat('select to_tsvector(''a'')')",
            "SELECT ts_rewrite('a'::tsquery, 'select null::tsquery, null::tsquery')",
        ] {
            rejects(sql, Read, &["disallowed function"]);
            rejects(sql, Write, &["disallowed function"]);
        }
        rejects(
            "SELECT query_to_xml_and_xmlschema('select 1', true, false, '')",
            Read,
            &["function: query_to_xml_and_xmlschema."],
        );
    }

    #[test]
    fn sql_string_executors_have_no_false_positives() {
        for sql in [
            "SELECT 1 FROM pg_indexes WHERE indexname = 'scripts_status'",
            "SELECT status::enum_quality_related_events_status FROM t",
            "SELECT scripts_status, state_requirements_status FROM t",
            "SELECT my_ts_stats FROM t",
        ] {
            allows(sql, Read);
        }
    }

    #[test]
    fn escape_strings() {
        rejects(
            "SELECT E'\\''; SELECT (SELECT 1)::integer; -- '",
            Read,
            &["single SQL statement"],
        );
        rejects(
            "SELECT e'\\''; SELECT 1; -- '",
            Read,
            &["single SQL statement"],
        );
        rejects("SELECT e'\\''; DROP TABLE x; -- '", Read, &[]);
        // `name'...'` is not an E-string, so the quote closes at \'.
        rejects("SELECT name'a\\'; DROP TABLE x", Read, &[]);
        rejects(
            "SELECT E'\\''; DROP TABLE x; -- '",
            Read,
            &["single SQL statement", "disallowed keyword"],
        );
        assert!(allows("SELECT E'it''s ; DROP \\\\' AS a", Read).contains("SELECT"));
        // standard_conforming_strings: 'a\' is a complete literal.
        rejects("SELECT 'a\\'; DROP TABLE x", Read, &[]);
    }

    #[test]
    fn basics() {
        assert_eq!(
            allows("SELECT * FROM patients", Read),
            "SELECT * FROM patients"
        );
        assert_eq!(allows("SELECT 1;", Read), "SELECT 1;");
        let empty = rejects("   ", Read, &["SQL statement is required"]);
        assert_eq!(empty.status, 400);
        rejects(
            "SELECT 1; DROP TABLE patients;",
            Read,
            &["single SQL statement"],
        );
        rejects(
            "SELECT '1' ; DELETE FROM patients",
            Read,
            &["single SQL statement"],
        );
        assert!(
            allows("SELECT * FROM patients WHERE full_name = 'Doe; Jane'", Read)
                .contains("Doe; Jane")
        );
    }

    #[test]
    fn dollar_quotes() {
        assert!(allows("SELECT $$ ; DROP TABLE patients $$ AS note", Read).contains("$$"));
        assert!(allows("SELECT $tag$ DELETE FROM x ; $tag$ AS note", Read).contains("$tag$"));
        rejects(
            "SELECT $$x$$ AS a; DROP TABLE patients",
            Read,
            &["single SQL statement"],
        );
        // `a$q$` and `b$q$` are identifiers, not dollar quotes.
        rejects(
            "SELECT 1 AS a$q$; DELETE FROM patients; SELECT 2 AS b$q$",
            Read,
            &["single SQL statement"],
        );
        rejects(
            "SELECT 1 AS a$$; DROP TABLE patients; SELECT 2 AS b$$",
            Read,
            &["single SQL statement", "disallowed keyword"],
        );
        assert!(allows("SELECT 'x' , $tag$ ; DELETE $tag$ AS note", Read).contains("$tag$"));
    }

    #[test]
    fn writes_need_write_mode() {
        for sql in [
            "INSERT INTO patients (full_name) VALUES ('x')",
            "UPDATE patients SET full_name = 'x'",
            "DELETE FROM patients",
            "WITH deleted AS (DELETE FROM patients RETURNING *) SELECT * FROM deleted",
        ] {
            rejects(sql, Read, &["write mode"]);
            allows(sql, Write);
        }
    }

    #[test]
    fn ddl_and_admin_are_always_blocked() {
        for sql in [
            "DROP TABLE patients",
            "ALTER TABLE patients ADD COLUMN x TEXT",
            "TRUNCATE patients",
            "GRANT SELECT ON patients TO someone",
            "CREATE TABLE evil (id INT)",
            "VACUUM patients",
        ] {
            rejects(sql, Write, &["disallowed keyword"]);
            rejects(sql, Read, &["disallowed keyword"]);
        }
    }

    #[test]
    fn statements_must_start_with_an_allowed_keyword() {
        let r = rejects("BEGIN", Read, &["must start with"]);
        assert_eq!(
            r.message,
            "Statement must start with one of: SELECT, WITH, EXPLAIN, SHOW, INSERT, UPDATE, DELETE."
        );
        rejects("BEGIN", Write, &["must start with"]);
        rejects("-- only a comment", Read, &["must start with"]);
    }

    #[test]
    fn comments_are_not_scanned_and_sql_is_trimmed() {
        assert_eq!(
            allows("\u{feff}\n SELECT 1 -- DROP; DELETE\n\t", Read),
            "SELECT 1 -- DROP; DELETE"
        );
        allows("SELECT /* ; DROP */ 1", Read);
        // An unterminated comment runs to the end, as in the portal.
        allows("SELECT 1 /* unterminated ; DROP", Read);
        rejects(
            "SELECT 1 /* x */; DROP TABLE t",
            Read,
            &["single SQL statement"],
        );
    }
}
