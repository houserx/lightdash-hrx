# PROGRESS: build line `engine`, the ENG-1799 Federation Engine

This file is the hand-off between sessions. Each session starts with an empty memory. Read this
first, then `CONTEXT.md`, `docs/adr/0001-0004`, and `docs/eng-1799/CONTRACTS.md` §1, §3, §4.2, §5, §6.

## What this line builds

A new Rust workspace at `federation-engine/`, built on Apache DataFusion. It speaks the Postgres wire
protocol to Lightdash and exposes Telemetry Sources (Prometheus, Loki, CloudWatch, CloudWatch Logs,
Tempo), the Platform Database and the Ops Marts as SQL. It also runs an HTTP side port for
`/healthz`, `/metrics`, Write Mode (`POST /v1/write`) and the audit browser (`GET /v1/audit`).
Nothing else in the monorepo is touched. No Node packages are installed and no `packages/backend/src/ee/**` edits are made.

## State at hand-off (init session, 2026-11-08)

- `federation-engine/Cargo.toml`: the workspace and root package `federation-engine`, with the
  `engine` binary (`src/main.rs`, a stub that prints "not implemented" and exits 2) and the
  `acceptance` test target. Dependencies are still empty; dev-dependencies serve the harness.
- `federation-engine/tests/acceptance/**`: the **protected** acceptance suite (83 feature tests,
  3 harness self-tests). Later sessions cannot edit it. Make the engine satisfy it.
- `init.sh`: reaps stale test leftovers, then runs
  `cargo build --manifest-path federation-engine/Cargo.toml --all-targets` (debug) into
  `federation-engine/target`. It never starts a server.
- `.gitignore` gained `/federation-engine/target/` and `/tmp/`.
- The feature list lives with the supervisor. Features are taken strictly in order; the ids are listed below.

## How to build, run and test

```bash
bash ./init.sh                                     # build engine + acceptance tests (debug)
# one feature's check (exactly what the supervisor runs):
cargo test --manifest-path federation-engine/Cargo.toml --test acceptance -- pgwire::eng_pg_startup_auth --exact
# all of one area / everything:
cargo test --manifest-path federation-engine/Cargo.toml --test acceptance -- platform::
cargo test --manifest-path federation-engine/Cargo.toml --test acceptance
# harness self-tests (pass on any tree; they prove the machine and the mocks are fine):
cargo test --manifest-path federation-engine/Cargo.toml --test acceptance -- harness_selftest
# run the engine by hand:
federation-engine/target/debug/engine --config federation-engine.toml
federation-engine/target/debug/engine --check-config --config federation-engine.toml
```

Every check is `cargo test ... --test acceptance -- <module>::<feature_id_with_underscores> --exact`.
A test's engine keeps `stdout.log`, `stderr.log` and its `federation-engine.toml` in
`tmp/acceptance/engine-*`. Read them when a check fails. `init.sh` deletes those directories after 20 minutes.

**Clippy and rustfmt are not installed in the default toolchain** (`~/.rustup`, rustc 1.99.1
minimal profile). Do not modify `~/.rustup`. Install a private copy inside the repo's gitignored
`tmp/` instead, then use it for linting:

```bash
RUSTUP_HOME=$PWD/tmp/rustup CARGO_HOME=$PWD/tmp/cargohome ~/.cargo/bin/rustup toolchain install 1.99.1 --profile minimal -c rustfmt -c clippy
TC=$PWD/tmp/rustup/toolchains/1.99.1-aarch64-apple-darwin/bin
(cd federation-engine && PATH=$TC:$PATH $TC/cargo fmt --check && \
 PATH=$TC:$PATH CARGO_TARGET_DIR=$PWD/../tmp/clippy-target $TC/cargo clippy --all-targets -- -D warnings)
```

The protected tests are already fmt-clean and clippy-clean (`-D warnings`, clippy 1.99.1).

## How the acceptance harness drives the engine (read `tests/acceptance/harness/`)

- `Engine::start(Cfg)` writes `federation-engine.toml` and prepends
  `listen_pg = "127.0.0.1:<free>"` and `listen_http = "127.0.0.1:<free>"`. It spawns
  `target/debug/engine --config <path>` with a **cleared environment**: `PATH`, a private `HOME`,
  and the variables below. It waits up to 60 s until the pg port accepts TCP **and** `GET /healthz`
  answers with any status. So `/healthz` must answer within a few seconds even when sources are dead
  (probe concurrently, with short timeouts). Even the first pg-wire feature therefore needs the HTTP
  port serving `/healthz`.
  - `HRX_IDENTITY_SECRET=test-identity-secret-not-real`, `HRX_PG_PASSWORD_OPERATIONS=test-password-not-real`,
    `AUDIT_INTEGRITY_KEY=test-integrity-key-not-real`
  - `AWS_ACCESS_KEY_ID=AKIDTESTNOTREAL00001`, `AWS_SECRET_ACCESS_KEY=…`, `AWS_REGION=us-east-2`,
    `AWS_EC2_METADATA_DISABLED=true`, `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE` set to missing paths,
    `AWS_ENDPOINT_URL=http://127.0.0.1:9`. That last one is a dead safety net: every AWS client **must** use
    its configured endpoint override.
  - Login: user `lightdash-operations`, password from `HRX_PG_PASSWORD_OPERATIONS`, dbname `operations`.
- Mocks (`mock_http.rs`) are a hand-written HTTP/1.1 server on 127.0.0.1:0. It records requests and
  detects a client hanging up during a delayed reply (`cancelled()`). That is how the tests see the
  engine abandon in-flight source work. Request params may come in the query string or a form body.
- AWS mocks (`aws.rs`) decode Smithy RPC v2 CBOR, AWS JSON 1.0/1.1 and the query protocol, and reply in the same protocol.
  They were verified against the current SDK crates: `aws-sdk-cloudwatch` 1.140 uses **CBOR**,
  `cloudwatchlogs` uses JSON 1.1, `dynamodb` JSON 1.0, `sts` the query protocol, and `s3` REST with
  aws-chunked bodies. The DynamoDB mock implements PutItem and Query over the portal GSIs.
- `pg_cluster.rs` runs a throwaway Postgres (`/opt/homebrew/bin/initdb`, `pg_ctl`; SCRAM auth;
  127.0.0.1 only; `unix_socket_directories=''`) with a synthetic Platform Database:
  roles `engine_read` (SELECT) and `engine_write` (DML); tables `widgets` (200 rows), `patients`
  (2 synthetic rows, identity id from 1000), `t`; sequence `probe_seq`.
- `raw_pg.rs` is a byte-level pg-wire frontend that emulates node-postgres + `pg-cursor`:
  Parse(unnamed), Bind to portal `C_n`, Describe portal, Flush, then Execute(100) + Flush until
  CommandComplete, then Sync. It supports cleartext, MD5 and SCRAM.
- `tokens.rs` mints §3 identity tokens, Write Mode confirmation tokens (A6), and reimplements the
  portal's `computeIntegrityHash` and `JSON.stringify(record, null, 2)`.
  `fixtures/integrity_hash.json` was computed by the portal's own Node algorithm.

## Architecture (chosen; the first feature sessions fill it in)

- Keep `federation-engine` (root package) as the home of the `engine` binary. The tests use
  `CARGO_BIN_EXE_engine`, and `version()` must report this package's version
  (`env!("CARGO_PKG_VERSION")` = `0.1.0` today). Put library code in `crates/*` workspace members
  (add them to `[workspace] members`). A suggested split: `engine-config`, `engine-pgwire`
  (server and session state), `engine-functions` (table functions and scalar helpers),
  `engine-sources` (HTTP/AWS/BigQuery clients), `engine-platform` (pools, guard, write), `engine-audit`, `engine-http` (axum).
- Crates: `datafusion` (55.x), `pgwire` (0.42) or `datafusion-postgres` (0.19; check that it pins the
  same datafusion), `tokio`, `axum` 0.8, `reqwest`, `serde`/`serde_json`/`toml`,
  `aws-config`/`aws-sdk-{cloudwatch,cloudwatchlogs,dynamodb,s3,sts}` 1.x, `tokio-postgres` with a pool
  (`deadpool-postgres` or `bb8`) for the Platform Database, `tracing` + `tracing-subscriber` (json),
  `hmac`/`sha2`/`base64`, `chrono`, `uuid`, `rustls`/`tokio-rustls`.
- Use the DataFusion SQL dialect **PostgreSQL** (`datafusion.sql_parser.dialect = 'PostgreSQL'`).
  The tests put backslashes inside `'...'` literals and expect them literal (standard_conforming_strings).
- Each table function is a DataFusion `TableFunctionImpl`. Its arguments are evaluated at plan time,
  the whole native query goes to the source, and SQL on top runs in DataFusion. Access checks run
  per function call at plan time, so JOINs and subqueries cannot route around them.
- **rustls:** dev-dependencies enable rustls' default `aws-lc-rs` backend, and dev features unify into
  the engine in test builds. If the engine also enables `ring`, install a process-wide provider
  explicitly at startup (`rustls::crypto::aws_lc_rs::default_provider().install_default()`).
- Do not add `preserve_order` to `serde_json`. Build the S3 audit body in the portal key order
  explicitly (the order is in `EXECUTION_KEY_ORDER` in `harness/tokens.rs`).
- `[profile.dev.package."*"] opt-level = 2` keeps dependencies optimised in the debug build that the
  performance check (`eng-perf-promql-large-range`, < 2 s) runs on. Keep it.

## Config (`federation-engine.toml`)

§1.4 keys, plus these extensions the tests use. They need the narrowest readings; see A25.

| Where | Key | Meaning |
|---|---|---|
| top | `listen_pg`, `listen_http`, `identity_secret_env`, `max_rows` (default 100000) | §1.4 |
| top | `test_mode` (bool, default false) | enables `POST /v1/write/confirmations/verify` |
| top | `tls_cert_file`, `tls_key_file` (PEM paths) | optional TLS on pg-wire |
| `[[users]]` | `name`, `password_env` | pg-wire logins |
| `[[sources]]` all | `name`, `kind`, `default` (bool), `restricted` (bool), `max_rows` (override) | one default per kind; a lone source of a kind is its default |
| prometheus/loki/tempo | `url` | base URL (`/api/v1/query_range`, `/loki/api/v1/query_range`, `/api/search`, `/api/traces/<id>` or `/api/v2/traces/<id>`) |
| loki | `restricted_selectors` | A15 |
| cloudwatch | `region`, `role_arn`, `endpoint_url`, `sts_endpoint_url` | SigV4 via the default chain; role assumed through STS |
| cloudwatch_logs | `region`, `role_arn`, `endpoint_url`, `sts_endpoint_url`, `restricted_log_groups`, `poll_interval_ms` (default 1000) | |
| platform_postgres | `read_url_env`, `write_url_env` (unset = Write Mode off) | |
| bigquery | `project`, `allow`, `api_base_url` (default `https://bigquery.googleapis.com`), `access_token_env` (static token source) **or** `workload_identity_audience`, `service_account`, `gcp_sts_url` (default `https://sts.googleapis.com/v1/token`), `gcp_iam_credentials_url` (default `https://iamcredentials.googleapis.com`) | |
| `[audit]` | `dynamodb_table`, `s3_bucket`, `integrity_key_env` (optional), `region`, `dynamodb_endpoint_url`, `s3_endpoint_url`, `s3_retention_days` (default 2555) | S3 uses path-style when an endpoint override is set |

`--check-config` validates without binding or connecting. It fails, naming the problem, on: TOML
errors, a referenced env var that is unset (name it, never echo values), an unknown kind, duplicate
source names, two defaults of one kind, or audited sources (`restricted`, `restricted_selectors`,
`restricted_log_groups`, `platform_postgres`) without `[audit]`.

## Contract assumptions

These are narrowest compatible readings where `CONTRACTS.md` is silent. The tests encode them. The integration line reconciles them.

- **A1 Login.** Any of cleartext, MD5 or SCRAM-SHA-256 password auth. A wrong user or password gets `28P01`.
- **A2 Session.** The default `TimeZone` is `UTC`. `SET timezone TO 'x'` is per session and shows in
  `current_setting('TIMEZONE')`. Unknown `SET`s (including `search_path` and `application_name`) are accepted.
  `BEGIN`/`START TRANSACTION`/`COMMIT`/`ROLLBACK` are accepted, and named portals survive `Sync` inside them.
- **A3 Types.** int4 → OID 23 as well (e.g. `pg_backend_pid()`). Timestamps without a zone are UTC.
  Timestamptz text output looks like Postgres's: `2026-01-02 03:04:05+00`.
- **A4 Extended protocol.** A `$n::type` cast fixes that parameter's type in ParameterDescription
  (tokio-postgres binds by it). Client-declared parameter OIDs are honoured.
- **A5 Identity.** `SET hrx.identity` always succeeds. An invalid token counts as no claims at query time.
  The identity belongs to the session until the next SET. A token is valid only with `v == 1`,
  `exp > now`, `iat ≤ now + 60`, `exp − iat ≤ 300`, and a correct signature over base64url(payload)
  without padding. Refusals are `42501` naming the missing claim (`telemetry_restricted`,
  `platform_read`, `platform_explain`). An agent refusal also says `agent`.
  A missing or empty `audit.description` gives `42501 "audited query requires a description"`.
  `sys = true` counts as `agent = false`.
- **A6 Confirmation token** (§4.2 lists only its inputs):
  `<b64url(payload)>.<b64url(HMAC-SHA256(identity_secret, b64url(payload)))>`, payload
  `{"v":1,"typ":"write_confirmation","statement_sha256":"<hex sha256 of statement UTF-8>","sub":"<user>","project":"<project uuid>","iat":s,"exp":s,"nonce":"<b64url>"}`.
  It is valid when it verifies, `typ` matches, it is not expired, `exp − iat ≤ 120`, and sub and
  project equal the bearer identity's `sub` and `project`. It is spent after the guard passes and
  before execution. A spent token gets `409` whatever the mode. **Lightdash's minting must match this. Flag it to the integration line.**
- **A7 `POST /v1/write`.** The error body is `{"error": msg, "sqlstate"?: code}`. Status codes:
  `400` for a malformed body, empty SQL, an empty description or a bad mode;
  `401` for a missing or invalid bearer;
  `403` for a missing `platform_write`, an invalid confirmation token, or an agent commit (message says `agent`);
  `409` for a reused token;
  `422` for a guard rejection (portal message);
  `400`/`422` with the Postgres `sqlstate` for a statement error;
  `500` with `58000 "audit write failed"`;
  `503` when Write Mode is off.
  `returning` is `null` without a RETURNING clause; otherwise it holds at most 100 rows as JSON
  objects. `audit_id` is the audit item id. The body's `description` and `ticket` go into the audit record.
- **A8 `POST /v1/write/confirmations/verify`** (test_mode only, else 404): bearer identity plus
  `{statement, confirmation_token}` returns `{"valid": bool}`. It does not spend the token.
- **A9 Guard on pg-wire.** A rejection is SQLSTATE `42501` carrying the portal's exact message. Read mode
  applies to `platform_query` and `platform_explain`; write mode applies to `/v1/write`. Rejected statements are not audited.
- **A10 Audit content.** `sql` is the SQL text as received over pg-wire (for writes, the statement).
  `database` is the source name. There is one record per executed statement, not per Parse or Describe,
  and failures are recorded (`status: error`, `errorMessage`, `rowCount: null`).
  `action` is `assertion` when `sys = true`, `ai_ask` when `agent = true` or `iss = telemetry-mcp`,
  and `query` otherwise. `linearTicketId` comes from `audit.ticket`, or the body `ticket` for writes,
  and is omitted when null. `savedScriptId` is never written. `durationMs` is an integer.
  `createdAt` is `toISOString()` style with milliseconds.
- **A11 Fail closed.** A failed DynamoDB put **or** S3 put fails the query with `58000 "audit write failed"`
  and returns no rows. This is stricter than the portal, which tolerated S3 failures, because §6 says so.
  Results are not streamed before the record is written.
- **A12 S3 object.** The key is `executions/<createdAt>/<id>.json`. The body is `JSON.stringify(item, null, 2)`
  in the portal key order. It uses `ContentType: application/json`, `ObjectLockMode: COMPLIANCE`, and
  retain-until = now + `s3_retention_days`.
- **A13 Integrity hash.** It is HMAC under the env var named by `integrity_key_env`. Without that key,
  it is `sha256:` (the portal's fallback).
- **A14 `GET /v1/audit`.** Precedence is `ticket` (byTicket), then `user` = `executedByEmail` (byUser),
  then `month` (byMonth, one partition; a bad format gets 400). Pages hold 25, newest first.
  Cursors are the portal's: base64(JSON(LastEvaluatedKey)) for ticket and user, base64(JSON({month, key})) for month.
  With no parameters, follow the portal's last-30-days browse (untested). Responses are `{items, nextCursor}`.
  `401`, or `403` without `platform_read`, is returned before the store is touched.
- **A15 Loki restricted selectors.** A query stream selector is open only if it is provably disjoint
  from every restricted selector, i.e. it has `label="v"` where the restricted selector has `label="w"` and v ≠ w.
  Anything else, including regex or negative matchers and missing labels, counts as touching it.
  This applies to `logql` and `logql_metric`.
- **A16 Restricted log groups.** Each comma-separated group is trimmed and compared exactly.
- **A17 PromQL shapes.** `series` = `series_name(labels)` (keys sorted, Prometheus escaping).
  A scalar gives labels `{}` and series `{}`. A string gives value NULL, labels `{}`, series = the string.
  A matrix answer to `promql_instant` is accepted. Values `NaN`/`±Inf` are kept.
- **A18 Tempo.** `span_count` = Σ `spanSets[].matched` (or `spanSet.matched`). Trace and span ids are
  lowercase hex: Tempo JSON uses base64; 32- or 16-character hex input is also accepted.
  `status` is `unset`, `ok` or `error`. `attributes` is a flat `{key: value}` with intValue as a number.
  An unknown trace gives zero rows. The default search limit is 20.
- **A19 CloudWatch input** is Grafana's stored target model, not the AWS shape. `metricEditorMode = 1`
  or a non-empty `expression` gives an `Expression`; otherwise a `MetricStat` is built from
  `namespace`/`metricName`/`dimensions` (string or one-element array)/`statistic`/`period`.
  `Id` is Grafana's `id` if valid, else generated (`^[a-z][a-zA-Z0-9_]*$`). The Grafana `label`, when
  non-empty, becomes the AWS `Label` and the `series`; otherwise `series` is each result's `Label`.
  Region `default` means the source's region. `labels` is a JSON object (content untested).
  Multi-value dimensions and `matchExact = false` should follow Grafana's SEARCH translation (untested).
- **A20 Logs Insights.** `timestamp` comes from `@timestamp` (UTC), `message` from `@message`, and
  `fields` holds every field except `@ptr`. A final status other than Complete is an error naming it.
  A timeout or cancel calls `StopQuery` and stops polling.
- **A21 Ops Marts.** An allow entry `dataset.table` is exposed as `ops_marts.<dataset>.<table>`.
  The schema comes from `tables.get` and data from `jobs.query` plus `getQueryResults` paging, or from
  `tabledata.list`. Map result columns by name, because the mock returns the full schema.
  Types: TIMESTAMP→timestamptz, STRING→text, INTEGER/INT64→int8, FLOAT/FLOAT64→float8, BOOL/BOOLEAN→bool.
  Anything else is `42P01`, and BigQuery is never asked about it. Ops Marts need only a login and are not audited.
  The token is cached (one STS exchange and one `generateAccessToken` per lifetime).
- **A22 Time arguments.** ISO-8601 strings (with offsets and fractions), timestamptz, or naive timestamps
  (UTC) are accepted. The step must be > 0. Invalid arguments fail before any source request.
- **A23 max_rows** counts the rows one table-function call produces (the source result), regardless of SQL on top.
- **A24 Metrics names:** `federation_engine_queries_total{source}`,
  `federation_engine_query_duration_seconds` (histogram, `source` label),
  `federation_engine_query_errors_total{source}`, `federation_engine_audit_write_failures_total`.
- **A25 Config extensions:** see the table above.
- **A26 Logs** are one JSON object per line with `timestamp` and `level` (tracing-subscriber json is fine),
  on stdout or stderr. They never contain result values, identity tokens or payload fields
  (email, description), passwords or keys.
- **A27 `/healthz`** returns a JSON body listing each source by name with its health: 200 when all are
  reachable, otherwise 503. For URL sources, any HTTP answer from the base URL counts as reachable.
- **A28 Shutdown.** SIGTERM stops accepting, drains in-flight queries, and exits 0.
- **A29 Agents and the Platform Database.** An agent holding `platform_read` may run `platform_query`
  (the MCP `platform_query` tool), audited as `ai_ask`. Agents may Preview but never commit.
- **A30 platform_tables/columns/explain.** `platform_tables` lists user schemas only.
  `platform_columns` is in ordinal order with information_schema `data_type` and boolean `is_nullable`.
  `platform_explain` needs `platform_read` or `platform_explain` plus a description (it is audited),
  and its argument goes through the read guard.

## Conventions

- Glossary terms from `CONTEXT.md`: Telemetry Source, Restricted Telemetry, Audited Query, Write Mode,
  Preview, Ops Mart, Platform Database. Never use their `_Avoid_` terms in code, docs or messages.
- Fixtures and test values are synthetic. Never print, log or commit PHI or secrets. Fake secrets look like `test-…-not-real`.
- No network to HouseRx systems, no credentials, no Docker. Write the Dockerfile; never build it.
- Keep `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` clean (see the toolchain note).
- Do not edit `federation-engine/tests/acceptance/**`. Keep the dev-dependencies the harness uses.
  Keep the `engine` binary in the root package.
- Take features strictly in list order. Run the feature's check, then the earlier checks in the same
  area, before calling it done (a slow full run takes about 3–5 minutes once implemented).

## Feature order (ids; module in parentheses)

1 eng-config-check (config) · 2 eng-pg-startup-auth · 3 eng-pg-simple-query · 4 eng-pg-extended-query ·
5 eng-pg-type-oids · 6 eng-pg-version · 7 eng-pg-session-settings · 8 eng-pg-transaction-statements ·
9 eng-pg-cursor-batches · 10 eng-pg-information-schema (pgwire) · 11 eng-promql-range · 12 eng-promql-instant ·
13 eng-time-arguments · 14 eng-promql-source-selection · 15 eng-promql-upstream-errors · 16 eng-label-function ·
17 eng-series-name-function · 18 eng-promql-pushdown-and-sql · 19 eng-max-rows-overflow (promql) ·
20 eng-pg-statement-timeout · 21 eng-pg-cancel-request · 22 eng-pg-disconnect-cleanup · 23 eng-pg-tls (pgwire) ·
24 eng-lightdash-session-compat (ops) · 25 eng-logql-streams · 26 eng-logql-metric · 27 eng-cloudwatch-metric-stat ·
28 eng-cloudwatch-expression · 29 eng-cloudwatch-role-assumption · 30 eng-cloudwatch-logs-insights ·
31 eng-cloudwatch-logs-failure-and-cancel · 32 eng-traceql-search · 33 eng-trace-by-id (sources) ·
34 eng-identity-restricted-denied (identity) · 35 eng-audit-dynamodb-item · 36 eng-audit-s3-object ·
37 eng-audit-integrity-hash · 38 eng-audit-fail-closed (audit) · 39 eng-identity-token-verification ·
40 eng-identity-per-session · 41 eng-identity-agent-and-system · 42 eng-audited-query-description-required ·
43 eng-restricted-loki-selectors · 44 eng-restricted-cloudwatch-log-groups (identity) · 45 eng-platform-query-basic ·
46 eng-platform-query-enforcement · 47 eng-platform-query-describe-only (platform) · 48 eng-guard-read-mode (guard) ·
49 eng-platform-read-only-role · 50 eng-platform-sql-over-results · 51 eng-platform-tables-columns ·
52 eng-platform-explain · 53 eng-platform-statement-timeout · 54 eng-platform-cancel-on-disconnect ·
55 eng-platform-max-rows · 56 eng-platform-pools (platform) · 57 eng-audit-failed-query-recorded ·
58 eng-audit-action-mapping (audit) · 59 eng-write-preview · 60 eng-write-preview-returning-cap ·
61 eng-write-commit · 62 eng-write-authorization · 63 eng-write-confirmation-single-use ·
64 eng-write-confirmation-binding · 65 eng-write-agent-commit-refused (write) · 66 eng-guard-write-mode (guard) ·
67 eng-write-statement-failure · 68 eng-write-audit-records · 69 eng-write-confirmations-verify-endpoint (write) ·
70 eng-audit-browser-by-month · 71 eng-audit-browser-by-ticket-and-user · 72 eng-audit-browser-authorization (audit) ·
73 eng-ops-marts-catalog · 74 eng-ops-marts-query · 75 eng-ops-marts-allowlist · 76 eng-ops-marts-workload-identity (ops_marts) ·
77 eng-healthz · 78 eng-metrics · 79 eng-graceful-shutdown · 80 eng-json-logs · 81 eng-perf-promql-large-range (ops) ·
82 eng-dockerfile · 83 eng-readme (docs)

Note: features 35–38 implement the audit writer on top of a Restricted Telemetry read. They need
token verification for a *valid* token, which feature 39 then hardens.

## Session log

- 2026-11-08 init: wrote the workspace skeleton, the protected harness and 83 acceptance tests,
  `init.sh` and this file. Proved `init.sh` exits 0 (about 1 s when nothing changed), the 3 harness
  self-tests pass, and all 83 checks fail on the stub, each running exactly one test.
- 2026-11-08T15:21:41Z supervisor: initialized: 83 features, run 20261108-093244
- 2026-11-08T15:46:00Z supervisor: initialized: 83 features, run 20261108-104127
- 2026-11-08 eng-config-check (session 1): new workspace member `federation-engine/crates/engine-config`
  (serde + toml 0.8) and a real `engine` CLI in `src/main.rs` (`--config <file>`, `--config=<file>`,
  `--check-config`). `Config::load` parses the file and validates it. It resolves every `*_env` name and
  collects **all** problems, one line each, before failing (exit 1; bad CLI args exit 2). It never binds a
  port or connects to anything. Secrets live in `Secret` (redacted `Debug`; `expose()` to read). Typed
  per-kind settings are in `SourceSettings`, and `Config::default_source(kind)` returns the `default = true`
  source, or a lone source of that kind. Tested as a user: ran `engine --check-config` on a full config
  (all 7 kinds, users, audit) and saw exit 0 with no secret echoed; then an unset env var, an unknown kind,
  a duplicate name, two defaults, a config with no `[audit]` and broken TOML, which each exit 1 naming the
  problem. Check `config::eng_config_check`, the 3 harness self-tests, the 6 crate unit tests, fmt and
  clippy (`--workspace --all-targets -D warnings`) all pass.
  Decisions for later sessions:
  - `deny_unknown_fields` on every table. A `[[sources]]` key that belongs to another kind (e.g. `region` on
    prometheus) is an error. **A new config key must be added to `RawConfig`/`RawSource` and to `kind_keys`.**
  - A `*_env` key that is present but names an unset or empty var fails. This includes `write_url_env`:
    Write Mode is off only when the key is *absent* (narrowest reading of "unset means Write Mode off").
  - Several sources of one kind with no `default = true` is allowed. `default_source` then returns `None`,
    so the table function must be given a source name.
  - Without `--check-config`, the binary still validates and then exits 2 ("serving is not implemented
    yet"). eng-pg-startup-auth replaces that branch with the server.
  - The private clippy/rustfmt toolchain is installed in `tmp/rustup` (the rustup "not installed at
    tmp/cargohome" message at the end of the install is harmless).
- 2026-11-08T15:51:24Z supervisor: eng-config-check passed the gate in round 1
- 2026-11-08 eng-pg-startup-auth (session 2): `engine --config <file>` now serves. New `src/server.rs`
  binds `listen_pg` and `listen_http` (bind failure → exit 1 naming the address) and runs the pg-wire
  accept loop plus an axum HTTP router. New `src/pg.rs`: pgwire 0.42 `SASLAuthStartupHandler` with
  **SCRAM-SHA-256** (4096 iterations; A1 allows any method) against `[[users]]`. Each user's salted
  password is computed once at startup with a random salt. An unknown user gets a random decoy secret,
  so it fails exactly like a wrong password (28P01, FATAL) and logins can't be enumerated. Queries run on
  one shared DataFusion 55 `SessionContext` via `sql_with_options` with DDL, DML and statements all
  refused (keeps the shared context read-only). Results are collected, then sent as text rows. Arrow
  → pg OIDs: bool 16, int2/4/8, float4/8, timestamptz 1184, timestamp, date, everything else text 25.
  Bool is sent as `t`/`f`. NULL comes from `logical_nulls()` (a `NullArray` has no validity buffer;
  `is_null` alone sent `SELECT NULL` as ''). DataFusion errors map to SQL→42601, Plan/Schema→42000,
  NotImplemented→0A000, else XX000.
  Tested as a user: psql is blocked by the sandbox, so I built a throwaway tokio-postgres CLI in
  `../tmp/pgclient` (outside the repo). I started the engine with two `[[users]]`. Each login ran
  `SELECT 1` → `1`. A wrong password, an unknown user and the other user's password each got
  `28P01` FATAL. `/healthz` → 200. Check `pgwire::eng_pg_startup_auth`, `config::eng_config_check`, the
  harness self-tests, 6 config + 2 new `pg` unit tests, fmt and clippy (`--workspace --all-targets
  -D warnings`) all pass.
  For later sessions:
  - `/healthz` is a stub (always 200 "ok"). It exists only because the harness waits on it.
    eng-healthz must add source probes and 503.
  - `[tls]` in the config makes the server refuse to start ("TLS is not implemented yet"). This fails
    closed instead of serving plaintext. eng-pg-tls replaces it (pgwire `process_socket` takes a
    `TlsAcceptor`; SCRAM channel binding needs `ScramAuth::configure_certificate`).
  - The extended protocol is pgwire's default Noop handler. `SET` and multi-statement simple queries
    are refused (statements disabled). `server_version` startup param is `16.0`; `version()` is not done.
  - Results are collected in memory before sending (no streaming, no max_rows cap, no cancellation yet).
  - pgwire's auth failure message reads `Password authentication failed for user ""` (empty name,
    pgwire's wording). Harmless, but a later session may want a custom message.
  - The first build compiles DataFusion (several minutes for clippy's separate target dir).
- 2026-11-08T16:08:29Z supervisor: eng-pg-startup-auth passed the gate in round 1
- 2026-11-08 eng-pg-simple-query (session 3): The simple query path from eng-pg-startup-auth already met
  every step (text rows, real NULL, EmptyQueryResponse from pgwire for `""`, ErrorResponse then
  ReadyForQuery so the session stays usable). The check passed before any change. One change in
  `src/pg.rs` `query_error`: DataFusion's "table '…' not found" planning error now maps to **42P01**
  (undefined_table, as Postgres does; eng-ops-marts-allowlist also expects 42P01) instead of 42000.
  DataFusion has no typed error for this, so the match is on the message text. The new unit test
  `query_errors_carry_postgres_sqlstates` runs real DataFusion queries, so a wording change on a
  DataFusion upgrade fails it. "table function '…' not found" is deliberately not matched.
  Tested as a user: I started `engine --config` with one `[[users]]` and used the throwaway tokio-postgres
  client in `../tmp/pgclient` (it now runs several queries on one session). Results:
  `SELECT 1 AS a, 'x' AS b, NULL AS c, 2.5 AS d` → columns a,b,c,d and row 1, x, NULL, 2.5. `""` →
  empty response. `SELECT * FROM no_such_table` → ERROR 42P01. `SELECT 3` → 3 on the same session.
  Check `pgwire::eng_pg_simple_query`, the earlier features' checks, harness self-tests, unit tests,
  fmt and clippy (`--workspace --all-targets -D warnings`) all pass.
  For later sessions:
  - Unaliased expressions get DataFusion's column names (`SELECT 3` → `Int64(3)`, not Postgres's
    `?column?`). No feature on this line asked for this, so I left it alone.
- 2026-11-08T16:11:11Z supervisor: eng-pg-simple-query passed the gate in round 1
- 2026-11-08 eng-pg-extended-query (session 4): The extended protocol (Parse/Describe/Bind/Execute) now
  runs on DataFusion. Before this it was pgwire's Noop handler. All changes are in `src/pg.rs`; the one
  new dependency is `postgres-types` 0.2.14 (already in Cargo.lock through pgwire; needed for `ToSql`).
  - `Sql` (owns the shared `SessionContext`) plans SQL once with `create_logical_plan` +
    `SQLOptions::verify_plan`, using the same read-only options as before. It is pgwire's `QueryParser`.
    `QueryHandler` serves both protocols.
  - Parse stores a `Prepared` (plan with placeholders, param Arrow types, described param pg types,
    result columns). Each `$n` gets the first type found in this order: the client-declared Parse type,
    DataFusion's own inference (`col = $1`), the target of a direct cast on the placeholder
    (`$1::bigint`, our own plan walk because DataFusion 55 doesn't infer it), else text. Only `$1..$n`
    ids are accepted (`$name` → 0A000). Client-declared types: bool, int2/4/8, float4/8, text-likes,
    timestamp(tz), date. Others get 0A000.
  - Bind: text params are cast from Utf8 to the param's Arrow type (cast failure → 22P02). Binary
    params are decoded by pg type, then cast (bad length → 22P03). NULL becomes a typed null. Then
    `plan.with_param_values`, and the statement is re-executed on each Execute.
  - Results: Describe statement reports text format (as Postgres does). Execute encodes each column in
    the format the Bind asked for. Binary columns are cast to the Arrow type of the *described* pg type
    first, so the bytes always match RowDescription. timestamp(tz) is sent as int8 µs since 2000-01-01,
    date as int4 days since 2000-01-01. Text output is unchanged (the shared `encode_rows` replaces
    `text_rows`).
  Tested as a user: I started `engine --config` (one `[[users]]`) and ran a throwaway tokio-postgres
  program `../tmp/pgclient/src/bin/ext.rs`. Results: prepare `SELECT $1::bigint + 1 AS n, $2::text AS t`
  → params [Int8, Text], columns n Int8, t Text. Executed twice → `42 / hi` and `-1 / again`.
  `prepare_typed(.., [INT8])` → ParameterDescription oid 20, row 42. Preparing against an unknown table
  → 42P01. After that, on the same session, a text + NULL bigint param query still worked.
  Check `pgwire::eng_pg_extended_query`, the three earlier checks, harness self-tests and the 6 `pg` unit tests (3 new)
  pass.
  For later sessions:
  - **rustfmt and clippy are not installed on this machine's toolchain now** (`cargo fmt`/`cargo clippy`
    say "not installed"). I kept rustfmt style by hand (lines ≤100). The next session that has them
    should run both.
  - `pgwire::eng_pg_type_oids` still fails at the OID assertion (`CAST(1.5 AS DOUBLE)` etc.). Binary
    encoding for float8/bool/timestamptz is already in place. That feature's own session owns this.
  - I did not try an untyped `SELECT $1` (no cast, no context). DataFusion probably can't type it at
    planning; Postgres would type it as text. Making DataFusion see declared/defaulted types needs a `PlannerContext` with
    `with_prepare_param_data_types`, which `SessionState` doesn't expose. Left for later if needed.
  - `max_rows` in Execute is honoured by pgwire's portal (PortalSuspended); results are still fully
    collected in memory first.
- 2026-11-08T16:26:55Z supervisor: eng-pg-extended-query passed the gate in round 1
- 2026-11-08 eng-pg-type-oids (session 5): `TIMESTAMP WITH TIME ZONE` columns now come out as
  timestamptz (OID 1184), and timestamps use Postgres text style. Only `src/pg.rs` and
  `Cargo.toml` changed (`chrono = "0.4"` moved into the normal deps; it was already in Cargo.lock).
  - Cause: DataFusion 55's `datafusion.execution.time_zone` defaults to `None`, so it planned
    `TIMESTAMP WITH TIME ZONE` as a zone-less `Timestamp(ns, None)` → OID 1114. `Sql::new()` now
    sets it to `SESSION_TIME_ZONE` = `"+00:00"` (this also puts `now()` in +00). The unit tests use
    `Sql::new()` too.
  - Text format: a timestamp(tz) column is cast to µs and printed by `timestamp_text`:
    `2026-01-02 03:04:05.25` / `...+00` / `...+05:30`. Fractional seconds have their trailing zeros
    trimmed and the offset is `+HH[:MM[:SS]]`, as Postgres prints them. Arrow's RFC 3339 formatter is
    still the fallback if chrono can't represent the value. `binary_source_type` is now
    `wire_source_type` and casts columns for both formats (casting to the same type is a no-op).
  - int8/float8/text/bool OIDs and their binary encoding were already right after session 4.
  Tested as a user: a throwaway tokio-postgres program `../tmp/pgclient/src/bin/oids.rs` spawns
  `target/debug/engine --config <toml>` as a child process and kills it at the end. (The sandbox
  refuses `engine &` from the shell.) prepare(the feature's SELECT) → OIDs 20/701/25/16/1184.
  Binary row → 7, 1.5, "x", true, unix 1767323045. Simple query → `7`, `1.5`, `x`, `t`,
  `2026-01-02 03:04:05+00`. `'...05.25'::timestamp` → `2026-01-02 03:04:05.25` (1114).
  `'...05.25+05:30'::timestamptz` → `2026-01-01 21:34:05.25+00` (1184). `now()` → 1184, `+00`.
  Check `pgwire::eng_pg_type_oids`, the four earlier checks, harness self-tests and the 7 `pg` unit
  tests (1 new) pass. rustfmt/clippy are still not installed; I kept the style by hand.
  For later sessions:
  - The time zone is set once on the shared `SessionContext`. eng-pg-session-settings (`SET timezone`)
    needs a per-connection zone. Either give each connection its own SessionContext/state, or keep
    UTC planning and pass the session zone to `timestamp_text` when encoding (the formatter already
    takes any arrow `Tz`, e.g. `America/New_York`).
  - BC dates are not printed in Postgres's `... BC` style (chrono prints a negative year).
- 2026-11-08T16:31:26Z supervisor: eng-pg-type-oids passed the gate in round 1
- 2026-11-08 eng-pg-version (session 6): `SELECT version()` now returns
  `PostgreSQL 16.0 (hrx-federation-engine 0.1.0)` (crate version from `CARGO_PKG_VERSION`) instead
  of DataFusion's built-in `Apache DataFusion ...`. Only `src/pg.rs` changed: a `VERSION_STRING`
  const, and a zero-argument immutable Utf8 UDF `version_udf()` that `Sql::new()` registers. It
  replaces DataFusion's built-in of the same name, because `register_udf` overwrites by name.
  One new unit test (8 `pg` tests now).
  Tested as a user: a throwaway tokio-postgres program `../tmp/pgclient/src/bin/ver.rs` (config
  `../tmp/ver.toml`) spawns `target/debug/engine`. Extended query → `PostgreSQL 16.0
  (hrx-federation-engine 0.1.0)`, simple query `SELECT version() AS version` → the same string,
  Lightdash's `/PostgreSQL (\d+)\./` → `16`. Check `pgwire::eng_pg_version`, the five earlier
  checks and the harness self-tests pass.
  For later sessions: `SERVER_VERSION` ("16.0", the startup parameter) and `VERSION_STRING` must
  agree. The unit test asserts that. `pg_catalog.version()` (qualified) is not handled; that belongs to
  the catalog features if they need it.
- 2026-11-08T16:33:59Z supervisor: eng-pg-version passed the gate in round 1
- 2026-11-08 eng-pg-session-settings (session 7): `SET`/`RESET` are per connection, and
  `current_setting(name)` reports the value. The new module is `src/session.rs`, wired in from `src/pg.rs`.
  `chrono-tz = "0.10"` became a direct dependency; it was already in Cargo.lock through arrow.
  - Settings live in the pgwire client's metadata under `hrx.setting:<lower-case name>`, so they
    belong to one connection and end with it. Statements are parsed with
    `state.sql_to_statement`. `Change::of` turns `SET [SESSION] x {=|TO} v`, `SET TIME ZONE v`,
    `SET x TO DEFAULT`, `RESET x` and `RESET ALL` into a change. `SET LOCAL`, `SET ROLE`, `SET NAMES` and
    `SET TRANSACTION` are accepted and do nothing. The command tag is `SET` or `RESET`. In the
    extended protocol, the change happens at Execute, and Describe answers ParameterDescription([]) + NoData.
  - Every name is stored as given (`statement_timeout`, `lightdash.agent`, `search_path`,
    `application_name`, unknown ones), so current_setting can read it back. Only `timezone` is
    validated. It must be an IANA name, matched case-insensitively and stored in canonical form
    (`utc` → `UTC`). Anything else gets 22023 `invalid value for parameter "TimeZone"`. Postgres's
    POSIX offsets such as `'+05:30'` are refused on purpose, because their sign is inverted. Defaults are
    `timezone` → `UTC` and `statement_timeout` → `0`. An unknown name in current_setting gets
    42704. Only the one-argument form exists; the `missing_ok` form does not.
  - `Sql::state_for(settings)` clones the shared state once per plan and once per execute. It
    registers a `current_setting` UDF that holds a snapshot of the settings. When a zone has been SET,
    it also sets `execution.time_zone` and rebuilds the state through `SessionStateBuilder`, so
    `now()` follows the zone. As a result, timestamptz columns are planned and printed in the
    session zone, as in Postgres (`...05+00'::timestamptz` → `2026-01-01 22:04:05-05` in
    America/New_York, and a literal with no offset is read as local time). OID 1184 is unchanged. The
    default zone is still `+00:00`. Execution now goes through `DataFrame::new(state, plan)`
    instead of `ctx.execute_logical_plan`.
  - `SqlStateError` (in session.rs) wrapped in `DataFusionError::External` lets any code return its
    own SQLSTATE. `query_error` unwraps it.
  Tested as a user: a throwaway tokio-postgres program `../tmp/pgclient/src/bin/sess.rs` (config
  `../tmp/ver.toml`) spawns `target/debug/engine`. Results: current_setting('TIMEZONE') → `UTC` in
  both the simple and extended protocols. The SETs for statement_timeout, lightdash.agent and
  timezone 'America/New_York' complete in both protocols. After them, the zone reads
  `America/New_York`, timestamps print `-05` (`-04` in July), `now()` prints `-05`, and
  `current_setting('statement_timeout')` reads `600000`. Extended `SET timezone TO 'Europe/Berlin'`
  → `Europe/Berlin`. A bad zone gives 22023. `SET some.unknown_setting` and `SET search_path TO public`
  are accepted. A second connection still sees `UTC` while the first keeps Berlin. `RESET timezone`
  goes back to `UTC`. The check `pgwire::eng_pg_session_settings`, the five earlier pgwire checks,
  config + harness self-tests and the 11 unit tests (3 new in session.rs) all pass.
  For later sessions:
  - eng-pg-statement-timeout: read `Settings::get("statement_timeout")`, which is the raw text
    (`540000`; Postgres also allows units such as `'5s'`). It is not validated yet.
  - The identity feature: `SET hrx.identity` is already accepted and stored under
    `hrx.setting:hrx.identity`. Read it with `Settings::get`. It does mean
    `current_setting('hrx.identity')` echoes the session's own token back to it. Decide whether to keep that or hide it.
  - Settings are snapshotted when a statement is planned. If a statement is prepared once and
    reused after a later `SET`, its current_setting value and zone come from Parse time.
  - Simple queries are still one statement each (`a; b` is refused by `sql_to_statement`).
    eng-pg-transaction-statements needs `BEGIN; ROLLBACK`, so it will have to split statements.
- 2026-11-08T16:41:36Z supervisor: eng-pg-session-settings passed the gate in round 1
- 2026-11-08 eng-pg-transaction-statements (session 8): BEGIN/START TRANSACTION, COMMIT/END and
  ROLLBACK are accepted in both protocols. Simple queries can hold several statements, and a named
  portal inside a transaction is fetched in max_rows batches.
  - New `src/transaction.rs`. `Transaction::of(statement)` recognises Begin/Commit/Rollback.
    Access and isolation modes (`READ ONLY`, `ISOLATION LEVEL ...`) are accepted and do nothing,
    because the engine is read-only and keeps no transaction state. `AND CHAIN`, savepoints
    (`SAVEPOINT`, `RELEASE`, `ROLLBACK TO`) and procedural `BEGIN ... END` blocks get 0A000. The
    statements answer pgwire's `Response::TransactionStart/End`, so pgwire tracks the ReadyForQuery
    status (I/T/E). `COMMIT` of a failed block answers `ROLLBACK`, as in Postgres.
  - A failed block works as in Postgres. Every statement except COMMIT/ROLLBACK gets 25P02
    ("current transaction is aborted..."). This is checked when a statement is planned
    (`check_not_aborted`, both protocols) and again at Execute (`Action::check_not_aborted`) for
    statements that were prepared before the failure.
  - pg.rs: `Action::Transaction` is new. `Sql::statements` splits a query string with
    `DFParserBuilder` using the configured dialect. `Sql::plan` (Parse) still needs exactly one
    statement; more than one gets 42601 "cannot insert multiple commands into a prepared statement".
    `Sql::plan_statement` plans a single statement. The simple `do_query` runs the statements in
    order. Each one sees the settings and transaction status the earlier ones left, and the
    first failure becomes `Response::Error` and stops the rest, so earlier results stand. A syntax
    error anywhere in the string fails the whole string before anything runs, as in Postgres.
    `session::sqlstate` is now `pub`.
  - Portals: pgwire 0.42's default `on_execute` already suspends and resumes portals by max_rows
    (PortalSuspended). `do_query` still collects the whole result before pgwire slices it, so
    nothing streams yet. If eng-pg-cursor-batches needs real streaming or bounded memory, that is
    where the work is.
  Tested as a user: a throwaway tokio-postgres program `../tmp/pgclient/src/bin/txn.rs` (config
  `../tmp/ver.toml`) spawns `target/debug/engine`. Simple protocol: BEGIN, SELECT 1 (row 1), COMMIT,
  `BEGIN; ROLLBACK` (two completes), START TRANSACTION READ ONLY, ROLLBACK and END are all accepted.
  `SELECT 1; SELECT 2` returns both rows. After an error inside BEGIN, both SELECT 1 and SET get
  25P02, COMMIT recovers, and SELECT 1 works again. COMMIT AND CHAIN and ROLLBACK TO SAVEPOINT get
  0A000. Extended protocol (`execute`): BEGIN/SELECT/COMMIT/START TRANSACTION READ ONLY/ROLLBACK
  all work, and `SELECT 1; SELECT 2` gets 42601. Portal: `transaction()`, then prepare
  generate_series(1, 250), bind, and query_portal(100) gives batches of 100 (1..100), 100
  (101..200) and 50 (201..250). Commit succeeds and the connection keeps working. The check
  `pgwire::eng_pg_transaction_statements`, the six earlier checks (config + 5 pgwire, plus
  session-settings), the harness self-tests and 15 unit tests (4 new in transaction.rs) all pass.
  For later sessions:
  - Postgres closes named portals at transaction end. Here, only pgwire's unnamed portal is dropped
    (extended COMMIT only). Named portals live until Close or the end of the connection.
  - `SET LOCAL` is still ignored rather than scoped to the block.
  - rustfmt and clippy are not installed on this machine, so formatting was done by hand.
- 2026-11-08T16:49:41Z supervisor: eng-pg-transaction-statements passed the gate in round 1
- 2026-11-08 eng-pg-cursor-batches (session 9): no engine code changed. The pg-cursor pattern
  already worked after eng-pg-transaction-statements: pgwire 0.42's default `on_execute` stores
  the `QueryResponse` in the portal and `Portal::fetch(max_rows)` pulls max_rows rows per Execute,
  sending PortalSuspended until the stream ends.
  - Decision: `do_query` (extended) still runs the plan to completion (`DataFrame::collect`) and
    encodes every row before pgwire slices it. It does not hand pgwire a lazy
    `execute_stream()`. The reason: pgwire only races `do_query` against the cancel receiver, so
    with a lazy stream the query would run inside `Portal::fetch`, outside the cancel select.
    eng-pg-cancel-request, statement_timeout (57014) and eng-platform-cancel-on-disconnect need
    execution to stay cancellable. Collecting also means errors arrive before any DataRow, and
    sources are bounded by max_rows (eng-max-rows-overflow). If bounded memory per portal is ever
    needed, the change goes in pg.rs `do_query` (stream `execute_stream()` through
    `encode_rows` per batch), and cancellation must then be wired into the row stream itself.
  - On the wire it matches Postgres. Each Execute(100) gets 100 DataRows plus PortalSuspended. The
    last batch gets `CommandComplete SELECT <rows in that batch>`. A result of exactly 100 rows
    gives 100 + PortalSuspended, then 0 rows + `SELECT 0`. A runtime error (1/0) gets
    ErrorResponse at the first Execute, and Sync gives ReadyForQuery I.
  Tested as a user: a throwaway raw-socket Python client `../tmp/rawcursor.py` (SCRAM login,
  config `../tmp/ver.toml`, engine `target/debug/engine` started by hand) sends Parse(unnamed),
  Bind C_1, Describe portal, Flush, then Execute(100)+Flush until done, then Sync. Results:
  ParseComplete, BindComplete, RowDescription n/oid 20; 1..100 + PortalSuspended, 101..200 +
  PortalSuspended, 201..250 + CommandComplete SELECT 50; Sync gives ReadyForQuery I. With
  generate_series(1, 100): 100 rows, then 0 rows + SELECT 0. With `$1::bigint` = '25' over 1..30:
  rows 26..30. The connection stays usable afterwards. The check `pgwire::eng_pg_cursor_batches`,
  the eight earlier checks, the 3 harness self-tests and 15 unit tests all pass.
- 2026-11-08T16:55:05Z supervisor: eng-pg-cursor-batches passed the gate in round 1
- 2026-11-08 eng-pg-information-schema (session 10): turned on DataFusion's information_schema
  (`SessionConfig::with_information_schema(true)` in pg.rs `Sql::new`), per CONTRACTS §1
  "Catalog". No pg_catalog is provided. Added the unit test `information_schema_lists_its_own_tables`.
  It enters a Tokio runtime because the information_schema scan spawns tasks: the `run` helper's
  futures executor alone panics with "no reactor running". Use the same approach for any future
  unit test that scans information_schema.
  - What clients see: information_schema.tables lists catalog `datafusion`, schema
    `information_schema`, with tables columns, df_settings, parameters, routines, schemata, tables
    and views, all of type VIEW. information_schema.columns does NOT list information_schema's own
    columns (DataFusion only lists registered tables), unlike Postgres. With no sources, getAllTables
    returns 0 rows. Real tables come with the source features (eng-ops-marts-catalog etc.).
  - getFields' `$1/$2` infer as text from `table_name = $1`, and every result column is text (OID 25).
  - Side effect: `SHOW ALL` and `SHOW <datafusion option>` now work. They are rewritten into a
    query on information_schema.df_settings, so verify_plan's allow_statements(false) does not
    refuse them. They expose DataFusion config only (no secrets). If a guard feature needs to hide
    them, refuse SHOW in `plan_statement` before planning.
  Tested as a user: a throwaway tokio-postgres program `../tmp/pgclient/src/bin/infoschema.rs`
  (config `../tmp/ver.toml`) spawns `target/debug/engine`. Lightdash's getAllTables query succeeds
  (0 rows, no sources). `WHERE table_schema = 'information_schema'` lists tables and columns, among
  others. Preparing getFields describes params [text, text] and 5 text columns. Running it with
  ('no_such_table', 'public') returns 0 rows and no error. The check
  `pgwire::eng_pg_information_schema`, the nine earlier checks, the 3 harness self-tests and
  16 unit tests all pass.
- 2026-11-08T17:02:32Z supervisor: eng-pg-information-schema passed the gate in round 1
- 2026-11-08T17:22:01Z supervisor: eng-promql-range halted: the worker halted on eng-promql-range
- 2026-11-08T17:22:56Z supervisor: eng-promql-instant halted: the worker halted on eng-promql-instant
- 2026-11-08T17:23:35Z supervisor: eng-time-arguments halted: the worker halted on eng-time-arguments
- 2026-11-08T17:24:24Z supervisor: eng-promql-source-selection halted: the worker halted on eng-promql-source-selection
- 2026-11-08T17:25:02Z supervisor: eng-promql-upstream-errors halted: the worker halted on eng-promql-upstream-errors
- 2026-11-08T17:25:40Z supervisor: eng-label-function halted: the worker halted on eng-label-function
- 2026-11-08T17:26:10Z supervisor: eng-series-name-function halted: the worker halted on eng-series-name-function
- 2026-11-08T17:27:39Z supervisor: eng-promql-pushdown-and-sql halted: the worker halted on eng-promql-pushdown-and-sql
- 2026-11-08T17:28:21Z supervisor: eng-max-rows-overflow halted: the worker halted on eng-max-rows-overflow
- 2026-11-08T17:29:05Z supervisor: eng-pg-statement-timeout halted: the worker halted on eng-pg-statement-timeout
- 2026-11-08T17:29:36Z supervisor: eng-pg-cancel-request halted: the worker halted on eng-pg-cancel-request
- 2026-11-08T17:30:10Z supervisor: eng-pg-disconnect-cleanup halted: the worker halted on eng-pg-disconnect-cleanup
- 2026-11-08T17:33:41Z supervisor: eng-pg-tls halted: worker engine.feature.eng-pg-tls.r1 stopped: STOP file present
- 2026-11-08 eng-promql-range (session 11, run 20261108-104127 round 1, after the harness date fix
  e3750c334): `promql(query, start, end, step[, source])` is a DataFusion table function in the new
  `src/promql.rs`. It is registered in `PgHandlers::new`, which now takes the whole `&Config`.
  - Arguments are constant-folded at plan time (`ExprSimplifier` with the session's config and
    query start time), so a bad argument fails before any request is sent. Times are cast to
    `Timestamp(µs, "+00:00")`, so ISO-8601 strings with offsets and fractions, timestamptz,
    naive timestamps (read as UTC), `to_timestamp(..)` and `now() - INTERVAL ..` all work. Step
    is a Prometheus duration (`30s`, `1h30m`, `500ms`) or plain seconds, and must be > 0.
    Errors: 22007 for a bad time, 22023 for a bad step, 22004 for NULL, 42883 for the wrong
    argument count, 0A000 for a non-constant argument (e.g. `$1`). Source: 42704 for an unknown
    name or no default, 42809 for a source of another kind. A `restricted = true` Prometheus
    source is refused with 42501 (fail closed) until the identity features check tokens.
  - The HTTP call happens in `TableProvider::scan`, so it runs at execution, not at
    Parse/Describe. It is `POST {url}/api/v1/query_range` with a form body
    (query unchanged, start/end/step as decimal Unix seconds). It is cancellable by dropping the
    future, the same as the rest of execution. Upstream errors name the source and pass on
    Prometheus's `errorType: error` text. Non-JSON answers say `HTTP <status>`. A connect failure
    says "is unreachable". These are all XX000 for now.
  - **json columns:** a Utf8 field with metadata `ARROW:extension:name = arrow.json`
    (`promql::EXTENSION_NAME_KEY`/`JSON_EXTENSION`) is described as `json` (OID 114) by pg.rs
    `columns_of`. Its text and binary forms are the same bytes. DataFusion keeps that metadata
    through `SELECT *` and plain column references (verified). An expression over the column
    (e.g. a CASE) probably loses it and is described as text (not tested). Use `promql::sample_schema()` for the other
    PromQL-shaped functions (promql_instant, logql_metric, cloudwatch).
  - `series` = `promql::series_name` (keys sorted, values Go-`strconv.Quote` escaped). `labels` is
    the metric object as compact JSON with sorted keys (serde_json's default map). Reuse both for
    eng-series-name-function / eng-label-function.
  - Text-format float8/float4 now prints Postgres's `NaN`, `Infinity`, `-Infinity`. Arrow
    printed `inf`, which node-postgres can't parse. Finite floats are unchanged (`1.0`, not
    Postgres's `1`; pre-existing, left alone).
  - **Dependencies:** `reqwest` 0.12 (features `json`, `rustls-tls-webpki-roots`), `rustls` 0.23 and
    `serde_json` are now normal dependencies. **Trap:** reqwest's features unify with the
    harness's dev-dependency reqwest. With the `-no-provider` TLS variant, the harness's own
    `reqwest::Client` panicked "No provider set" in every test. The ring-fallback variant avoids
    that. Because rustls then has both ring and aws-lc-rs, `main()` installs aws-lc-rs as the
    process default before the runtime starts. Any new rustls user in the engine relies on that.
    The harness builds its TLS configs with an explicit aws-lc-rs provider, so it is unaffected.
    The webpki root store is used rather than the OS keychain.
  - Housekeeping: rustfmt/clippy are installed in `tmp/rustup` (see the toolchain note) and now
    run clean. I applied `cargo fmt` to the drift earlier sessions left in pg.rs, session.rs and
    transaction.rs, and fixed one clippy lint (`dialect_from_str(options.dialect)`).
  Tested as a user: `../tmp/pgclient/src/bin/promql.rs` (an in-process mock Prometheus on
  127.0.0.1:59090; config `../tmp/promql/prom.toml`) spawns `target/debug/engine` and uses
  tokio-postgres with the feature's own SQL and 2026 dates. Prepare describes timestamp 1184,
  value 701, labels 114, series 25 and sends nothing to Prometheus. Execute returns 6 rows. In
  text form they are `2026-11-08 00:00:00+00 | 1.0 | {"__name__":...} | {__name__="http_requests_total",job="api",pod="api-1"}`,
  … `NaN` … `Infinity` …. Prometheus received
  `query=rate(http_requests_total{job="api"}[5m])` unchanged, with start=1794096000,
  end=1794099600 and step=30. `promql('up', ..)` against an empty matrix returns 0 rows.
  `'yesterday'` gets 22007. The check `promql::eng_promql_range`, the ten earlier checks, the
  3 harness self-tests and 27 unit tests (6 new in promql.rs) pass. fmt and clippy
  (`--workspace --all-targets -D warnings`) are clean.
  For later sessions: `promql::eng_time_arguments` and `promql::eng_promql_upstream_errors`
  already pass. `eng_promql_source_selection` fails only because `promql_instant` doesn't exist
  yet. max_rows (54000), statement_timeout and the `/healthz` source probes are not done.
- 2026-11-08T17:53:42Z supervisor: eng-promql-range passed the gate in round 1
- 2026-11-08 eng-promql-instant (worker, round 1): `promql_instant(query, at[, source])` runs
  Prometheus `POST {url}/api/v1/query` (form `query` unchanged, `time` as decimal Unix seconds)
  and returns the same four columns as `promql`.
  - `src/promql.rs`: `Promql` gained an `instant` flag (`Promql::new(..).instant()`); pg.rs
    registers both UDTFs from one `Promql` (cloned, sharing the reqwest client). Source
    selection, restricted fail-closed, constant/time/text argument checks and upstream error
    mapping are shared. Errors name the right signature. `RangeQuery` was renamed `PromqlQuery`;
    `matrix_batch` became `result_batch(source, data, instant)` with a small `Rows` builder.
    A range query still requires a matrix.
  - Instant result mapping: vector → one row per sample; scalar → one row, labels `{}`, series
    `{}`; string → one row, value NULL, labels `{}`, series = the string (contract assumption,
    encoded by the acceptance test; the timestamp is the string's own time); matrix (e.g.
    `up[5m]`) → one row per sample as in `promql`. Any other resultType is an XX000 error.
  Tested as a user: `../tmp/pgclient/src/bin/promql_instant.rs` (mock Prometheus on
  127.0.0.1:59090, config `../tmp/promql/prom.toml`) spawns `target/debug/engine` and runs the
  feature's SQL over tokio-postgres. Prepare describes 1184/701/114/25. `promql_instant('up',
  '2026-11-08T00:10:00Z')` returns 2 rows (`2026-11-08 00:10:00+00 | 3.0 | {"job":"api"} |
  {job="api"}`, and worker 0.25); Prometheus got `POST /api/v1/query` with `query=up&time=1794096600`.
  The scalar answer gave one row `42.0 | {} | {}`; the string answer gave one row `NULL | {} | hello`.
  `promql_instant('up')` gets 42883. The check `promql::eng_promql_instant` passes, as do the
  earlier passing checks, and `promql::eng_promql_source_selection` now passes too. Unit tests
  (1 new), `cargo fmt --check` and clippy `--workspace --all-targets -D warnings` are clean.
  Still failing (not built yet): pg tls/cancel/disconnect/statement_timeout, max_rows,
  pushdown_and_sql, label/series_name functions.
- 2026-11-08T18:01:07Z supervisor: eng-promql-instant passed the gate in round 1
- 2026-11-08 eng-time-arguments (worker, round 1): no code change needed. The time/step argument
  handling built in eng-promql-range (src/promql.rs) already satisfies the feature, as that entry
  predicted. I verified it end to end and added nothing to the tree except this entry.
  Tested as a user: `../tmp/pgclient/src/bin/timeargs.rs` (mock Prometheus on 127.0.0.1:59090,
  config `../tmp/promql/prom.toml`) spawns `target/debug/engine` and runs `promql('up', ..)` over
  tokio-postgres. Prometheus received: ISO Z strings → start=1794096000 end=1794099600 step=60;
  `+02:00` offset and `.500Z` → start=1794096000 end=1794097800.5 step=5400 (1h30m);
  CAST(.. AS TIMESTAMP WITH TIME ZONE) → end=1794117600 step=15; to_timestamp() → step=300 (5m);
  `now() - INTERVAL '1 hour', now()` → end within 1s of the wall clock, end-start=3600.
  Step 'abc' and '0s' get 22023 ("invalid step ..."), start 'yesterday' gets 22007; zero requests
  reached Prometheus for the three bad calls. The check `promql::eng_time_arguments` passes; in
  the promql module range/instant/source_selection/upstream_errors pass too, and
  series_name/label/pushdown_and_sql/max_rows still fail (not built yet).
  Minor, for later: the step error message doesn't prefix the function signature the way the
  start/end time errors do.
- 2026-11-08T18:02:57Z supervisor: eng-time-arguments passed the gate in round 1
- 2026-11-08 eng-promql-source-selection (worker, round 1): no code change needed. The shared source
  selection built in eng-promql-range/eng-promql-instant (src/promql.rs) already satisfies the
  feature, as both entries predicted. Only this entry was added to the tree.
  Tested as a user: `../tmp/pgclient/src/bin/sourcesel.rs` (mocks prom-a on 127.0.0.1:59091 with
  `default = true`, prom-b on :59092 listed first, Loki `only-loki` on :59093; config
  `../tmp/promql/sources.toml`) spawns `target/debug/engine` and runs SQL over tokio-postgres.
  `promql(.., '1m')` and `promql_instant(..)` without a source were answered by prom-a; with
  `'prom-b'` both were answered by prom-b. `'nope'` gets 42704 `source "nope" does not exist`
  (range and instant); `'only-loki'` gets 42809 `source "only-loki" is a loki source, not
  prometheus`. The Loki mock got no requests. The check `promql::eng_promql_source_selection`
  passes. In the promql module, range/instant/time_arguments/upstream_errors pass too;
  label/series_name/pushdown_and_sql/max_rows still fail (not built yet).
- 2026-11-08T18:04:59Z supervisor: eng-promql-source-selection passed the gate in round 1
- 2026-11-08 eng-promql-upstream-errors (worker, round 1): no code change needed. The upstream
  error mapping built in eng-promql-range (src/promql.rs) already satisfies the feature, as the
  eng-time-arguments and eng-promql-source-selection entries noted. Only this entry was added.
  Tested as a user: `../tmp/pgclient/src/bin/upstream.rs` (mock prom-a on 127.0.0.1:59094 as the
  default, prom-down on the dead port 127.0.0.1:1; config `../tmp/promql/upstream.toml`) spawns
  `target/debug/engine` and runs SQL over tokio-postgres. `promql('bad_query(', ..)` and
  `promql_instant('bad_query(', ..)` get XX000 `prometheus source "prom-a": HTTP 400: bad_data:
  parse error at char 11: unclosed left parenthesis`; 503 HTML gets `HTTP 503 with a response that
  is not Prometheus JSON`; `{not json` with HTTP 200 gets `HTTP 200 with a response that is not
  Prometheus JSON`; `'prom-down'` gets `prometheus source "prom-down" is unreachable: error
  sending request for url (...)` for both range and instant. The same session then ran a normal
  `promql('up', ..)` (1 row) and `SELECT 1`. The check `promql::eng_promql_upstream_errors` passes.
  Contract assumption: CONTRACTS.md sets no SQLSTATE for upstream failures, so they stay XX000
  with an "Execution error: " prefix from DataFusion. An integration line may want a specific
  class here (e.g. 58000/08xxx).
- 2026-11-08T18:06:56Z supervisor: eng-promql-upstream-errors passed the gate in round 1
- 2026-11-08 eng-label-function (worker, round 1): added `label(labels json, key text) -> text` as
  a DataFusion scalar UDF in the new module `federation-engine/src/labels.rs`, registered in
  `Sql::new` (src/pg.rs) next to `version()`. It reads like Postgres `labels ->> key`: NULL when
  either argument is NULL, the key is absent, the value is JSON null or labels is not an object;
  strings come back as is, other JSON values as their JSON text. Text that is not JSON fails with
  22P02 `invalid input syntax for type json: ...` (contract assumption: CONTRACTS only says "or
  NULL"; 22P02 is what Postgres gives for a bad json cast). Volatility Immutable; all-scalar
  calls return a scalar. One unit test in labels.rs.
  Tested as a user: `../tmp/pgclient/src/bin/labels.rs` (mock prom-a on 127.0.0.1:59096 with
  three series api-1/api-2/db-1, config `../tmp/promql/labels.toml`) spawns `target/debug/engine`
  and runs SQL over tokio-postgres. `label(labels,'pod')`, `'job'`, `'__name__'` gave each row's
  values; `'missing'` and `__name__` on series without it were NULL; `label(NULL,'a')` and
  `label('{}','a')` NULL, `label('{"a":"b"}','a')` = b; `WHERE label(labels,'job')='api' GROUP BY
  job, pod` gave api-1 3, api-2 2; GROUP BY job gave api 5, db 1; `label('{not json','a')` 22P02.
  The check `promql::eng_label_function` passes, and every feature in the passing list still
  passes. Note for eng-series-name-function: put `series_name_udf()` in src/labels.rs too, reusing
  `promql::series_name`. rustfmt/clippy are not installed on this toolchain, so formatting is by
  hand.
- 2026-11-08T18:12:43Z supervisor: eng-label-function passed the gate in round 1
- 2026-11-08 eng-series-name-function (worker, round 1): added `series_name(labels json) -> text`
  as a DataFusion scalar UDF (`series_name_udf()` in `federation-engine/src/labels.rs`), registered
  in `Sql::new` (src/pg.rs) next to `label`. It parses the labels JSON and calls the existing
  `promql::series_name`, so it is the same code path as the `series` column and cannot drift from
  it. NULL in gives NULL. JSON that is not an object gives NULL (contract assumption: CONTRACTS
  §1.1 doesn't say; this matches `label`). Text that is not JSON fails with 22P02, as `label` does.
  JSON parsing is shared via `parse()` in labels.rs. One more unit test in labels.rs.
  Tested as a user: `../tmp/pgclient/src/bin/seriesname.rs` (mock prom-a on 127.0.0.1:59097,
  config `../tmp/promql/seriesname.toml`, one series whose pod value has quotes, backslashes and a
  newline) spawns `target/debug/engine` and runs SQL over tokio-postgres.
  `series_name('{"b":"2","a":"1"}')` = `{a="1",b="2"}`; the quote/backslash/newline literal gave
  `{k="say \"hi\" \\ now\nplease"}`; `'{}'` gave `{}`; NULL and `'[1]'` gave NULL;
  `series_name(labels) = series` was true on all 6 promql rows (including the escaped one); `'{not
  json'` gave 22P02. The check `promql::eng_series_name_function` passes, and every feature in the
  passing list still passes.
- 2026-11-08T18:16:45Z supervisor: eng-series-name-function passed the gate in round 1
- 2026-11-08 eng-promql-pushdown-and-sql (worker, round 1): no code change was needed; the
  behaviour already holds after eng-promql-range + eng-label-function. `PromqlQuery` (src/promql.rs)
  keeps DataFusion's default `supports_filters_pushdown` = Unsupported and ignores `_filters`/`_limit`
  in `scan`, so WHERE/GROUP BY/JOIN always run in the engine. The query text is form-posted to
  /api/v1/query_range as-is, with one fetch per `promql(...)` call in a statement. Decision for
  later sessions: keep it that way. Never rewrite or append matchers to the native query. If a later
  feature adds pushdown (e.g. LIMIT), it must not change the `query` parameter.
  Tested as a user: `../tmp/pgclient/src/bin/pushdown.rs` (mock prom-a on 127.0.0.1:59098 with 4
  series pod api-0/api-1 x container c0..c3, config `../tmp/promql/pushdown.toml`) spawns
  `target/debug/engine` and runs SQL over tokio-postgres. The `sum by (pod, container) (rate(
  ...{namespace="web",pod=~"api-.*"}[5m]))` query with `WHERE "value" > 0.45 GROUP BY 1` gave
  api-0 5 / 1.4, api-1 10 / 1.9. The mock saw exactly one POST /api/v1/query_range whose
  form-decoded `query` equals the SQL string byte for byte. A JOIN against `VALUES
  ('api-0','blue'),('api-1','green')` on `label(a.labels,'pod')` at one timestamp gave 4 rows with
  the right team, and a LEFT JOIN + GROUP BY gave blue 10/7.0 and NULL 10/12.0, again with one
  upstream request each. The check `promql::eng_promql_pushdown_and_sql` passes, and every feature
  in the passing list still passes (full suite: 25 pass; the failures are all unbuilt/halted features).
- 2026-11-08T18:20:38Z supervisor: eng-promql-pushdown-and-sql passed the gate in round 1
- 2026-11-08 eng-max-rows-overflow (worker, round 1): `Promql` (src/promql.rs) now holds a row
  cap per source name (the source's `max_rows`, else the top-level `max_rows`, default 100000).
  `source()` returns it with the URL, `PromqlQuery` carries it, and `result_batch(.., max_rows)`
  builds rows via `Rows::new(source, max_rows)`. `Rows::push` fails with SQLSTATE 54000 "result
  exceeds max_rows (N) for source \"name\"" as soon as one row too many would be added, so an
  oversize answer is never built or truncated. Exactly max_rows is fine. The cap applies to what
  the source returns, not to the final SQL result, so `LIMIT 5` over an oversize source still
  fails. That is my reading of CONTRACTS §1.2 "Results are capped by max_rows in the source
  config". It applies to `promql` and `promql_instant` alike. One more unit test in promql.rs.
  Note for later source kinds (Loki, CloudWatch, Tempo, platform, BigQuery): apply the same
  per-source cap with the same 54000 message.
  Tested as a user: `../tmp/pgclient/src/bin/maxrows.rs` (mock on 127.0.0.1:59099 answering
  query=sixty/fifty with 2 series x 60/50 samples, config `../tmp/promql/maxrows.toml`: top-level
  max_rows = 100, prom-capped default, prom-roomy max_rows = 1000) spawns `target/debug/engine`
  and runs SQL over tokio-postgres. 'sixty' on the default source gave 54000 "result exceeds
  max_rows (100) for source \"prom-capped\"". 'fifty' gave count 100. 'sixty' on 'prom-roomy'
  gave 120. LIMIT 5 over 'sixty' still gave 54000, and so did promql_instant on the oversize
  answer. The check `promql::eng_max_rows_overflow` passes, and every feature in the passing list
  still passes (full suite: 26 pass, including eng_perf_promql_large_range; the failures are all
  unbuilt or halted features).
- 2026-11-08T18:27:15Z supervisor: eng-max-rows-overflow passed the gate in round 1
- 2026-11-08T18:35:23Z supervisor: eng-pg-statement-timeout halted: command engine.feature.eng-pg-statement-timeout.r1.rerun-eng-promql-upstream-errors stopped: STOP file present
- 2026-11-08 eng-pg-statement-timeout (worker, round 1 of the rerun after the STOP-file halt):
  `Sql::execute` (src/pg.rs) wraps `df.collect()` in `tokio::time::timeout` when the connection's
  `statement_timeout` is above 0. On expiry it fails with SQLSTATE 57014 "canceling statement due
  to statement timeout". Dropping the collect future also drops the in-flight reqwest call made
  in `PromqlQuery::scan`, so the source sees the connection close. Both protocols go through
  `execute`, so both are covered. The timer covers execution only, not planning. Planning does no
  source I/O today. If a later source does I/O at plan time, move the timeout up.
  - session.rs: `SET statement_timeout` is validated now. Allowed forms are integer ms, or a
    number with a unit (`us`, `ms`, `s`, `min`, `h`, `d`), with 0..=2147483647 ms after
    rounding, as Postgres allows. Anything else gets 22023 `invalid value for parameter
    "statement_timeout"`. The value is still stored raw, so `current_setting` echoes it
    (`600000`, `5s`). `Settings::statement_timeout()` returns `None` for 0 (no limit). One new
    unit test.
  - For eng-pg-cancel-request / eng-pg-disconnect-cleanup / eng-platform-statement-timeout:
    use the same drop-the-future approach. pgwire races `do_query` against the cancel receiver
    (see the eng-pg-cursor-batches note), and that drop is what abandons the source request.
    The platform feature may also want to forward the limit to Postgres; the engine-level
    timer already applies to every source.
  Tested as a user: `../tmp/pgclient/src/bin/timeout.rs` (mock on 127.0.0.1:59100, slow = 20 s
  and medium = 1.2 s, config `../tmp/promql/timeout.toml`) spawns `target/debug/engine` and uses
  tokio-postgres. With `SET statement_timeout = 500`, promql('slow') gave 57014 in 503 ms
  (extended) and 502 ms (simple), and the mock logged "engine dropped the request" after ~500 ms
  both times. SELECT 1 still worked afterwards. '1s' cut 'medium' at 1002 ms. 'soon' and -1 gave
  22023. With 0, and after RESET, 'medium' returned 1 row in 1203 ms in both protocols. The check
  `pgwire::eng_pg_statement_timeout` passes. All pgwire/promql/config/harness checks in the
  passing list still pass; the failures are the unbuilt tls/cancel/disconnect features.
- 2026-11-08T18:39:58Z supervisor: eng-pg-statement-timeout passed the gate in round 1
- 2026-11-08 eng-pg-cancel-request (worker, round 1): no new code paths, only wiring of what
  pgwire 0.42 already ships. `PgHandlers::new` (src/pg.rs) makes one shared
  `pgwire::api::ConnectionManager`. It hands it to the SASL startup handler
  (`with_connection_manager`), which registers each login under its BackendKeyData. The default
  generator gives pids 100000, 100001, ... in login order and a random i32 secret (protocol 3.0).
  `cancel_handler()` returns `DefaultCancelHandler` over the same manager. A matching
  CancelRequest fires the connection's oneshot. pgwire races that oneshot against `do_query` in
  both protocols, so the query future is dropped, the in-flight reqwest to the source is
  abandoned, and the client gets 57014 "canceling statement due to user request". A wrong pid or
  secret matches nothing and is silently ignored, as Postgres does. A cancel that arrives while
  idle does not leak into the next query, because `start_query` installs a fresh oneshot each time.
  - For eng-pg-disconnect-cleanup: cancel does not cover a hang-up. Dropping the connection
    task should drop `do_query` too, but check it against the source, especially mid-portal in
    the extended protocol.
  - For eng-pg-tls: pgwire handles a CancelRequest sent before or inside TLS, and the cancel
    handler is the same either way.
  Tested as a user: `../tmp/pgclient/src/bin/cancel.rs` (the timeout.rs mock on 59100 with
  query=slow = 20 s, config `../tmp/promql/timeout.toml`) spawns `target/debug/engine` and uses
  tokio-postgres. promql('slow') was cancelled 700 ms in with `CancelToken::cancel_query`: 57014
  within 1 ms of the cancel, in both the extended and simple protocols. Each time the mock logged
  "engine dropped the request" at the same moment, and SELECT 1 still worked on that session
  afterwards. Round 3 sent five raw CancelRequests with the right pid (100002) and wrong secrets,
  plus one with an unknown pid. After 1.5 s the query was still running and the mock still
  waiting. The right key then gave 57014 at once and the source request dropped. The check
  `pgwire::eng_pg_cancel_request` passes. The statement_timeout, startup_auth, extended_query
  and cursor_batches checks still pass.
- 2026-11-08T18:43:31Z supervisor: eng-pg-cancel-request passed the gate in round 1
- 2026-11-08 eng-pg-disconnect-cleanup (worker, round 1): the only change is in src/server.rs.
  pgwire 0.42's connection loop awaits `process_message` without reading the socket, so a
  hang-up went unnoticed until the slow query finished. Before this change the check failed at
  the simple-protocol step. Each accepted socket now goes through `serve_connection`. It makes a
  second tokio handle on the same socket (`into_std` + `try_clone` + `from_std`; no new crate)
  and `select!`s `process_socket` against `hung_up(&watcher)`. That function waits on READABLE
  readiness only and never reads. When the read side is closed (FIN or RST), the connection
  future is dropped. That drops `do_query` and the in-flight reqwest, the same drop path that
  cancel and statement_timeout use. Plain readable data just clears that handle's readiness
  (`try_io` returning WouldBlock) and waits for the next edge, so the watcher doesn't spin. The
  watcher is dropped when the connection ends, so the socket still closes then.
  - Decision: a half-close (client FIN while still reading) counts as a hang-up, as with Postgres'
    client_connection_check_interval (POLLRDHUP). A client that shuts down its write side and then
    waits for the result would lose the result. No known client does this.
  - For eng-pg-tls: the watcher sits on the raw TCP socket under any TLS, so it keeps working once
    a tls_acceptor is passed to `process_socket` in `serve_connection`. Keep that call there.
  - For eng-platform-cancel-on-disconnect: the engine side already stops the source work when the
    client goes away.
  Tested as a user: `../tmp/pgclient/src/bin/disconnect.rs` uses the cancel.rs mock on 59100
  (query=slow = 20 s) and config `../tmp/promql/timeout.toml`. It spawns `target/debug/engine`
  and uses tokio-postgres, aborting the connection task to drop the TCP connection without
  Terminate. Simple protocol: promql('slow') ran 700 ms, meanwhile a second session's SELECT 1
  worked, then the hang-up. The mock logged "engine dropped the request" at 727 ms. Extended: in
  a transaction, prepare, then bind a named portal, then query_portal(…, 100) (Execute on the named
  portal), then hang up at 703 ms. The mock dropped the request at 703 ms. A new connection's
  SELECT 1 then worked. The check `pgwire::eng_pg_disconnect_cleanup` passes. So do
  cancel_request, statement_timeout, cursor_batches, extended_query, simple_query, startup_auth,
  transaction_statements and session_settings.
- 2026-11-08 eng-pg-disconnect-cleanup (worker, round 2): the gate failed eng_pg_cancel_request,
  and the failure was random. A CancelRequest connection writes 16 bytes and then FINs straight
  away (the harness's `send_cancel`, psql too). The round-1 hang-up watcher saw read-closed and
  could drop `process_socket` before pgwire had read or handled the cancel (`select!` picks a
  ready branch at random), so the raw right-key cancel was sometimes lost. Fix in
  `serve_connection` (src/server.rs): after a hang-up, the connection future is driven for up to
  `HANGUP_GRACE` (250 ms) before it is dropped. A cancel or a Terminate finishes in that time on
  its own, and a slow query is dropped 250 ms after the hang-up.
  - Trap for later edits: never drop the connection the moment read-closed shows. Buffered
    messages sent just before the FIN must still be handled. That includes cancels, and TLS
    close_notify once eng-pg-tls lands.
  Tested as a user: `../tmp/pgclient` bins with args `<engine> ../promql/timeout.toml`.
  disconnect: a simple query hung up at 700 ms, and the mock saw the drop 988 ms after the
  request. A named-portal Execute hung up at 702 ms, drop at 954 ms. Meanwhile and afterwards
  SELECT 1 worked. cancel: right-key cancels (extended and simple) gave 57014 at once. Six
  wrong-key cancels did nothing, then the right key cancelled. Checks: cancel_request passed 6
  times in a row. disconnect_cleanup, statement_timeout, extended_query, simple_query,
  startup_auth and cursor_batches pass.
- 2026-11-08T18:51:52Z supervisor: eng-pg-disconnect-cleanup passed the gate in round 2
- 2026-11-08 eng-pg-tls (worker, round 1): `src/server.rs` replaces the "[tls] not implemented"
  refusal with `load_tls`. It reads `tls_cert_file` (a PEM chain) and `tls_key_file` (a PEM key)
  through rustls' own `pki_types::pem` (no new crate) and builds a rustls `ServerConfig` with
  aws-lc-rs and ALPN `postgresql`, for PG17 direct TLS. That becomes pgwire's `TlsAcceptor`, passed
  to `process_socket` inside `serve_connection`, so the hang-up watcher still sits on the raw
  socket. An unreadable or mismatched cert/key stops the engine at startup with a clear error,
  before anything is bound. It never falls back to plaintext. `PgHandlers::new(config, cert_pem)`
  calls `ScramAuth::configure_certificate`, so TLS clients get SCRAM-SHA-256-PLUS
  (tls-server-end-point). If pgwire can't hash the cert's signature (e.g. Ed25519), it logs a
  warning and offers plain SCRAM.
  - Decision (CONTRACTS §1 "TLS is optional"): with a certificate, plaintext logins
    (sslmode=disable) are still accepted. There is no "require TLS" switch. If one is wanted, add a
    config key later.
  - Trap: macOS `/usr/bin/openssl` is LibreSSL. `-newkey ec -pkeyopt ec_paramgen_curve:prime256v1`
    without `-pkeyopt ec_param_enc:named_curve` writes explicit curve parameters, and rustls then
    reports KeyMismatch. That is the cert's fault, not the engine's.
  - Tooling: rustfmt and clippy are not installed in this toolchain (`rustup component add` needed),
    so this change was hand-formatted to rustfmt style and checked by a warning-free build only.
  Tested as a user: `../tmp/tlsrun` has openssl certs (EC P-256, and RSA-2048/SHA-384) for
  127.0.0.1, plus three engines (TLS EC, TLS RSA, plain). A raw SSLRequest (`sslreq.py`) got `S`
  from both TLS engines and `N` from the plain one. `../tmp/pgclient` bin `tls` (tokio-postgres +
  rustls, verify against the cert) with sslmode=require ran `SELECT 'over tls'` → row on EC and
  RSA. With an unknown CA the TLS handshake fails. A wrong password over TLS gives a db error.
  sslmode=disable on the TLS engine works. On the plain engine, prefer and disable log in, and
  require fails. A missing cert file → exit 1 with "cannot read tls_cert_file …". Checks
  pgwire::eng_pg_tls, startup_auth, cancel_request, disconnect_cleanup and
  config::eng_config_check pass.
- 2026-11-08T18:56:41Z supervisor: eng-pg-tls passed the gate in round 1
- 2026-11-08 eng-lightdash-session-compat (worker, round 1): no code change was needed. The
  check passed on the untouched tree right after `init.sh`, because the features already built
  (session settings, cursor batches, type OIDs, version, information_schema, promql) together
  cover the whole Lightdash PostgresWarehouseClient session. `SET hrx.identity` is stored as a
  plain session setting for now. Verifying it and enforcing restricted sources belong to the
  eng-identity-* features, which haven't been built yet.
  Tested as a user: `../tmp/lightdash` has `mock.py` (a Prometheus mock with 5 pods × 50 points),
  `engine.toml` and `session.py` (raw pg-wire, logs in with SCRAM, uses the pg-cursor message
  pattern). The four SETs, sent one by one as simple queries, each returned `SET`. A 250-row
  promql cursor gave batches 100/100/50, OIDs 1184/701/114/25, labels `{"pod":"p0"}` as JSON
  text, and the first timestamp `2025-11-08 00:00:00+00`. current_setting('TIMEZONE') gave UTC,
  and version() gave `PostgreSQL 16.0 (hrx-federation-engine 0.1.0)`. The getFields query with
  $1/$2 ran without error, and a SELECT 1 afterwards worked.
  - Gaps against real Postgres (not needed by this feature; leave them to the integration line
    if Lightdash needs them): (1) getFields for information_schema.tables returns 0 rows,
    because information_schema.columns doesn't describe information_schema itself. (2) The
    version() column is named `version()`, where Postgres says `version`. (3) float8 text output
    is `0.0`, where Postgres says `0`.
- 2026-11-08T18:58:36Z supervisor: eng-lightdash-session-compat passed the gate in round 1
- 2026-11-08 eng-logql-streams (worker, round 1): new `src/logql.rs` registers the
  `logql(query, start, end[, limit, direction, source])` table function (pg.rs). It returns
  `timestamp timestamptz, line text, labels json, stream text`. Arguments are constants checked
  at plan time: limit must be a positive integer (default 1000; 0, a negative number or NULL →
  22023/22004) and direction is forward|backward in any case, sent in lower case (default
  backward). Bad arguments never reach Loki. At scan time it POSTs a form to
  `<url>/loki/api/v1/query_range` with the query unchanged, start/end as Unix-nanosecond integers,
  and limit and direction. Each `streams` entry becomes one row. ns timestamps are truncated to µs.
  `stream` is `series_name(labels)`, and a third entry element (structured metadata) is ignored.
  max_rows → 54000 as for promql. A `matrix`/`vector` answer fails with 42809 and points to
  logql_metric. Loki error bodies are plain text, so a non-JSON non-2xx body is quoted (first 500
  chars) in the SQL error. The JSON `error`/`message` field is used when there is one.
  - Refactor: source resolution moved out of `Promql` into `src/sources.rs` (`HttpSources::new(config,
    kind)` / `resolve(name)` → `HttpSource {name, url, max_rows}`). promql's messages are unchanged
    ("there is no default prometheus source…", 42809 kind mismatch, 42704 unknown). The helpers
    `constant`, `text_argument`, `time_argument` and `UTC` in promql.rs are now `pub(crate)` for reuse.
    logql_metric (next feature) can reuse `HttpSources(Loki)` plus promql's `result_batch`.
  - Contract assumption (fail closed): a Loki source with non-empty `restricted_selectors` (or
    `restricted = true`) refuses every logql call with 42501 for now, as restricted prometheus
    sources do. eng-restricted-loki-selectors must replace this with the disjoint-selector check
    and identity verification (see `is_restricted` in sources.rs).
  Tested as a user: `../tmp/logql/run.sh` starts a Python Loki mock (`mock.py`, logs each form) and
  the real engine (`engine.toml`, source loki-a), then runs queries through tokio-postgres
  (`../tmp/pgclient` bin `sql`; psql is not permitted in the sandbox). The step-2 query gave 3
  rows: `2025-11-08 00:00:00.123456+00 | boom 1 | {"app":"api","level":"error"} |
  {app="api",level="error"}`, …, `careful` with level warn. Loki got the query byte-for-byte with
  limit=1000 and direction=backward. `50, 'forward'` was sent as limit=50 and direction=forward.
  count(*) WHERE label(labels,'level')='error' = 2. limit 0, direction 'sideways', source 'nope'
  and a one-argument call each failed (22023/22023/42704/42883) with no request to Loki. Checks
  sources::eng_logql_streams, promql::eng_promql_source_selection and promql::eng_max_rows_overflow
  pass, and so do the logql/promql unit tests.
- 2026-11-08T19:03:51Z supervisor: eng-logql-streams passed the gate in round 1
- 2026-11-08 eng-logql-metric (worker, round 1): `logql_metric(query, start, end, step[, source])`
  is `Logql::new(..).metric()` in `src/logql.rs` (the same pattern as `Promql::instant`) and is
  registered in pg.rs. It returns the promql columns (`sample_schema`). At plan time it takes 4 or
  5 constant arguments (else 42883), and step goes through promql's `parse_duration` (a bad step →
  22023 with no request). At scan time it POSTs `query` unchanged to
  `<url>/loki/api/v1/query_range`, with start/end as Unix-ns integers and `step` as decimal seconds
  (`1m` → `60`). It sends no limit or direction. The matrix becomes rows through promql's
  `result_batch`, which is now `pub(crate)` and takes a `kind` label for its messages
  ("loki source …" / "prometheus source …"; the promql messages are unchanged). `seconds_text` is
  `pub(crate)` too. A `streams` answer (a log query given to logql_metric) fails with 42809 and
  points to logql. max_rows → 54000, and the restricted-source fail-closed rule (42501) is the
  same as for logql (shared `HttpSources::resolve`).
  Tested as a user: `../tmp/logql_metric/run.sh` (a Python Loki mock on 59202 that answers a matrix
  when the query contains `over_time` and streams otherwise, plus the real engine on 55541, driven
  by `../tmp/pgclient` bin `sql`). The step-1 query gave 3 rows with timestamp/value/labels/series
  (`{app="api"}` 3.0 at 00:00 and 5.0 at 00:01, `{app="web"}` 1.0). GROUP BY label(labels,'app')
  summed api=8, web=1. Loki received the query byte-for-byte with step=60 (and `'90s'` → 90). A log
  query gave 42809 "use logql", step '0s' gave 22023, source 'nope' gave 42704 and 3 arguments gave
  42883. logql() still sends limit/direction. Checks sources::eng_logql_metric, eng_logql_streams,
  promql::eng_promql_range, eng_promql_instant and eng_max_rows_overflow pass, and so do the
  logql/promql unit tests. rustfmt is not installed on this machine, so `cargo fmt` was not run.
- 2026-11-08T19:07:59Z supervisor: eng-logql-metric passed the gate in round 1
- 2026-11-08 eng-cloudwatch-metric-stat (worker, round 1): `cloudwatch(metric_data_query, start,
  end[, source])` is `Cloudwatch` in the new `src/cloudwatch.rs`, registered in pg.rs. It returns
  the promql columns (`sample_schema`). New deps: `aws-config` 1.13 and `aws-sdk-cloudwatch` 1.140
  with `default-features = false` (features behavior-version-latest, default-https-client,
  rt-tokio, plus credentials-process for aws-config; no sso). That keeps one rustls (0.23) in the
  lockfile, so the legacy hyper 0.14/rustls 0.21 stack stays out. The first build of the SDK takes
  about 5 min with CARGO_BUILD_JOBS=2.
  - Plan time: 3 or 4 constant arguments (else 42883), end > start (22023), source picked by the new
    `HttpSources::pick` (name + max_rows for any kind; `resolve` now wraps it and adds the URL, so
    the promql/logql messages are unchanged). The Grafana target is parsed (A19) into a `Target`:
    `id` if it matches `^[a-z][a-zA-Z0-9_]*$`, else `query<refId>` (Grafana's own rule), else
    `query`. Dimensions are a string or a one-element array. `statistic` (or a one-element
    `statistics`). `period` as "300", 300 or "5m"; "auto"/empty/missing uses Grafana's auto rule
    (≤2000 datapoints, retention-tiered periods). Non-empty `label` becomes the AWS Label and the
    series of every row, otherwise series = each result's Label. `region` other than
    "default"/empty overrides the source's region for that call. Bad JSON → 22P02. A missing
    namespace, metricName or statistic → 22023.
  - Scan time: one SDK client per source, built on first use (`tokio::sync::OnceCell`) from
    `aws_config::defaults` with the source's region, a 10 s connect timeout and the source's
    `endpoint_url`. GetMetricData uses ScanBy TimestampAscending and follows NextToken until there
    is none. A Forbidden/InternalError result status is an error, and so is a timestamps/values
    length mismatch. More than max_rows datapoints in all → 54000. `labels` = the dimensions plus
    namespace, metric_name, statistic, label (A19 leaves the content open).
  - Left for the next features (fail closed, clear errors, no request sent): an expression target
    (`metricEditorMode = 1` or a non-empty `expression`) → 0A000 "not supported yet". That is
    eng-cloudwatch-expression. A source with `role_arn` → 0A000 at plan time (sign with an
    AssumeRoleProvider from aws-config's `sts` module, `sts_endpoint_url` as the STS endpoint),
    which is eng-cloudwatch-role-assumption. Multi-value or `*` dimensions and `matchExact = false`
    → 0A000 (Grafana's SEARCH translation, untested per A19).
  Tested as a user: `../tmp/cloudwatch/run.sh` starts a Python CloudWatch mock (`mock.py`, with a
  small CBOR codec because the SDK speaks Smithy RPC v2 CBOR, logs every decoded request) and the
  real engine with a cleared env (fake AWS env credentials, AWS_REGION=eu-west-1, a dead
  AWS_ENDPOINT_URL), then queries through `../tmp/pgclient` bin `sql` (port 55541 is hard-coded
  there). The test's Grafana target gave 3 rows ordered by time (10.5, 20.0, 30.25 at 00:00/00:05/00:10)
  with series cpu-db-1. The mock saw two GetMetricData calls (the second with NextToken page-2)
  carrying MetricStat AWS/RDS/CPUUtilization, both dimensions, Period 300, Stat Average, Id queryA,
  Label cpu-db-1 and the hour's Start/EndTime. The credential scope was
  `<env key>/…/us-east-2/monitoring`, so the source region won over AWS_REGION. With an empty label,
  the series was the result label CPUUtilization. An expression target gave 0A000, bad JSON 22P02,
  a prometheus source 42809, an unknown source 42704 and 2 arguments 42883, each with no request.
  Checks sources::eng_cloudwatch_metric_stat, eng_logql_metric, eng_logql_streams,
  promql::eng_promql_source_selection and eng_max_rows_overflow pass, and so do the 5 cloudwatch
  unit tests. clippy and rustfmt are not installed here; I formatted by hand (lines ≤ 100).
- 2026-11-08T19:33:11Z supervisor: eng-cloudwatch-metric-stat passed the gate in round 1
- eng-cloudwatch-expression (worker, round 1): `src/cloudwatch.rs` only. `Target` now holds a
  `TargetMetric`: `Stat { namespace, metric_name, dimensions, statistic }` (builder mode, as before)
  or `Expression(String)` (code mode: `metricEditorMode = 1` or a non-empty `expression`, per A19).
  An expression is sent whole as `MetricDataQuery.Expression` with `Period` (the target's period,
  same parsing/auto rule as metric stat; Grafana sets Period in its math-expression mode too) and
  no `MetricStat`. Without a Grafana `label`, `series` is each result's Label, so a SEARCH gives one
  series per matched metric. `labels` for an expression row = `{"expression", "label"}`. Builder-only
  checks (namespace/metricName/statistic required, dimension shapes, `matchExact = false` → 0A000)
  moved to `Target::metric_stat` and no longer apply to code mode.
  - Decisions: code mode with an empty expression → 22023. `metricQueryType = 1` (Metrics Insights,
    Grafana sends `sqlExpression`) → 0A000 "not supported yet"; no feature in the list covers it,
    so it fails closed rather than sending the wrong field. Previously it was ignored.
  Tested as a user: `../tmp/cloudwatch/run.sh` (mock now answers an Expression query with two
  results, i-aaa ×2 and i-bbb ×1). The step's target (refId B, metricEditorMode 1, the SEARCH
  expression) gave series i-aaa n=2, i-bbb n=1; the mock saw Id queryB, the Expression byte-for-byte,
  Period 300, ReturnData true and no MetricStat/Label. Metric-stat queries and the error cases
  (22P02, 42809, 42704, 42883) behave as before. Checks sources::eng_cloudwatch_expression and
  sources::eng_cloudwatch_metric_stat pass; 6 cloudwatch unit tests pass; no build warnings.
- 2026-11-08T19:37:27Z supervisor: eng-cloudwatch-expression passed the gate in round 1
- eng-cloudwatch-role-assumption (worker, round 1): `src/cloudwatch.rs`, plus `aws-types = "1.7"`
  in Cargo.toml (already in Cargo.lock through aws-config). The plan-time 0A000 for `role_arn` is
  gone. When a source has `role_arn`, the lazily built CloudWatch client gets
  `aws_config::sts::AssumeRoleProvider` (session name `federation-engine`) as its credentials
  provider. The provider is configured from the same `SdkConfig` (default chain, source region,
  connect timeout), so STS is signed with the base credentials. The client's identity cache keeps
  the temporary credentials and refreshes them before they expire.
  - Trap: `sts_endpoint_url` set through `SdkConfigBuilder::set_endpoint_url` alone loses to the
    env's `AWS_ENDPOINT_URL`/`AWS_ENDPOINT_URL_STS`. The generated STS `Builder::from(&SdkConfig)`
    uses the SdkConfig endpoint only when its origin is programmatic, so the code also calls
    `insert_origin("endpoint_url", Origin::shared_config())`. That is why `aws-types` is now a
    direct dependency. The cloudwatch_logs role feature can reuse `assume_role` (move it to a
    shared module when that feature lands).
  Tested as a user: `../tmp/cloudwatch/run-role.sh` (mock.py now also answers STS AssumeRole in the
  query protocol with fixed fake credentials and logs each request's access key and session token;
  engine-role.toml adds role_arn and sts_endpoint_url to cw-a). Two cloudwatch() queries gave 3 rows
  (10.5, 20.0, 30.25), then count 3. The mock saw one AssumeRole with the configured RoleArn and
  RoleSessionName federation-engine, scoped `<env key>/…/us-east-2/sts`, with no token. It saw four
  GetMetricData calls (2 queries × 2 pages), each scoped `<assumed key>/…/us-east-2/monitoring` and
  carrying the assumed session token. AWS_ENDPOINT_URL pointed at a dead port the whole time.
  Checks sources::eng_cloudwatch_role_assumption, eng_cloudwatch_metric_stat and
  eng_cloudwatch_expression pass; 6 cloudwatch unit tests pass; no build warnings.
- 2026-11-08T19:42:24Z supervisor: eng-cloudwatch-role-assumption passed the gate in round 1
- eng-cloudwatch-logs-insights (worker, round 1): new `src/cloudwatch_logs.rs`, new `src/aws.rs`,
  wiring in `main.rs`/`pg.rs`, `sources.rs`, and `aws-sdk-cloudwatchlogs = "1.163"` in Cargo.toml
  (it was in the local cargo cache, so it builds `--offline`; Cargo.lock gains its entries).
  `cloudwatch_logs(log_groups, query, start, end[, source])` returns `timestamp timestamptz NULL,
  message text NULL, fields json`. log_groups is split on `,`, trimmed, empties dropped (none left →
  22023). The query goes to StartQuery unchanged; times are epoch seconds (start rounded down, end
  up). GetQueryResults is polled right away and then every `poll_interval_ms` while Scheduled or
  Running. On Complete each result becomes a row: `@timestamp` read as UTC
  (`%Y-%m-%d %H:%M:%S%.f`, RFC 3339 also accepted; unparseable or missing → NULL), `@message`
  (missing → NULL), and `fields` = every field except `@ptr`, values as strings, @timestamp and
  @message included (A20). Any other final status → an error "... ended with status <S>". More
  than max_rows results → 54000.
  - `aws::shared_config` and `aws::assume_role` moved out of cloudwatch.rs, as the role feature's
    note asked. Both AWS sources build their SDK client the same way (default chain, region,
    endpoint_url, role_arn through STS).
  - Contract assumption (fail closed): a cloudwatch_logs source with non-empty
    `restricted_log_groups` is treated as restricted (42501) for every query, like Loki's
    `restricted_selectors`. eng-restricted-cloudwatch-log-groups narrows this to overlapping groups.
  - Not done, belongs to eng-cloudwatch-logs-failure-and-cancel: StopQuery on timeout or cancel.
    Today, dropping the scan future only stops polling. The Failed-status error is already in place.
  - Trap: the engine has no `->>` operator yet (0A000). Use `label(fields, 'level')` to read a field.
  Tested as a user: `../tmp/cloudwatch-logs/run.sh` starts a JSON-1.1 Logs Insights mock (Running,
  Running, Complete) and the engine with fake env credentials (AWS_ENDPOINT_URL set to a dead port),
  then runs queries through pg-wire. The feature's step query returned 2 rows: 00:00:01.25+00 "first
  event" {"@message","@timestamp","level":"error"} with no @ptr, then 00:00:02+00 "second event". The
  mock saw StartQuery with logGroupNames ["/aws/lambda/a","/aws/lambda/b"], the query byte-for-byte,
  startTime 1762560000 and endTime 1762563600, then 3 GetQueryResults, all signed with the env key
  scoped us-east-2/logs. `WHERE label(fields,'level')='error'` gave 1 row. Errors: ' , ' → 22023,
  a cloudwatch source → 42809, end before start → 22023. Check sources::eng_cloudwatch_logs_insights
  passes. Re-ran eng_cloudwatch_metric_stat, eng_cloudwatch_expression and
  eng_cloudwatch_role_assumption: all pass. 9 cloudwatch unit tests pass. No build warnings. rustfmt
  isn't installed, so the code is formatted by hand.
- 2026-11-08T19:52:28Z supervisor: eng-cloudwatch-logs-insights passed the gate in round 1
