//! Whether a LogQL query may touch a Loki source's `restricted_selectors` (CONTRACTS §1.2).
//!
//! The check fails closed: a query is open only when every stream selector in it is *provably*
//! disjoint from every restricted selector. Two selectors are provably disjoint when, for some
//! label, one has `label="v"` and the other `label="w"` with `v != w`, or one has `label="v"` and
//! the other `label!="v"`. Anything the parser here doesn't fully understand (an escape sequence
//! in a value, a `#` comment, a query without a selector, an unbalanced brace) counts as touching
//! Restricted Telemetry, and so does an unparseable restricted selector in the config.

/// A label matcher operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Eq,
    Ne,
    Re,
    NotRe,
}

/// One `label op "value"` matcher of a stream selector.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Matcher {
    label: String,
    op: Op,
    value: String,
}

/// A stream selector: matchers that a stream must all satisfy.
type Selector = Vec<Matcher>;

/// True unless every stream selector in `query` is provably disjoint from every selector in
/// `restricted`.
pub fn may_touch(query: &str, restricted: &[String]) -> bool {
    if restricted.is_empty() {
        return false;
    }
    let Some(restricted) = restricted
        .iter()
        .map(|s| parse_selector(s.trim()))
        .collect::<Option<Vec<_>>>()
    else {
        return true;
    };
    let Some(selectors) = query_selectors(query) else {
        return true;
    };
    if selectors.is_empty() {
        return true;
    }
    !selectors
        .iter()
        .all(|q| restricted.iter().all(|r| disjoint(q, r)))
}

/// Whether no stream can match both `a` and `b`.
fn disjoint(a: &Selector, b: &Selector) -> bool {
    a.iter().any(|x| {
        b.iter().any(|y| {
            x.label == y.label
                && match (x.op, y.op) {
                    (Op::Eq, Op::Eq) => x.value != y.value,
                    (Op::Eq, Op::Ne) | (Op::Ne, Op::Eq) => x.value == y.value,
                    _ => false,
                }
        })
    })
}

/// Every stream selector (`{...}` outside string literals) in a LogQL log or metric query, or
/// `None` if the query isn't understood well enough to be sure none was missed.
fn query_selectors(query: &str) -> Option<Vec<Selector>> {
    let bytes = query.as_bytes();
    let mut selectors = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'`' => i = string_end(bytes, i)?,
            // A comment could hide a quote that shifts what is inside a string.
            b'#' => return None,
            b'}' => return None,
            b'{' => {
                let end = selector_end(bytes, i)?;
                selectors.push(parse_selector(&query[i..end])?);
                i = end;
            }
            _ => i += 1,
        }
    }
    Some(selectors)
}

/// The index just past the string literal that starts at `start` (a `"` string, which may hold
/// `\` escapes, or a raw `` ` `` string).
fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let quote = bytes[start];
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if quote == b'"' => i += 2,
            b if b == quote => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// The index just past the `}` that closes the selector opening at `start`.
fn selector_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'`' => i = string_end(bytes, i)?,
            b'}' => return Some(i + 1),
            b'{' | b'#' => return None,
            _ => i += 1,
        }
    }
    None
}

/// Parses `{label op "value", ...}` (at least one matcher). Values with escape sequences are
/// refused rather than decoded.
fn parse_selector(text: &str) -> Option<Selector> {
    let inner = text.strip_prefix('{')?.strip_suffix('}')?;
    let mut rest = inner.trim_start();
    let mut matchers = Vec::new();
    loop {
        let label_len = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        let label = &rest[..label_len];
        if label.is_empty() || label.starts_with(|c: char| c.is_ascii_digit()) {
            return None;
        }
        rest = rest[label_len..].trim_start();
        let (op, after) = if let Some(r) = rest.strip_prefix("!=") {
            (Op::Ne, r)
        } else if let Some(r) = rest.strip_prefix("=~") {
            (Op::Re, r)
        } else if let Some(r) = rest.strip_prefix("!~") {
            (Op::NotRe, r)
        } else if let Some(r) = rest.strip_prefix('=') {
            (Op::Eq, r)
        } else {
            return None;
        };
        rest = after.trim_start();
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '`' {
            return None;
        }
        let end = rest[1..].find(quote)? + 1;
        let value = &rest[1..end];
        if value.contains('\\') {
            return None;
        }
        matchers.push(Matcher {
            label: label.to_string(),
            op,
            value: value.to_string(),
        });
        rest = rest[end + 1..].trim_start();
        if rest.is_empty() {
            return Some(matchers);
        }
        rest = rest.strip_prefix(',')?.trim_start();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touches(query: &str) -> bool {
        may_touch(query, &[r#"{namespace="platform"}"#.to_string()])
    }

    #[test]
    fn provably_disjoint_selectors_are_open() {
        for q in [
            r#"{namespace="web"}"#,
            r#"{namespace="web"} |= "error""#,
            r#"{ namespace = "web" , app="api" }"#,
            r#"{namespace=`web`} |= "{namespace=\"platform\"}" | line_format "{{.app}}""#,
            r#"sum(count_over_time({namespace="web"}[5m])) / sum(rate({namespace="api"}[1m]))"#,
            r#"{namespace="web", namespace="platform"}"#,
        ] {
            assert!(!touches(q), "{q} is open");
        }
    }

    #[test]
    fn anything_that_may_overlap_is_restricted() {
        for q in [
            r#"{namespace="platform"}"#,
            r#"{namespace="platform", app="api"} |= "error""#,
            r#"{app="api"}"#,
            r#"{namespace=~"plat.*"}"#,
            r#"{namespace=~"web"}"#,
            r#"{namespace!="web"}"#,
            r#"{namespace!~"web"}"#,
            r#"sum(count_over_time({namespace="platform"}[5m]))"#,
            r#"sum(count_over_time({namespace="web"}[5m])) / sum(count_over_time({namespace="platform"}[5m]))"#,
            r#"{namespace="platform"}"#,
            r#"{namespace="web"} # "
{namespace="platform"}"#,
            r#"{namespace="web""#,
            r#"{namespace="web"}}"#,
            r#"{}"#,
            r#"{namespace="web",}"#,
            r#"vector(1)"#,
            "",
        ] {
            assert!(touches(q), "{q} may touch Restricted Telemetry");
        }
    }

    #[test]
    fn restricted_selectors_with_several_matchers() {
        let restricted = [r#"{namespace="platform", app!="db"}"#.to_string()];
        assert!(may_touch(r#"{namespace="platform"}"#, &restricted));
        assert!(!may_touch(r#"{namespace="platform", app="db"}"#, &restricted));
        assert!(!may_touch(r#"{namespace="web", app="api"}"#, &restricted));
    }

    #[test]
    fn no_or_unparseable_restricted_selectors() {
        assert!(!may_touch(r#"{app="api"}"#, &[]));
        assert!(may_touch(r#"{namespace="web"}"#, &["namespace=platform".to_string()]));
    }
}
