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
