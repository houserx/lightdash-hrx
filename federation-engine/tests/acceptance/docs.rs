//! Static checks of the Dockerfile (written, never built) and the README.

use std::path::PathBuf;

fn read(name: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|_| panic!("{} must exist", p.display()))
}

/// eng-dockerfile
#[test]
fn eng_dockerfile() {
    let d = read("Dockerfile");
    let lines: Vec<&str> = d
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.starts_with('#'))
        .collect();
    let froms: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.to_ascii_uppercase().starts_with("FROM "))
        .map(|(i, _)| i)
        .collect();
    assert!(froms.len() >= 2, "multi-stage build");
    let final_stage = &lines[*froms.last().unwrap()..];
    let base = final_stage[0].to_ascii_lowercase();
    assert!(
        base.contains("distroless") || (base.contains("debian") && base.contains("slim")),
        "final stage is distroless or debian-slim: {base}"
    );
    let user = final_stage
        .iter()
        .rev()
        .find(|l| l.to_ascii_uppercase().starts_with("USER "))
        .expect("the final stage sets USER");
    let who = user[5..].trim().to_ascii_lowercase();
    assert!(
        !(who == "root" || who == "0" || who.starts_with("0:") || who.starts_with("root:")),
        "non-root user: {who}"
    );
    assert!(
        final_stage
            .iter()
            .any(|l| l.to_ascii_uppercase().starts_with("COPY --FROM=") && l.contains("engine")),
        "the engine binary is copied from the build stage"
    );
    assert!(
        final_stage
            .iter()
            .any(|l| (l.to_ascii_uppercase().starts_with("ENTRYPOINT")
                || l.to_ascii_uppercase().starts_with("CMD"))
                && l.contains("engine"))
    );
    let expose = final_stage
        .iter()
        .filter(|l| l.to_ascii_uppercase().starts_with("EXPOSE"))
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        expose.contains("5433") && expose.contains("8088"),
        "EXPOSE 5433 8088: {expose}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.contains("cargo build") && l.contains("--release")),
        "release build in the builder stage"
    );
}

/// eng-readme
#[test]
fn eng_readme() {
    let r = read("README.md");
    let headings: Vec<String> = r
        .lines()
        .filter(|l| l.starts_with('#'))
        .map(|l| l.to_ascii_lowercase())
        .collect();
    for h in ["run", "config", "security model"] {
        assert!(
            headings.iter().any(|x| x.contains(h)),
            "a heading mentioning {h:?}; headings: {headings:?}"
        );
    }
    let toml_block = r
        .split("```toml")
        .nth(1)
        .and_then(|rest| rest.split("```").next())
        .expect("an annotated ```toml config block");
    for key in [
        "listen_pg",
        "listen_http",
        "identity_secret_env",
        "max_rows",
        "[[users]]",
        "password_env",
        "[[sources]]",
        "kind",
        "default",
        "restricted",
        "restricted_selectors",
        "restricted_log_groups",
        "role_arn",
        "endpoint_url",
        "read_url_env",
        "write_url_env",
        "allow",
        "project",
        "[audit]",
        "dynamodb_table",
        "s3_bucket",
        "integrity_key_env",
        "tls_cert_file",
        "tls_key_file",
        "test_mode",
    ] {
        assert!(toml_block.contains(key), "the config block shows {key}");
    }
    let comments = toml_block.lines().filter(|l| l.contains('#')).count();
    assert!(
        comments >= 15,
        "the config block is annotated ({comments} comment lines)"
    );
    let security = r
        .to_ascii_lowercase()
        .split("security model")
        .nth(1)
        .map(|s| s.to_string())
        .unwrap_or_default();
    for term in [
        "identity token",
        "42501",
        "restricted telemetry",
        "audit",
        "write mode",
        "58000",
    ] {
        assert!(
            security.contains(term),
            "the security model section covers {term:?}"
        );
    }
    for cmd in ["cargo build", "--config", "--check-config"] {
        assert!(r.contains(cmd), "how to run it mentions {cmd}");
    }
}
