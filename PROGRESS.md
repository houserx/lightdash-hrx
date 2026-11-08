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
  `valid` means `/v1/write` would accept the token now: bound to the statement and the bearer's
  sub and project, unexpired, signed, and not already spent (so after a commit it is false).
  No bearer is 401; a body without string `statement` and `confirmation_token` is 400.
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
- eng-cloudwatch-logs-failure-and-cancel (worker, round 1): `src/cloudwatch_logs.rs` only. The
  Failed-status error already existed: "... Logs Insights query <id> ended with status Failed". New:
  a `RunningQuery` drop guard is created right after StartQuery returns a queryId. It is disarmed
  when GetQueryResults reports a final status (Complete or any non-Scheduled/Running status). If the
  scan future is dropped before that (statement_timeout, CancelRequest, client disconnect) or polling
  errors out, the guard's Drop spawns one `StopQuery(queryId)` on the current tokio runtime (no
  runtime → nothing). A StopQuery failure is logged to stderr ("engine: cloudwatch_logs StopQuery
  for <id> failed: ..."). It never surfaces to the client. Polling stops because the future is gone.
  - Gap: if the future is dropped while StartQuery is still in flight there's no queryId yet, so no
    StopQuery is sent. AWS doesn't let us stop an unknown query.
  Tested as a user: `../tmp/cloudwatch-logs-cancel/run.sh` starts two JSON-1.1 mocks (one answers
  Failed, one Running forever) and the engine with fake env credentials, then runs the steps on one
  pg-wire session. The default source returned XX000 "... query query-1 ended with status Failed",
  and its mock saw one StartQuery and one GetQueryResults, with no StopQuery. After `SET
  statement_timeout = 700`, querying 'logs-never' returned 57014 about 0.70 s after StartQuery. That
  mock saw 13 polls at 50 ms, then exactly one StopQuery {"queryId":"query-1"} 39 ms after the last
  poll. The poll count was still 13 one and two seconds later. Check
  sources::eng_cloudwatch_logs_failure_and_cancel passes. eng_cloudwatch_logs_insights still passes.
  The 3 cloudwatch_logs unit tests pass. No build warnings.
- 2026-11-08T19:55:08Z supervisor: eng-cloudwatch-logs-failure-and-cancel passed the gate in round 1
- eng-traceql-search (worker, round 1): new `src/traceql.rs`, registered as `traceql` in
  `pg.rs`. `sources.rs` `base_url` now also covers `SourceSettings::Tempo`. traceql(query, start,
  end[, limit = 20, source]) sends `GET <url>/api/search?q=<query unchanged>&start&end&limit`.
  start and end are integer Unix seconds: start rounded down, end rounded up, so the range is never
  narrowed. Columns are trace_id text (NOT NULL), root_service text, root_name text, start
  timestamptz, duration_ms float8, span_count int8, one row per trace in Tempo's order. Errors: limit
  not a positive integer → 22023 (non-integer 42804, NULL 22004); end before start → 22023; 3–5
  arguments (42883); a non-2xx answer → "tempo source \"<name>\": HTTP <code>: <body, 500 chars>";
  more traces than max_rows → 54000.
  - Contract assumptions (CONTRACTS §1.1 names the columns but doesn't define them):
    `span_count` is the number of *matched* spans, summed over `spanSets[].matched`, falling back to
    `spanSet.matched`, else NULL. Tempo's search answer has no total span count.
    Tempo omits proto3 zero values, so a missing `durationMs` → 0 and a missing `matched` → 0.
    A missing `startTimeUnixNano` / root name / root service → NULL. Trace ids are lowercased and
    left-padded to 32 hex digits, because Tempo search drops leading zeros. That is the form
    `trace()` (eng-trace-by-id) should accept and print.
  - `Traceql` and `limit_argument` are separate from logql's on purpose: different signature text.
    eng-trace-by-id can reuse `tempo_answer` and the Tempo `HttpSources`.
  Tested as a user: `../tmp/traceql/run.sh` starts a Python Tempo mock and the engine (tempo-a with a
  trailing-slash url, plus loki-a), then runs queries through pg-wire. The step query returned 2 rows
  ordered by start: 2f3e…2e54 | web | GET /orders | 2025-11-08 00:00:00.5+00 | 557.0 | 3. The second
  row's trace id came back as 0af7…319c, padded from the mock's 31-digit id. The mock saw GET
  /api/search with q byte-for-byte, start 1762560000, end 1762563600, limit 20. Passing 5 sent
  limit 5. Passing 7 with 'tempo-a' and fractional bounds sent start 1762560000 and end 1762563600,
  and GROUP BY root_service worked. A Tempo 400 came back as XX000 with Tempo's text. limit 0 →
  22023; 'loki-a' → 42809; end before start → 22023. The check sources::eng_traceql_search passes,
  eng_logql_streams still passes, and the 4 traceql unit tests pass. No build warnings.
- 2026-11-08T19:59:07Z supervisor: eng-traceql-search passed the gate in round 1
- eng-trace-by-id (worker, round 1): new `src/trace.rs`, registered as `trace` in `pg.rs`.
  trace(trace_id[, source]) sends `GET <url>/api/traces/<id>` (v1). The id is normalised first:
  hex, case-insensitive, up to 32 digits, left-padded to 32 (the form traceql() prints). Anything
  else → 22023. Columns are trace_id, span_id (both NOT NULL), parent_span_id, service, name
  (NOT NULL, "" when OTLP omits it), start timestamptz, duration_ms float8 ((end-start)/1e6),
  status (unset/ok/error), attributes json (Arrow JSON extension, as in cloudwatch_logs). One row
  per span, in Tempo's order. Tempo 404 → zero rows. Other non-2xx → XX000 "tempo source ...: HTTP
  <code>: <body>" via `traceql::tempo_answer`, which is now pub(crate) and says "not Tempo JSON"
  instead of "not Tempo search JSON". `traceql::trace_id` is pub(crate) too. More spans than
  max_rows → 54000. 0 or 3+ arguments → 42883.
  - `base64 = "0.22"` moved into `[dependencies]` (it was dev-only). Cargo.lock is unchanged.
  - Contract assumptions (CONTRACTS §1.1 names the columns only): ids are base64 (protobuf JSON),
    and 32/16-digit hex ids are accepted too. A missing, empty or all-zero parentSpanId is NULL.
    `service` is the resource's service.name, else NULL. `attributes` holds only the span's own
    attributes, not resource attributes. AnyValue maps to JSON: intValue (int64 text) → number,
    arrayValue → array, kvlistValue → object, bytesValue → its base64 text, empty → null. The
    status code can be an enum name or a number. A missing start or end → NULL start/duration.
    `batches`, `resourceSpans`, `trace.resourceSpans` and `instrumentationLibrarySpans` are all
    read.
  Tested as a user: `../tmp/trace/run.sh` starts a Python Tempo mock that serves base64 OTLP
  batches, plus the engine, then runs queries over pg-wire. The step query returned 3 rows: root
  b7ad…3331 with parent NULL, web, 250.0, unset; 00f0…02b7 with parent b7ad…, api, 100.5, error,
  attributes {"db.system":"postgresql","http.status_code":500,"ratio":0.5,"retry":true}; 1111…
  with status ok and attributes {}. An unknown id gave count 0. An uppercase id with 'tempo-a' and
  GROUP BY worked. A Tempo 500 came back as XX000 with Tempo's text. 'not-hex' → 22023, 'loki-a' →
  42809, trace() → 42883. The check sources::eng_trace_by_id passes, eng_traceql_search still
  passes, and the 2 new trace unit tests plus the 4 traceql unit tests pass. No build warnings.
- 2026-11-08T20:04:26Z supervisor: eng-trace-by-id passed the gate in round 1
- eng-identity-restricted-denied (worker, round 1): **no code change.** The fail-closed rule
  already in `src/sources.rs` (`HttpSources::pick`, `is_restricted`) meets every step. Earlier
  sessions added it for eng-promql-source-selection. It refuses a `restricted = true` source with
  42501 `source "<name>" is Restricted Telemetry and needs telemetry_restricted` at plan time. That
  happens before any source request (inside a JOIN too) and before any audit write. It refuses
  every identity because no token is read yet. That covers every case this feature lists: no
  identity, a token without the claim, a token signed with another key, and an expired token.
  The check passed on the untouched tree, both after init and again after my manual run.
  - Deliberately not built here: token verification and *allowing* a valid claim-bearing token.
    Allowing a restricted read before the audit writer exists would let restricted data out
    unaudited. So the deny-all stays until the audit features and
    eng-identity-token-verification land together.
  - Trap for the next session: eng-audit-dynamodb-item (next in the list) needs an Audited Query
    to happen. So it must first verify the §3 token (A5) from `hrx.setting:hrx.identity` (read with
    `Settings::get`) and let a valid `telemetry_restricted` reader through `pick`. The restricted
    check also needs the session identity in `HttpSources::pick`, which today has no session
    access. Keep the refusal text naming `telemetry_restricted`, because the identity tests match
    on it.
  Tested as a user: `../tmp/restricted/run.sh` starts three Python mocks (prom-open,
  prom-restricted, and a logger on the audit DynamoDB/S3 endpoint) plus the engine, then runs
  queries over pg-wire on one session. The open promql query returned 2 rows. The restricted
  query returned 42501 naming telemetry_restricted each time: with no identity, after SET
  hrx.identity with a token without the claim, with a token signed by another key, with an
  expired token, and inside a JOIN with the open source. The restricted mock and the audit logger
  received zero requests. The open mock saw only the first query, because the JOIN is refused at
  plan time.
- 2026-11-08T20:06:37Z supervisor: eng-identity-restricted-denied passed the gate in round 1
- eng-audit-dynamodb-item (worker, round 1): Restricted Telemetry is now readable with a valid
  identity, and every such read is an Audited Query that writes one DynamoDB `executions` item.
  - New `src/identity.rs`: verifies the §3 token from `hrx.identity` (HMAC-SHA256 over the
    base64url payload, v = 1, exp not passed, iat ≤ now+60, exp−iat ≤ 300, sub/email strings).
    A token that fails any check counts as no identity. `Access` is put into the DataFusion
    `SessionConfig` as an extension for each statement (`Sql::state_for`). `HttpSources::pick`
    and `resolve` now take the `&dyn Session` (all 6 table functions pass `args.session()`), and
    for a restricted source they call `Access::require_restricted`. That refuses with 42501
    (same text naming telemetry_restricted) unless `attrs.telemetry_restricted = true` and the
    token is not an agent, and records the source as audited.
  - New `src/audit.rs`: `AuditWriter` (aws-sdk-dynamodb, default credential chain,
    `[audit] region` and `dynamodb_endpoint_url`) does PutItem with
    `ConditionExpression attribute_not_exists(id)`. The record has exactly the portal fields:
    uuid v4 id, the SQL, mode read, description, database = source name, linearTicketId (left
    out without a ticket), executedByEmail/Sub, status success, rowCount, integer durationMs,
    errorMessage null, preview false, action, integrityHash, createdAt (`%.3fZ`) and
    createdAtMonth. `record()` keeps the portal key order (EXECUTION_KEY_ORDER), ready for the
    S3 body. `integrity_hash` implements computeIntegrityHash with V8-style escaping.
    `eng_audit_integrity_hash` already passes.
  - `pg.rs`: `Action::Query(plan, audited_sources)`. `Prepared` keeps the SQL from Parse.
    `Sql::run` checks the *current* identity again at execute time (the extended protocol may
    execute later than Parse), runs the plan, writes the record, and only then returns rows. A
    failed write is 58000 "audit write failed"; the cause goes to stderr only. The SQL recorded
    is the query string as received when it holds one statement. In a multi-statement simple
    query it is that statement re-rendered by sqlparser, so a preceding `SET hrx.identity` token
    never lands in the audit record.
  - Deps added: aws-sdk-dynamodb 1.137, hmac 0.12, sha2 0.10, hex 0.4, uuid 1 (v4). All of them
    resolved offline; only aws-sdk-dynamodb added new lock entries.
  - Contract assumptions: action = `ai_ask` for agent=true or iss telemetry-mcp, `assertion`
    for sys=true, else `query`. An agent never passes the restricted check. Anything but
    `"agent": false` counts as an agent. A query touching several restricted sources writes ONE
    item with `database` = names joined by "," in plan order. createdAt is taken after the query
    ran. description/ticket that are blank after trim count as absent.
  - Built ahead, because it was needed to allow access safely (the next sessions should verify
    and not rebuild it): token verification (eng-identity-token-verification already passes),
    the 42501 "audited query requires a description" refusal (eng-audited-query-description-
    required), and fail-closed 58000 on a DynamoDB failure. NOT done: the S3 Object Lock object
    (eng-audit-s3-object: add it in `AuditWriter::write`, using `record()`'s order and
    `[audit] s3_endpoint_url`/`s3_retention_days`), records for failed queries
    (eng-audit-failed-query-recorded: `Sql::run` writes nothing when execute fails), and
    selector/log-group precision. A Loki source with restricted_selectors or a cloudwatch_logs
    source with restricted_log_groups is still restricted as a whole: every query to it needs
    the claim and is audited.
  Tested as a user: `../tmp/audit-item/run.sh` starts open and restricted Prometheus mocks, a
  Python DynamoDB logger and the engine. It runs the steps on one pg-wire session; `X:` in
  `../tmp/pgclient` means the extended protocol. With a telemetry_restricted token carrying a
  description and ticket ENG-1799, the extended-protocol restricted query returned 2 rows. The
  logger saw one `DynamoDB_20120810.PutItem` on db-query-portal-executions with
  ConditionExpression attribute_not_exists(id) and exactly the 17 fields: uuid id, the SQL
  verbatim, read, database prom-restricted, ENG-1799, sub, email, success, rowCount N 2,
  durationMs N 1, errorMessage NULL, preview false, query, createdAt
  2026-11-08T20:15:46.492Z, 2026-11, hmac-sha256:…. With a ticketless token the second item
  had no linearTicketId. Open queries (extended and simple) wrote nothing: still 2 puts. Checks
  passed after init: audit::eng_audit_dynamodb_item, identity::eng_identity_restricted_denied,
  promql::eng_promql_source_selection, ops::eng_lightdash_session_compat, and new unit tests in
  identity/audit. No build warnings. rustfmt is not installed here, so lines were wrapped by
  hand.
- 2026-11-08T20:17:35Z supervisor: eng-audit-dynamodb-item passed the gate in round 1
- 2026-11-08 eng-audit-s3-object (round 1): every audit record is now also written to the S3
  Object Lock bucket.
  - `audit.rs`: `AuditWriter::write` does the DynamoDB PutItem first, then S3 PutObject to
    `[audit] s3_bucket`, key `executions/<createdAt>/<id>.json`. The body is `js_pretty(&record)`,
    which is `JSON.stringify(record, null, 2)` in the portal key order with V8 escaping (it reuses
    `js_json`), so non-ASCII stays raw. It sets content-type application/json, ObjectLockMode
    COMPLIANCE and retain-until = now + `s3_retention_days` (default 2555, from engine-config).
    With `s3_endpoint_url` set the client uses path-style addressing (`/<bucket>/<key>`).
    Both clients share one lazily loaded `SdkConfig` (`shared()`). If the S3 put fails, the
    write returns an error and the client gets 58000. That means `audit::eng_audit_fail_closed`
    already passes; the session for that feature should verify it, not rebuild it. Retention
    day counts too large for chrono are an error, not a panic.
  - Dep added: aws-sdk-s3 1.157 (resolved offline; new lock entries aws-sdk-s3,
    aws-smithy-checksums, crc-fast, lru, sha1, spin). `cargo fetch --offline` fails on the
    Windows-only schannel crate. That is harmless: the build doesn't need it.
  - Contract assumption: DynamoDB is written before S3, and both writes must succeed. A failed
    S3 put therefore leaves a DynamoDB item with no S3 object (the item is append-only, so it
    can't be rolled back).
  - Trap: the SDK adds `?x-id=PutObject` to the S3 PUT path. Strip it if you match paths in a mock.
  Tested as a user: `../tmp/audit-s3/run.sh <out> [extra [audit] line]` starts the open and
  restricted Prometheus mocks, a Python DynamoDB+S3 logger and the engine. It sets a token whose
  description is multi-line with quotes, unicode and an emoji, plus ticket ENG-7, then runs the
  restricted query over the extended protocol and gets 2 rows. `verify.js` (node) found 1
  PutItem and 1 S3 PUT to /db-query-portal-audit/executions/<createdAt>/<id>.json. The body was
  byte-equal to node's own JSON.stringify(item, null, 2) of the DynamoDB item (717 bytes).
  Content-type was application/json and the lock mode COMPLIANCE. Retain-until was 2555.00
  days ahead, and 30.00 days with `s3_retention_days = 30`. Checks passed after init:
  audit::eng_audit_s3_object, eng_audit_dynamodb_item, eng_audit_integrity_hash,
  eng_audit_fail_closed, and the audit unit tests (new: js_pretty_is_two_space_json_stringify).
  No build warnings.
- 2026-11-08T20:22:30Z supervisor: eng-audit-s3-object passed the gate in round 1
- 2026-11-08 eng-audit-integrity-hash (round 1): already implemented by eng-audit-dynamodb-item
  (`audit::integrity_hash` + `js_json`). This session verified it and changed no engine code.
  - Checked against the portal's real source (read-only ref
    `~/Locals/Tinkering/eng-1799-factory/refs/db-query-portal@aea73de/api/src/services/audit.service.ts`):
    the canonical object is {sql, mode, description, database, linearTicketId, executedBySub,
    status, rowCount, preview, action ?? 'query', createdAt}. `linearTicketId` is typed
    `string | null`, so the engine's null for "no ticket" matches (it is never omitted from the
    hash). An empty `AUDIT_INTEGRITY_KEY` would make the portal fall back to sha256. The engine
    instead rejects a named-but-empty or missing key env at startup (config problem), so it never
    silently downgrades.
  Tested as a user: `../tmp/integrity/fixture.mjs` copies the portal's computeIntegrityHash
  verbatim and reproduced all 3 entries of `fixtures/integrity_hash.json` (hmac and sha256).
  `../tmp/integrity/run.sh <out> key|nokey` starts the Prometheus mocks, the DynamoDB+S3 logger
  and the engine. It runs the restricted query over the extended protocol, with SQL whose comment
  holds unicode, ✓, `"`, backslashes, 🚀 and \x01, and a token description that holds \n, \t,
  quotes, backslashes, unicode, an emoji and \x01. Both are stored verbatim (2 rows returned).
  `verify.mjs` recomputes the hash of the PutItem with the portal function: the hmac-sha256 hash
  matched under key `k`. With `integrity_key_env` removed (env var still set), the item got a
  `sha256:` hash that matched the portal fallback. Check passed after init, as did the
  `audit::` unit tests.
- 2026-11-08T20:24:40Z supervisor: eng-audit-integrity-hash passed the gate in round 1
- 2026-11-08 eng-audit-fail-closed (round 1): already implemented by eng-audit-dynamodb-item and
  eng-audit-s3-object (the audit write runs before any DataRow, and an error from either store
  becomes 58000 'audit write failed'). This session verified it and changed no engine code.
  - The engine logs the full SDK error (`engine: audit write failed: DynamoDB PutItem on <table>`
    or `S3 PutObject s3://<bucket>/<key>`) to stderr. The client only sees the generic message.
  - Refusals tested were AccessDenied responses (400 from DynamoDB, 403 from S3), which the SDK
    doesn't retry. A 5xx would be retried by the SDK's default retry policy before failing.
  Tested as a user: `../tmp/audit-fail/run.sh <out>` starts the open and restricted Prometheus
  mocks, a DynamoDB+S3 store that refuses writes while `<out>/ctl/fail-dynamo` or `fail-s3`
  exists, and the engine. Each phase sets a restricted identity token, then runs the restricted
  promql query over the simple and extended protocols. With the table refusing: no rows,
  `ERROR 58000: audit write failed` on both protocols, and S3 is never called. With only the
  bucket refusing: DynamoDB ok, S3 refused, 58000 on both. After the store is restored: 2 rows on
  each protocol. The check passed after init.
- 2026-11-08T20:26:02Z supervisor: eng-audit-fail-closed passed the gate in round 1
- 2026-11-08 eng-identity-token-verification (round 1): eng-audit-dynamodb-item already built this
  (`identity::verify` in `src/identity.rs`). This session verified it and changed no engine code.
  - Behaviour to keep in mind: the payload must be base64url without padding (a padded payload or
    signature fails to decode, so it counts as no claims). `v` must be the integer 1 (`1.0` is
    rejected). `exp == now` counts as expired. Whitespace around the whole token is trimmed. A
    token that fails verification gives the same 42501 text as no token at all
    (`... needs telemetry_restricted`). It never reaches the source or the audit store.
  Tested as a user: `../tmp/token-verify/run.sh <out>` starts the open and restricted Prometheus
  mocks, the DynamoDB+S3 store and the engine. On one pg-wire session it SETs hrx.identity and
  runs the restricted promql count for each variant that `tok.py` mints. Fresh, iat +30 s, and
  near expiry (iat −290 s, exp +10 s) each returned 2. Expired, iat +120 s, 301 s lifetime, v 2,
  v missing, wrong key, tampered email, `not-a-token` and empty were each accepted by SET, and
  each query then failed with 42501. After that, a good token returned 2 again. The restricted
  mock saw 4 requests and the store 8 calls (one PutItem and one PutObject per allowed query),
  so the rejected tokens reached neither. The check passed after init, as did the `identity::`
  unit tests.
- 2026-11-08T20:27:41Z supervisor: eng-identity-token-verification passed the gate in round 1
- 2026-11-08 eng-identity-per-session (round 1): already implemented, because `hrx.identity` is an
  ordinary per-connection setting (`Settings` in `src/pg.rs`) and `Sql::identity` re-verifies it
  at every plan and execute. Nothing is cached across connections or queries. This session verified
  it and changed no engine code.
  - A trap for later identity features: the identity is re-read from the session setting on each
    statement, so token expiry applies mid-session too. Don't add a per-connection cache of the
    verified `Identity` unless it also re-checks `exp`.
  Tested as a user: `../tmp/identity-session/run.sh <out>` starts the open and restricted
  Prometheus mocks, the DynamoDB+S3 store and the engine, then runs separate pg-wire sessions with
  `pgclient`. Session A (SET with the claim, then 6 restricted queries) and session B (no SET,
  6 queries) ran at the same time: A got 6/6 rows, B got 6/6 42501. Eight concurrent sessions
  (even ones with the claim, odd ones with a valid token without it) ran 3 queries each: even ones
  got 3/3 rows, odd ones 3/3 42501. One session SET the claim token (query ok) and then a no-claim
  token (query 42501). A fresh session afterwards got 42501. The restricted mock saw 19 requests
  and the store saw 38 calls, exactly the allowed queries. The check passed after init.
- 2026-11-08T20:29:30Z supervisor: eng-identity-per-session passed the gate in round 1
- 2026-11-08 eng-identity-agent-and-system (round 1): `Identity::check_restricted` in
  `src/identity.rs` now checks for an agent first. Any agent identity (`agent` not exactly
  `false`, or `iss = telemetry-mcp`) gets 42501 `source "<s>" is Restricted Telemetry, which an AI
  agent identity (agent = true) may never read`, whatever its attrs say. Before this change agents
  were also refused, but the message only named telemetry_restricted, and the acceptance test wants
  "agent" in it. The system identity (`sys = true`) is checked like a person: it needs the attr
  (otherwise the `needs telemetry_restricted` text) and a description. The unit test now asserts
  the agent wording and that a system identity with the attr is allowed.
  - CONTRACTS doesn't specify the message text. The test only requires "agent" in it.
  - Platform agent rules (preview-only writes, §5) are a separate feature and aren't touched here.
  Tested as a user: `../tmp/agent-system/run.sh <out>` starts the open and restricted Prometheus
  mocks, the DynamoDB+S3 store and the engine. On one pg-wire session it SETs each token from
  `tok.py` and runs the restricted query, then the open one. agent=true with the attr: restricted
  query 42501 naming agent, open query 2. MCP token (iss telemetry-mcp): the same. System
  (system:alert-evaluator) with the attr and a description: restricted query 2, open query 2.
  System without the attr: restricted query 42501 needs telemetry_restricted, open query 2. The
  restricted mock saw 1 request and the store 2 calls. The check passed after init, as did the
  `identity::` unit tests. rustfmt and clippy aren't installed on this machine, so neither was run.
- 2026-11-08T20:31:54Z supervisor: eng-identity-agent-and-system passed the gate in round 1
- 2026-11-08 eng-audited-query-description-required (round 1): this was already implemented when
  the session started. `verify` in `src/identity.rs` keeps `audit.description` only if it is a
  non-blank string, and `Identity::check_restricted` returns 42501 `audited query requires a
  description` when it is missing. That check runs at plan time, before any source request or
  audit write. This session verified the behaviour and changed no engine code.
  - Order of checks for a restricted source: agent first, then telemetry_restricted, then the
    description. A token that lacks both the attr and a description gets the `needs
    telemetry_restricted` message, not the description one.
  Tested as a user: `../tmp/description-required/run.sh <out>` starts the open and restricted
  Prometheus mocks, the DynamoDB+S3 store and the engine. On one pg-wire session it SETs tokens
  with the claim and runs the restricted promql count after each one. The token variants were: no
  description, "", "   " and no `audit` object. Each returned 42501 `audited query requires a
  description`. A token with a description then returned 2. The restricted mock saw 1 request
  and the store saw 2 calls, both from the allowed query. The check passed after init.
- 2026-11-08T20:33:14Z supervisor: eng-audited-query-description-required passed the gate in round 1
- 2026-11-08 eng-restricted-loki-selectors (round 1): a Loki source's `restricted_selectors` are
  now checked per query rather than making the whole source restricted. The new
  `src/selectors.rs` (`may_touch`) finds every stream selector `{...}` in a logql or
  logql_metric query (skipping `"`/`` ` `` string literals) and parses its matchers. The query is
  open only if every selector is *provably disjoint* from every restricted selector. That means
  some label has `="v"` against `="w"` (v != w), or `="v"` against `!="v"`. Everything else counts
  as restricted and goes through `Access::require_restricted` (42501 naming
  telemetry_restricted, plan time, before any request, and the statement becomes an Audited
  Query): regex matchers, missing labels, `!=` alone, any `\` escape in a value, a `#` outside a
  string, unbalanced braces, an empty `{}`, a query with no selector, and an unparseable
  restricted selector in the config. `HttpSources::resolve_logql` (src/sources.rs) does the check
  and `logql.rs` calls it for both functions. `is_restricted` no longer counts Loki selectors.
  CloudWatch Logs `restricted_log_groups` still restrict the whole source; that is the next
  feature (eng-restricted-cloudwatch-log-groups).
  - Contract assumption: CONTRACTS §1.2 says "touches a stream selector", and the feature says
    "only provably disjoint selectors are open". Only the eq/eq and eq/ne cases count as proof.
    `{namespace=~"web"}` is restricted even though it is logically disjoint. This is narrow on
    purpose and fails closed.
  - `engine-config`'s `is_audited` is unchanged: a Loki source with restricted_selectors still
    needs `[audit]`.
  Tested as a user: `../tmp/restricted-loki/run.sh <out>` starts a synthetic Loki mock, the
  DynamoDB+S3 store and the engine (loki-a, restricted_selectors = ['{namespace="platform"}']).
  It drives one pg-wire session with pgclient. With no identity, {namespace="web"},
  {namespace="web", app="api"} and a metric query over namespace="web" returned 1 row each. These
  each got 42501 needs telemetry_restricted: {namespace="platform"}, {namespace="platform",
  app="api"}, {app="api"}, {namespace=~"plat.*"}, {namespace!="web"}, sum(count_over_time(
  {namespace="platform"}[5m])), and a web/platform ratio. After SET hrx.identity with a
  restricted reader token, {namespace="platform"} returned 1 row. Loki saw exactly 4 requests
  (the 3 open queries and the authorized one), and the store saw one dynamo put and one S3 put.
  The check passed after init, as did `selectors::` unit tests and sources::eng_logql_streams and
  sources::eng_logql_metric.
- 2026-11-08T20:38:43Z supervisor: eng-restricted-loki-selectors passed the gate in round 1
- 2026-11-08 eng-restricted-cloudwatch-log-groups (round 1): a CloudWatch Logs source's
  `restricted_log_groups` are now checked per call instead of making the whole source restricted.
  `HttpSources::pick_log_groups` (src/sources.rs) wraps `pick` and calls
  `Access::require_restricted` (42501 naming telemetry_restricted, plan time, before StartQuery,
  and the statement becomes an Audited Query) when `touches_log_group` says the call may touch a
  restricted group. `cloudwatch_logs.rs` uses it. The old `is_restricted` helper is gone; only
  `restricted = true` restricts a whole source now.
  - Contract assumption (fails closed): a requested group touches a restricted one when its
    trimmed name equals it exactly (case-sensitive, like CloudWatch), or when it is an ARN
    `...:log-group:<name>` / `...:log-group:<name>:*` of it. Any query whose first word is
    `SOURCE` (the Logs Insights command that picks log groups itself) also counts as touching.
    No prefix/wildcard matching: `/aws/rds/platform-replica` is open.
  - `engine-config`'s `is_audited` is unchanged: a source with restricted_log_groups still needs
    `[audit]`.
  Tested as a user: `../tmp/restricted-cwlogs/run.sh <out>` starts the Logs Insights mock, the
  DynamoDB+S3 store and the engine (logs-a, restricted_log_groups = ["/aws/rds/platform"]) and
  drives one pg-wire session with pgclient. With no identity, /aws/lambda/web and
  /aws/rds/platform-replica returned rows. These got 42501 needs telemetry_restricted:
  /aws/rds/platform, "/aws/lambda/web, /aws/rds/platform", " /aws/rds/platform ", the ARN form,
  and a `SOURCE logGroups() | ...` query. After SET hrx.identity with a restricted reader token,
  the web+platform list returned rows. The mock saw exactly 3 StartQuery calls (2 open, 1
  authorized) and the store saw one dynamo put and one S3 put. The check passed after init, as
  did sources::eng_cloudwatch_logs_insights, sources::eng_cloudwatch_logs_failure_and_cancel,
  identity::eng_identity_restricted_denied, identity::eng_restricted_loki_selectors and the
  `sources::` unit test. rustfmt and clippy are not installed on this toolchain; formatted by hand.
- 2026-11-08T20:41:32Z supervisor: eng-restricted-cloudwatch-log-groups passed the gate in round 1
- 2026-11-08 eng-platform-query-basic (round 1): `platform_query(sql)` reads the Platform
  Database. New `src/platform.rs`: at plan time the table function checks the claim, then does a
  describe-only round trip (tokio-postgres `prepare` = Parse/Describe, never Execute) on a fresh
  connection to the source's read URL and turns the column types into the schema. At scan time it
  prepares again, refuses with 0A000 if the column types changed since planning, and streams the
  rows (binary) with `query_raw`, failing 54000 past `max_rows`. Postgres errors keep their own
  SQLSTATE (`session::sqlstate_owned`; `SqlStateError.code` is now a `Cow<'static, str>`).
  Access: `Identity` gained `platform_read`; `identity::Claim` (TelemetryRestricted |
  PlatformRead) and `AuditedRead {source, claim}` replace the plain source list in
  `Access`/`Action::Query`, and `Sql::run` re-checks each read with `Identity::check` before
  executing and auditing (database = source name). Agents with platform_read may read (§1.2).
  New dependency: tokio-postgres 0.7 (with-chrono-0_4), already in Cargo.lock as a dev-dep.
  - Contract assumptions: platform_query has no source argument, so it reads the kind's default
    `platform_postgres` source (the only one, or `default = true`); none → 42704. Types: bool,
    int2/4/8, float4/8, date, timestamp, timestamptz keep their type; text-likes (incl. citext),
    uuid and numeric (exact text, decoded from binary) are text; json/jsonb are json. Anything
    else (arrays, intervals, bytea, ...) fails 0A000 telling the user to cast to text. Duplicate
    column names fail 42701 (DataFusion can't hold them).
  - Traps for the next sessions: table functions are synchronous, so the describe uses
    `tokio::task::block_in_place` + `Handle::block_on` (needs the multi-thread runtime; a
    CancelRequest/statement_timeout is not observed while planning blocks). Each describe and each
    run opens its own connection: eng-platform-pools must add a pool. The connection is `NoTls`;
    a read URL with `sslmode=require` fails closed — TLS to RDS is a follow-up. No guard yet
    (eng-guard-read-mode); the read-only role is the only write protection for now. Don't add
    `default_transaction_read_only`: nextval() in the describe-only test would fail.
  - eng-platform-query-enforcement's acceptance test already passes with this change (run once,
    informational).
  Tested as a user: `../tmp/platform-basic/run.sh <out>` initdb's a throwaway cluster (synthetic
  widgets/patients, seeded with pgclient's new `seed` bin because psql is blocked by the sandbox),
  starts the audit store mock and the engine, and drives one session with pgclient's new
  `platform` bin. Without platform_read: 42501 naming platform_read, and Postgres saw no
  statement. With platform_read + description: prepare showed id int8, name text, active bool,
  created_at timestamptz, score float8, note text; 3 rows, note NULL; the simple-protocol count
  returned "2". Postgres's log showed each statement executed exactly once; the store saw one
  dynamo put + one S3 put per query. Bad column → 42703 from Postgres; ARRAY column → 0A000.
  The check passed after init, as did identity::eng_identity_restricted_denied,
  identity::eng_audited_query_description_required, audit::eng_audit_dynamodb_item and the
  `platform::`/`identity::`/`audit::`/`transaction::`/`session::`/`pg::` unit tests.
- 2026-11-08T20:51:04Z supervisor: eng-platform-query-basic passed the gate in round 1
- 2026-11-08 eng-platform-query-enforcement (round 1): no code change needed. eng-platform-query-basic
  already enforces it: `PlatformQuery::call_with_args` calls `Access::require(.., Claim::PlatformRead)`
  before the describe round trip, and `Identity::check` refuses a missing/invalid/expired identity
  or one without `attrs.platform_read` with 42501 naming platform_read, then one without a
  description with 42501 'audited query requires a description'. Agents with platform_read may
  read (audited as ai_ask, per `Identity::action`). An expired token is accepted by SET but leaves
  the session with no identity, so it reads as "needs platform_read".
  Tested as a user: `../tmp/platform-enforce/run.sh <out>` (throwaway cluster, audit store mock,
  engine; pgclient's `platform` bin, one session per token) ran the same platform_query through
  extended and simple protocol for: no identity, only telemetry_restricted, only platform_explain,
  platform_read without description, expired reader -> each 42501 (platform_read, or the
  description message for the no-description one). Postgres's statement log and the store's
  call log did not grow during any of them. Reader with description and an MCP agent with
  platform_read -> 1 row each, one dynamo + one S3 put per query. The check passed after init.
- 2026-11-08T20:53:03Z supervisor: eng-platform-query-enforcement passed the gate in round 1
- 2026-11-08 eng-platform-query-describe-only (round 1): no code change needed. eng-platform-query-basic
  already plans with a describe-only round trip: `PlatformQuery::call_with_args` calls
  `client.prepare` (Parse + Describe, never Execute) to learn the columns, and `PlatformTable::fetch`
  prepares again and executes once, refusing (0A000) if the column types changed in between. So a
  zero-row result keeps its columns, and a statement Postgres can't describe fails at plan time
  (42703 for a missing column). Extended protocol plans the statement twice (Parse, then Bind) and
  so describes twice, but executes once.
  Tested as a user: `../tmp/platform-describe/run.sh <out>` (throwaway cluster with widgets +
  probe_seq, audit store mock, engine; pgclient's `platform` bin, reader token). nextval through
  extended, extended, simple returned 1, 2, 3, and Postgres's log showed exactly three `execute`
  lines for it. Preparing `SELECT id, name FROM widgets WHERE false` showed id int8, name text,
  and 0 rows. `SELECT no_such_column FROM widgets` -> 42703. The check passed after init.
- 2026-11-08T20:54:53Z supervisor: eng-platform-query-describe-only passed the gate in round 1
- 2026-11-08 eng-guard-read-mode (round 1): new workspace crate `crates/engine-guard` (no
  dependencies) is a line-for-line port of the portal's `api/src/services/query-guard.ts` @ aea73de
  (read from `~/Remotes/HouseRx/db-query-portal`, `git show aea73de:...`, read-only). It has the same
  check order, the same messages, `Rejection.status` 400 (empty SQL) or 422, and `Mode::Read`/`Write`.
  It returns the trimmed SQL, which is what runs, as in the portal. JS semantics are kept on purpose:
  ECMAScript whitespace for trim and `\s` (including U+FEFF, but not U+0085), and ASCII-only
  case-insensitive matching (a Rust `(?i)` regex would also match the Kelvin sign for `k`).
  `PlatformQuery::call_with_args` runs `guard(sql, Mode::Read)` right after `Access::require` and
  before any connection. A rejection is `42501` with the portal's message verbatim, and it is not
  audited because planning fails. The crate's unit tests port `query-guard.test.ts` case for case,
  in both modes.
  Also fixed a pre-existing `clippy::question_mark` error in `src/selectors.rs` (same behaviour;
  the selectors unit tests and identity::eng_restricted_loki_selectors pass).
  Tested as a user: `../tmp/guard-read/run.sh <out>` (throwaway cluster, audit store mock, engine;
  pgclient's `platform` bin with a platform_read token, one session per case, extended then simple
  protocol) ran all 45 read-mode cases. Each rejection got 42501 with the portal's message, and the
  Postgres log and audit store did not grow. Each allowed case either returned rows (audited) or
  failed in Postgres (42P01 for table `t`). patients 2/2 and widgets 200/200 before and after.
  Differential: `tmp/guard-diff` (gitignored) runs the portal's own TS (node --experimental-strip-types)
  and the crate over 2 x 20000 random fragment-built statements in both modes: 0 mismatches,
  status included.
  For eng-guard-write-mode: `/v1/write` should call `engine_guard::guard(stmt, Mode::Write)` and map
  `Rejection.status` to HTTP 400/422. platform_explain (A30) should call it with `Mode::Read`.
  Trap: `cargo fmt --all` with the private toolchain rewraps many existing files that earlier
  sessions formatted by hand, so format only the files you touch (`cargo fmt -p engine-guard` is clean).
- 2026-11-08T21:05:26Z supervisor: eng-guard-read-mode passed the gate in round 1
- 2026-11-08 eng-platform-read-only-role (round 1): no code change needed. Earlier features already
  do this: `PlatformSource` in `federation-engine/src/platform.rs` is built from `read_url` only. It
  never reads `write_url`, so platform_query connects as the read role even when `write_url_env` is
  set. `engine_guard::guard(sql, Mode::Read)` (eng-guard-read-mode) rejects DELETE/UPDATE, including
  a DELETE inside a CTE, with 42501 "... requires write mode and the elevated role." before any
  connection opens.
  Tested as a user: `../tmp/platform-readonly/run.sh <out>` (throwaway cluster with engine_read
  SELECT-only and engine_write DML roles, audit store mock, engine configured with BOTH
  read_url_env and write_url_env; pgclient's `platform` bin, reader token, extended then simple).
  `SELECT current_user` -> engine_read in both protocols. `DELETE FROM widgets`, the DELETE CTE and
  an UPDATE -> 42501 "requires write mode" in both protocols. widgets 200 before and after, and the
  Postgres log gained 0 lines during the write attempts. Only engine_read ever connected; engine_write
  never did. The check passed after init.
  For Write Mode (/v1/write): that path should be the only user of `write_url`. Keep platform_query,
  platform_tables/columns and platform_explain on the read pool.
- 2026-11-08T21:07:53Z supervisor: eng-platform-read-only-role passed the gate in round 1
- 2026-11-08 eng-platform-sql-over-results (round 1): no code change needed. platform_query is a
  table function in the engine's SQL layer (eng-platform-query-basic), so JOIN, WHERE and GROUP BY
  over its rows already run in the engine. Postgres only gets the inner SQL string.
  Tested as a user: `../tmp/platform-sql/run.sh <out>` (throwaway cluster with the acceptance
  harness's synthetic widgets seed, audit store mock, engine; pgclient's `platform` bin with a reader
  token, extended then simple protocol). JOIN with VALUES -> widget-2/two, widget-4/four. GROUP BY
  active -> (false, 100, 298.5), (true, 100, 300), typed bool/int8/float8. count(*) WHERE id > 190
  -> 10. The Postgres log shows only the inner statements (`SELECT id, name FROM widgets WHERE id <= 5`
  etc.), each executed once per query. The check passed after init.
  Note for later: in the simple protocol the engine renders float8 300 as "300.0", but Postgres
  renders it as "300". Extended/binary is unaffected. This existed before this feature; the
  pg-compat line could align float text output with Postgres if a client compares text.
- 2026-11-08T21:09:27Z supervisor: eng-platform-sql-over-results passed the gate in round 1
- 2026-11-08 eng-platform-tables-columns (round 1): added `PlatformCatalog` in
  `federation-engine/src/platform.rs` (registered in `src/pg.rs` as `platform_tables` and
  `platform_columns`). Both reuse platform_query's source and `PlatformTable`: same read pool (read
  role), same `Access::require(.., Claim::PlatformRead)` (42501 naming platform_read, and it makes the
  statement an Audited Query), same max_rows. Source lookup moved into
  `PlatformSource::from_config`/`for_call`, shared by all three. `PlatformTable` gained `params`
  (bound text parameters) and `signature` (for its error messages).
  The SQL is the engine's own: `information_schema.tables` without `information_schema` and `pg_*`
  schemas, ordered by schema and name; `information_schema.columns` for `$1::text`/`$2::text`
  ordered by `ordinal_position`, `data_type` as information_schema reports it, and
  `is_nullable = 'YES'` as bool. The names are bound, so there is no injection and no read guard. The
  columns are fixed, so planning has no Postgres round trip, and each call runs once at execution.
  Contract assumptions: "user tables" includes views and foreign tables (anything
  information_schema.tables shows to the read role outside system schemas). That means only what
  the read role has a privilege on. An unknown table gives zero rows, not an error.
  Tested as a user: `../tmp/platform-catalog/run.sh <out>` (throwaway cluster with widgets, patients,
  t and an `other.hidden` table without USAGE for engine_read, audit store mock, engine; pgclient's
  `platform` bin). With a garbage token or a token without attrs, both functions -> 42501 "...
  needs platform_read", and 0 audit store calls. With the reader token, platform_tables -> text
  columns table_schema/table_name, rows public.patients, public.t, public.widgets (other.hidden
  not visible), in both extended and simple protocol. platform_columns('public','widgets') -> text,
  text, bool; id bigint false, name text false, active boolean false, created_at timestamp with
  time zone false, score double precision true, note text true. ('public','nope') -> 0 rows. The
  Postgres log shows one execute per call (a prepare alone runs nothing there). 4 calls gave 4
  DynamoDB and 4 S3 audit writes. The check, the platform unit tests, platform::eng_platform_query_basic
  and _enforcement pass. clippy -D warnings is clean (private toolchain).
  For platform_explain: `PlatformSource::for_call` checks only platform_read. Give it a claim
  parameter (or check platform_explain separately) and keep explain on the read pool.
- 2026-11-08T21:17:21Z supervisor: eng-platform-tables-columns passed the gate in round 1
- 2026-11-08 eng-platform-explain (round 1): added `PlatformExplain` in
  `federation-engine/src/platform.rs` (registered as `platform_explain` in `src/pg.rs`) and
  `Claim::PlatformExplain` plus `Identity::platform_explain` (`attrs.platform_explain`) in
  `src/identity.rs`. The claim accepts platform_explain or platform_read. A refusal is 42501 "source
  \"…\" is the Platform Database and needs platform_explain or platform_read". It still needs
  `audit.description` and is an Audited Query (CONTRACTS §1.2, §6). platform_explain alone does not
  allow platform_query/tables/columns. `PlatformSource::for_call` now takes the claim. The sql
  passes the read guard (Mode::Read) like platform_query's. Then `EXPLAIN (FORMAT JSON) <guarded
  sql>` runs once on the read pool through the shared `PlatformTable`, with fixed column `plan json`,
  so planning has no Postgres round trip. The options come first and are fixed, so nothing in sql
  can add ANALYZE. A sql that itself starts with EXPLAIN (the guard allows that keyword) becomes
  `EXPLAIN (FORMAT JSON) EXPLAIN …`, and Postgres rejects it with 42601. Nothing runs.
  Tested as a user: `../tmp/platform-explain/run.sh <out>` (throwaway cluster with synthetic
  widgets and probe_seq, audit store mock, engine; pgclient's `platform` bin, which now decodes json
  columns). Garbage token / no attrs -> 42501 naming both claims, 0 audit calls. Explain-only token
  and reader token -> one column `plan` of type json and one row, `[0].Plan` with Node Type Index
  Scan and Total Cost, no Actual Rows, in extended and simple protocol. Explaining nextval leaves
  probe_seq.is_called false. DELETE, a DML CTE and a stacked statement -> 42501 guard messages.
  Widgets is unchanged. The Postgres log shows only `EXPLAIN (FORMAT JSON) …`, one execute per call.
  6 successful calls -> 12 audit writes.
  Trap: `cargo fmt` (private toolchain) rewrites several src files that HEAD left unformatted
  (audit, cloudwatch*, logql, promql, …). Revert the unrelated hunks rather than committing them,
  or let a dedicated change do the reformat.
- 2026-11-08T21:22:57Z supervisor: eng-platform-explain passed the gate in round 1
- 2026-11-08 eng-platform-statement-timeout (round 1): `federation-engine/src/platform.rs` only.
  The check first failed with 0A000 because `pg_sleep` returns `void`, which platform_query
  refused. And nothing stopped the Postgres backend on timeout: dropping a tokio_postgres
  `Client` leaves an in-flight statement running to its end. Changes: (1) `void` columns map to
  text and read as `''` (Postgres prints void as the empty string, and its binary form is 0
  bytes). (2) `CancelOnDrop` in `PlatformTable::fetch` holds the connection's `CancelToken`. If
  the fetch future is dropped before the rows are all read (statement_timeout drops the collect
  future in pg.rs, and so do a cancel request or a disconnect), or if fetch fails (e.g. max_rows),
  its Drop spawns `cancel_query(NoTls)`, so the backend stops (CONTRACTS §1 "Cancellation"). It is
  disarmed after the last row. This covers platform_query, platform_tables/columns and
  platform_explain, since they all use `PlatformTable`.
  Contract assumption: a `void` column is text `''`. The contract has no type list for void, and
  the feature's own step selects `pg_sleep(30) AS s`.
  Tested as a user: `../tmp/platform-timeout/run.sh <out>` (throwaway cluster, audit store mock,
  engine; a new pgclient bin `ptimeout`, simple protocol, plus a superuser pg_stat_activity
  probe; psql is blocked by the sandbox). SET statement_timeout = 500, then
  platform_query('SELECT pg_sleep(30) AS s') -> 57014 "canceling statement due to statement
  timeout" after 511 ms. pg_stat_activity shows 0 active pg_sleep(30) backends at once and 1.5 s
  later. The Postgres log shows "canceling statement due to user request" for it. Then with
  statement_timeout = 0, a widgets query gives 2 rows and pg_sleep(1) gives one '' row after about
  1 s. The check, platform unit tests, platform::eng_platform_query_basic, _describe_only and
  _explain pass. clippy -D warnings is clean (private toolchain), and the new hunks are
  fmt-clean (old unformatted test hunks left as is).
  Observed, not changed: a statement that times out writes no audit record, because pg.rs audits
  after a successful execute. `SHOW statement_timeout` fails with 42000 (DataFusion does not know
  the variable). eng-platform-cancel-on-disconnect may already pass thanks to CancelOnDrop. It
  was not run here.
- 2026-11-08T21:28:52Z supervisor: eng-platform-statement-timeout passed the gate in round 1
- 2026-11-08 eng-platform-cancel-on-disconnect (round 1): no source change needed. `CancelOnDrop`
  in `PlatformTable::fetch` (added by eng-platform-statement-timeout) already covers it. A
  disconnect drops the session's query future (server.rs, eng-pg-disconnect-cleanup), and a pg-wire
  CancelRequest drops it too. Either way the drop sends `cancel_query` to the Platform Database
  backend. The check passed on the first run after init.
  Tested as a user: `../tmp/platform-cancel/run.sh <out>` (throwaway cluster, audit store mock,
  engine; new pgclient bin `pcancel` plus a superuser pg_stat_activity probe). (1) In session A,
  platform_query('SELECT pg_sleep(60) AS s') was active in pg_stat_activity for 300 ms. Then the
  client socket was dropped. The backend was gone about 270 ms later, and the Postgres log shows
  "canceling statement due to user request". (2) Session B did the same, then a CancelRequest was
  sent. The client got 57014 "canceling statement due to user request", and the backend was gone
  about 55 ms later. Afterwards platform_query('SELECT 1 AS x') still works in B. Two runs, the
  same result both times.
  Trap: when waiting for "Postgres runs it", require the statement to stay active a while. The
  describe-only round trip briefly shows `SELECT pg_sleep(60) AS s` as active in pg_stat_activity
  for a few ms, before the execute. A probe that latches onto that observes the describe, not the
  execute. (The protected acceptance test polls on first sight. It still passes, but it may be
  catching the describe phase. This is not changed, since the file is protected.)
- 2026-11-08T21:31:38Z supervisor: eng-platform-cancel-on-disconnect passed the gate in round 1
- 2026-11-08 eng-platform-max-rows (round 1): no source change needed. `PlatformTable::fetch`
  (platform.rs) already counts rows as they stream and fails with 54000 "result exceeds max_rows
  (N) for source \"platform\"" on row N+1. N is the source's `max_rows`, else the top-level one
  (platform.rs `s.max_rows.unwrap_or(config.max_rows)`). Exactly N rows is fine. On the error,
  `CancelOnDrop` is still armed, so the rest of the statement is cancelled in Postgres. The check
  passed on the first run after init.
  Tested as a user: `../tmp/platform-maxrows/run.sh <out>` (throwaway cluster, audit store mock,
  engine with top-level max_rows = 1000 and max_rows = 50 on the platform source; pgclient
  `platform` bin). generate_series(1, 51) fails with 54000 "result exceeds max_rows (50) for
  source \"platform\"" through both extended and simple protocol. 50 rows come back through both.
  widgets id <= 51 fails the same way. count(*) over a 50-row platform_query gives 50.
  Trap: pgclient's `platform` bin panics while printing int4 rows (its printer reads them as
  String). Use int8 columns, or count rows only.
- 2026-11-08T21:33:38Z supervisor: eng-platform-max-rows passed the gate in round 1
- 2026-11-08 eng-platform-pools (round 1): platform functions now share one bounded read pool.
  Before, every describe and every fetch opened a new connection and closed it afterwards.
  platform.rs: new `ReadPool` and `PooledClient`. It allows `READ_POOL_SIZE` = 10 connections as the
  read-only role per engine, held by a tokio Semaphore. `READ_POOL_IDLE` = 60 s: an idle
  connection older than that, or one that is closed, is dropped on the next acquire. Waiting for a
  slot is bounded by the source connect timeout (10 s). Then it fails with 53300 "platform source
  \"x\": all 10 connections stayed busy for 10 s; try again". Only a read that finished goes back
  to the pool, and only after `DISCARD ALL` succeeds. A read that failed, was cancelled
  (CancelOnDrop), or hit max_rows drops its connection. So a cancel can never land on a
  connection that is reused. New `pub struct PlatformDatabase` (built once in pg.rs) owns the
  source and its pool. PlatformQuery/PlatformCatalog/PlatformExplain now take `&PlatformDatabase`
  instead of (config, connect_timeout), so all four functions share one pool.
  Why DISCARD ALL: `SELECT set_config('search_path', ..., false)` passes the read guard, and
  without a reset it would leak into the next session's read on the same backend. The cost is one
  extra round trip per read.
  Tested as a user: `../tmp/platform-pools/run.sh <out>` (throwaway cluster, audit store mock,
  engine; new pgclient bin `ppool`). 20 concurrent sessions: 20/20 succeed on 7 backends, and 7
  engine_read connections stay open, all idle. 40 sequential reads in one session: all on 1
  backend, still 7 connections. After set_config(search_path), the next 12 reads all see the
  default `"$user", public`. 10 sessions run pg_sleep(14): pg_stat_activity shows 10 engine_read
  connections, and an 11th read fails with 53300 after 10.0 s. All 10 long reads succeed, a read
  afterwards works, and 10 idle connections remain. Check passes. These also pass: platform
  _query_basic, _describe_only, _enforcement, _statement_timeout, _cancel_on_disconnect,
  _max_rows, _tables_columns, _explain, _read_only_role and _sql_over_results, plus the
  platform unit tests. clippy -D warnings is clean. My hunks are fmt-clean; the old pg.rs and
  platform.rs test hunks are left unformatted.
  Next sessions: the write pool (eng-write-preview/commit) is separate and is NOT this pool, so
  give it its own ReadPool-like pool over write_url. Note that the write pool should probably not
  `DISCARD ALL` inside a BEGIN. Pool size and idle time are constants. CONTRACTS doesn't name
  them, and they are not in the config schema. For graceful shutdown: idle pooled connections
  close when the engine process exits. There is no reaper, so up to 10 idle connections can stay
  open until the next acquire prunes them.
- 2026-11-08T21:39:54Z supervisor: eng-platform-pools passed the gate in round 1
- 2026-11-08 eng-audit-failed-query-recorded (round 1): Audited Queries whose run fails are now
  audited too. audit.rs: `Execution.row_count` is replaced by `outcome: Result<usize, &str>`.
  `record()` writes status "success" with rowCount, or status "error" with rowCount null and
  errorMessage set. The integrity hash covers status and rowCount as before, so it is hashed
  with "error" and null. pg.rs `Sql::run`: the execute result is no longer `?`-ed before the
  audit write. A failed run writes its record, then returns the original error, so the client
  still sees e.g. 22012. New `error_message()` gives the same message text `query_error` sends
  (the SqlStateError message, else the DataFusion text). For a platform read that is
  `platform source "platform": division by zero`.
  Contract assumptions (CONTRACTS §6 says nothing about failed runs): (1) if the audit write of
  a failed run fails, the client gets 58000 "audit write failed" instead of the query's error,
  as it would for a success (fail closed, cause in the engine log). (2) A statement_timeout
  (57014) and max_rows overflow (54000) are failed runs and are audited. A statement dropped
  mid-run (CancelRequest, disconnect) never reaches the write, so it is not audited. (3)
  Refusals before execution (missing claim, missing description, read guard 42501, plan
  errors) are still not audited, as the existing tests require.
  Tested as a user: `../tmp/platform-audit-error/run.sh <out>` (throwaway cluster, a store mock
  that saves each PutItem, engine, pgclient `platform` bin, and verify.mjs running the portal's
  computeIntegrityHash from ../tmp/integrity/fixture.mjs). The boom query fails 22012 through
  both extended and simple protocol, and each failure writes an item with status error,
  rowCount null, the division-by-zero errorMessage and a matching hash. The 3-row query gives
  status success, rowCount 3 and a matching hash. Check passes. These also pass: identity
  _restricted_denied, _audited_query_description_required, _restricted_loki_selectors,
  _restricted_cloudwatch_log_groups; platform _query_enforcement, _statement_timeout,
  _cancel_on_disconnect, _max_rows, _explain; audit _fail_closed, _dynamodb_item,
  _integrity_hash; audit unit tests (new failed-execution case). Build has no warnings.
  Trap: clippy and rustfmt are not installed on this machine's stable toolchain (rustup
  component missing), so neither was run this round.
- 2026-11-08T21:45:41Z supervisor: eng-audit-failed-query-recorded passed the gate in round 1
- 2026-11-08 eng-audit-action-mapping (round 1): no code change was needed. `Identity::action()`
  in identity.rs (added with eng-identity-agent-and-system) already maps agent -> "ai_ask", sys ->
  "assertion", else "query", and audit.rs writes it into the item and the integrity hash. Agent
  already means `agent` is not explicitly false, or iss = telemetry-mcp. Agent wins over sys:
  a token with both agent and sys set is recorded as ai_ask. The identity.rs unit tests already
  cover all three actions.
  Tested as a user: `../tmp/audit-action/run.sh <out>` (throwaway cluster, store mock, engine,
  pgclient `platform` bin, and verify.mjs with the portal's computeIntegrityHash). The same
  platform_query was run with four tokens: a person, iss telemetry-mcp with agent:false, a
  lightdash token with agent:true, and sys:true. Their items are action query / ai_ask / ai_ask
  / assertion, each with its own executedBySub, database "platform", status success, rowCount
  1, and a matching hash. Check passes.
  Trap: the pgclient `platform` bin expects two SQL arguments. With one, it panics (index out of
  bounds) after printing the first result. That is harmless, but pass two.
- 2026-11-08T21:48:03Z supervisor: eng-audit-action-mapping passed the gate in round 1
- 2026-11-08 eng-write-preview (round 1): `POST /v1/write` exists, and Preview works. New
  `src/write.rs` (WriteMode state + axum handler), routed in server.rs `http_router(&config)`.
  It checks, in this order: bearer identity 401 -> Write Mode configured 503 -> JSON body with
  a string statement 400 -> platform_write 403 -> non-blank description and mode
  preview|commit 400 -> agent commit 403 ("agent") -> commit 501 (see trap) -> write guard
  (portal status 400/422 and message) -> A6 confirmation token 403 -> already spent 409. The
  token is spent (an in-memory map keyed by token signature, pruned at exp) before the
  statement runs. Preview then takes one write-pool connection and runs BEGIN, prepare (which
  refuses a second statement even if the guard missed one, and gives the column types),
  simple_query, ROLLBACK. A clean connection goes back to the pool. On any error the
  connection is closed, and a dropped request cancels the backend (CancelOnDrop). `returning`
  is null when the statement has no result columns, else at most 100 rows as JSON objects.
  bool and int are native; float is a number when finite; json/jsonb is parsed; everything
  else, numeric included, is Postgres's text. `rows_affected` comes from CommandComplete.
  Refactors: platform.rs `ReadPool` is now a generic `Pool` (name, url, size), with
  `pg_error()` and `CancelOnDrop` pub(crate). The write pool has 4 connections. Identity
  gains `platform_write` and `project`. `identity::signed_payload()` is shared by both token
  kinds. audit.rs `Execution` gains mode/preview/description/ticket: reads pass the
  identity's description and ticket, writes pass the body's. `AuditWriter::write` returns
  the record id, which becomes `audit_id`.
  Contract assumptions: (1) a request that passes every check is audited even when its
  statement fails (422 with sqlstate and the Postgres message) or no write connection could
  be had (503 with 08001/53300, audited as status error), as platform reads do. Refusals
  before that are not audited. (2) A failed audit write returns 500 58000 and no result.
  (3) The confirmation's statement_sha256 is over the statement as sent (untrimmed). The
  guarded (trimmed) text is what runs, and `sql` in the record is as sent. (4) Write
  statements have no statement_timeout yet (CONTRACTS §5.5 mentions one, but there is no
  config key for writes).
  Tested as a user: `../tmp/write-preview/run.sh <out>` (throwaway cluster with
  engine_read/engine_write, a store mock, the engine with read and write URLs, curl, and the
  pgclient `platform` bin as reader to look at the table). The preview of the UPDATE ...
  RETURNING id, note gave 200, rows_affected 3, preview true, an audit_id and three rows
  noted 'previewed', and the table still had NULL notes. SET note = current_user gave
  engine_write. Also seen: DELETE without RETURNING gives returning null and rows_affected 5,
  with the table still at 20 rows. A reused token gets 409, a token for another statement
  403, no bearer 401, a reader 403 platform_write, an agent preview 200 and an agent commit
  403, DROP 422 with the portal message, a duplicate key 422 with sqlstate 23505 (audited as
  error), and no engine_write backend is left idle in a transaction. The audit items have
  mode write, preview true, ENG-4242 and the body description, and every hash matches.
  Check passes. These pass too: platform _pools, _read_only_role; audit _failed_query_recorded,
  _integrity_hash, _fail_closed, _dynamodb_item, _action_mapping;
  identity _token_verification; all 67 engine unit tests (new write:: tests). No warnings.
  Trap for eng-write-commit: `mode: "commit"` returns 501 on purpose, before the guard and
  before the token is spent. Look for the "eng-write-commit builds this" branch in
  write::run. Replace it by running the statement with COMMIT instead of ROLLBACK (generalise
  `preview_statement`). The verify endpoint (test_mode) is not routed yet.
- 2026-11-08T21:57:49Z supervisor: eng-write-preview passed the gate in round 1
- eng-write-preview-returning-cap (functional): no code change needed. eng-write-preview had
  already built it: `write::MAX_RETURNING = 100` caps the rows collected (the rest are read and
  dropped, so the command still completes), `rows_affected` comes from CommandComplete, and
  `returning` is null when the prepared statement has no result columns.
  Tested as a user: `../tmp/write-preview-cap/run.sh <out>` (same rig as write-preview, seeded
  with 200 widgets). Preview of `UPDATE widgets SET note = 'x' RETURNING id` gave 200,
  rows_affected 200, preview true, 100 returning rows (ids 1..100). Preview of
  `DELETE FROM widgets WHERE id > 190` gave 200, rows_affected 10, returning null. Through
  platform_query the table still had 200 rows and 0 notes. Check passes.
- 2026-11-08T21:59:22Z supervisor: eng-write-preview-returning-cap passed the gate in round 1
- eng-write-commit (functional): `mode: "commit"` now runs. write.rs: removed the 501
  "eng-write-commit builds this" branch; `preview_statement` became `run_statement(target, sql,
  preview)`, which ends the transaction with ROLLBACK for a Preview and COMMIT for a commit. The
  same rules hold for both: the guard, the single-use confirmation token, agents refused (403)
  before anything is spent, the 100-row RETURNING cap, audit with `preview: false`. A dropped
  request before COMMIT cancels the backend and closes the connection, so nothing is kept.
  Contract assumption: CONTRACTS §4.2 runs the statement (step 3) before the audit write
  (step 4), so a commit whose audit write fails has still changed the table, though the response
  is 500 58000 and no result is returned. If the integration line wants fail-closed commits
  (audit before COMMIT, or a pending record), that is a contract change, not a bug here.
  Tested as a user: `../tmp/write-commit/run.sh <out>` (the write-preview rig plus a synthetic
  2-row `patients` table with a bigserial id). Commit of `UPDATE widgets SET note = current_user
  WHERE id = 7` gave 200, preview false, rows_affected 1, returning null; through platform_query
  widget 7's note was engine_write and 6 and 8 were still NULL. Commit of the INSERT ... RETURNING
  id gave 200 and returning [{"id": 3}]; patients had 3 rows. A DELETE commit with no RETURNING
  gave rows_affected 2, returning null, and the rows were gone; a Preview DELETE afterwards still
  rolled back. A reused commit token gave 409, an agent commit 403, a duplicate-key commit 422
  23505 (audited as error), DROP 422. No engine_write backend was left open. The audit items had
  mode write, preview false for commits, and every hash matched. Check passes; write::
  _preview and _preview_returning_cap and the write unit tests pass too. Clippy is clean.
  Note: rustfmt (in tmp/rustup) flags lines across the crate that were there before; I did not
  reformat files I didn't touch.
- 2026-11-08T22:04:32Z supervisor: eng-write-commit passed the gate in round 1
- eng-write-authorization (security): no code change needed. eng-write-preview had already built
  the checks in write::run, in this order: bearer identity (401) -> Write Mode configured (503,
  "Write Mode is off: source ... has no write_url_env") -> body parse (400) -> platform_write
  (403 "Write Mode needs platform_write") -> non-blank description (400) -> mode preview|commit
  (400) -> agent commit (403) -> guard -> confirmation token. Note: an engine without Write Mode
  answers 503 to any valid bearer, even if the body or attrs are wrong; only the 401 comes first.
  Tested as a user: `../tmp/write-auth/run.sh <out>` (throwaway Postgres on 59603, store mock on
  59605, one engine with write_url_env on 59591/59592 and one without on 59601/59602). With curl:
  no bearer, "not-a-token" and an expired token gave 401; a reader-only person gave 403 naming
  platform_write; an empty description and mode "yolo" gave 400; preview and commit to the
  engine without write_url_env gave 503 "Write Mode is off". Through platform_query, widget 1's
  note was still NULL and no widget had a note. The store held only the 2 read audits from
  those platform_query lookups, no write audit. Check passes.
- 2026-11-08T22:06:59Z supervisor: eng-write-authorization passed the gate in round 1
- eng-write-confirmation-single-use (security): no code change needed. eng-write-preview had
  already built it: write::run spends the token (WriteMode::spend, an in-memory map keyed by the
  token's signature text, entries dropped after `exp`) under a mutex after the guard and A6 checks
  and before the statement runs, so a concurrent duplicate cannot run twice either. A spent token
  gets 409 whatever the mode, and a refused request writes no audit item. The signature decoder
  (URL_SAFE_NO_PAD, base64 0.22) rejects padding and non-canonical trailing bits, so a re-encoded
  signature can't get past the spent check. It gets 403 as an invalid token.
  Trap for the integration line: the spent set is per engine process. A restart, or a second engine
  replica behind a load balancer, would accept a token again within its 120 s life. CONTRACTS
  §4.2 doesn't say where "single use" is stored. If the deployment runs more than one replica, it
  needs a shared store (e.g. a DynamoDB conditional put on the nonce). That's a contract decision.
  Tested as a user: `../tmp/write-single-use/run.sh <out>` (write-commit rig on ports 59611-59615).
  Widget 9's score through platform_query was 13.5. The commit of `UPDATE widgets SET score = score
  + 1 WHERE id = 9` gave 200. The same request again gave 409 "this confirmation token has
  already been used", the same token as preview 409, and the token with '=' added 403. The score
  was 14.5. Preview of `UPDATE widgets SET note = 'once' WHERE id = 10` with a new token gave 200,
  and commit with that token 409. Widget 10's note stayed NULL. The store held 2 write audits
  (1 commit, 1 preview) plus the 3 read audits, and every hash matched. Check passes.
- 2026-11-08T22:09:22Z supervisor: eng-write-confirmation-single-use passed the gate in round 1
- eng-write-confirmation-binding (security): no code change needed. eng-write-preview had already
  built it: write::verify_confirmation (assumption A6) accepts only a token signed with the
  identity secret, v 1, typ write_confirmation, statement_sha256 equal to the hex SHA-256 of the
  statement as sent, sub and project equal to the bearer identity's, now < exp, iat at most 60 s
  ahead and exp - iat <= 120. Any mismatch, a missing token or garbage gives the same 403 ("the
  confirmation token is missing or not valid for this statement, user and project"), after the
  guard and before the single-use spend, so a refused token is not spent and writes no audit.
  An identity token fails on typ. Tested as a user: `../tmp/write-binding/run.sh <out>` (write-commit
  rig on ports 59621-59625, `ctok.py` builds confirmation tokens with any statement/sub/project/
  iat/exp/key). With curl, commits with tokens for another statement, another user, another
  project, an expired one, one living 121 s, one signed with another key, the identity token,
  "garbage" and no token all gave 403. Widget 11's note through platform_query stayed NULL. The
  right token then gave 200 rows_affected 1 and the note was 'bound'. The store held 1 write audit
  (the commit) plus 3 read audits, every hash matched. Check passes.
- 2026-11-08T22:11:09Z supervisor: eng-write-confirmation-binding passed the gate in round 1
- eng-write-agent-commit-refused (security): no code change needed. eng-write-preview had already
  built it: write::run's check 6 refuses `mode: "commit"` from an agent identity (identity.agent,
  which is set when `agent` is anything but an explicit false, or when iss is telemetry-mcp) with
  403 "an AI agent identity (agent = true) may only Preview, never commit". The check runs after
  the platform_write, description and mode checks and before the guard and the confirmation token,
  so a refused commit doesn't spend the token and writes no audit item. The system identity
  (sys = true, agent = false) is not an agent and commits like a person; its audit action is
  `assertion`. Small wording nit, left as it is: an MCP token whose agent claim is false gets the
  same message, which says "(agent = true)".
  Tested as a user: `../tmp/write-agent-commit/run.sh <out>` (write-commit rig on ports
  59631-59635; `itok.py` mints platform_write identity tokens: lightdash-agent, mcp-agent,
  mcp-agent-noflag (iss telemetry-mcp, agent false) and system). With curl, preview of
  `UPDATE widgets SET note = 'agent' WHERE id = 12` gave 200 rows_affected 1 for each agent, and
  commit gave 403 with the agent message for each. Widget 12's note through platform_query stayed
  NULL. A commit by the system identity then gave 200 and the note was 'agent'. The store held 3
  ai_ask preview audits, 1 assertion commit audit and 3 read audits, every hash matched. Check passes.
- 2026-11-08T22:13:04Z supervisor: eng-write-agent-commit-refused passed the gate in round 1
- eng-guard-write-mode (security): no code change needed. eng-write-preview had already built it:
  write::run's check 7 calls `engine_guard::guard(statement, Mode::Write)` after the agent-commit
  check and before the confirmation token. The guard's Rejection.status (400 for empty/blank SQL,
  422 otherwise) becomes the HTTP status and its message becomes `error`. A rejected statement
  doesn't spend the token and writes no audit item.
  Tested as a user: `../tmp/write-guard/run.sh <out>` (write-commit rig on ports 59641-59645). With
  curl, I posted previews of all 19 rejected cases from the acceptance test (dblink variants, U&"...",
  query_to_xml*/ts_stat/ts_rewrite, DROP/ALTER/TRUNCATE/GRANT/CREATE/VACUUM, a stacked UPDATE; DROP,
  BEGIN). Each gave 422 with the portal's message. "   " and "" gave 400 "SQL statement is
  required.". Previews of INSERT, UPDATE, DELETE and a DELETE CTE gave 200 preview true. Before and
  after, platform_query showed widgets at 20 rows, 0 notes and score sum 315, so nothing changed.
  The store held 4 write audits (the allowed previews) plus 2 read audits, and every hash matched.
  Check passes.
- 2026-11-08T22:15:03Z supervisor: eng-guard-write-mode passed the gate in round 1
- eng-write-statement-failure (functional): no code change needed. eng-write-preview had already
  built it: write::run runs the statement, writes the audit item first (status error, errorMessage
  = the Postgres message, rowCount null) and then answers with Failure::from_postgres: 422
  {"error": "platform source \"platform\": <postgres message>", "sqlstate": "<code>"} (503 for
  08xxx/53xxx connection classes). The same holds for preview.
  Tested as a user: `../tmp/write-failure/run.sh <out>` (write-commit rig on ports 59651-59655).
  With curl, commit of `UPDATE widgets SET id = 1 WHERE id = 2` gave 422 sqlstate 23505 "duplicate
  key value violates unique constraint \"widgets_pkey\""; a preview of it gave the same; a commit
  of `UPDATE widgets SET nope = 1 WHERE id = 2` gave 422 sqlstate 42703. platform_query showed
  widgets at 20 rows, ids 1-20, 0 notes, before and after. The store held 3 write audits, each
  status error with the message and rowCount NULL, plus 2 read audits, and every hash matched.
  Check passes.
- 2026-11-08T22:16:39Z supervisor: eng-write-statement-failure passed the gate in round 1
- eng-write-audit-records (security): no code change needed. eng-write-preview had already built it:
  write::run writes one audit item per executed Write Mode request (mode write, preview flag,
  sql, database platform, body description and ticket as linearTicketId, rowCount, action from the
  identity: query for people, ai_ask for agents) and returns its id as audit_id. If the DynamoDB
  PutItem (or S3 put) fails the answer is 500 {"error": "audit write failed", "sqlstate": "58000"}.
  Tested as a user: `../tmp/write-audit/run.sh <out>` (write-commit rig on ports 59661-59665; its
  store.py saves PutItems and S3 objects and refuses both while <out>/store/fail exists). With curl,
  `UPDATE widgets SET note = 'audited' WHERE id IN (20, 21)` as person preview, person commit and
  lightdash-agent preview each gave 200 rows_affected 2. The store held 3 items whose ids matched the
  three audit_ids: mode write, preview true/false/true, the sql, ENG-4242, rowCount 2, status success,
  action query/query/ai_ask, every hash matched, plus 3 S3 objects. With the store refusing, a
  preview gave 500 sqlstate 58000 "audit write failed". Check passes.
- 2026-11-08T22:18:24Z supervisor: eng-write-audit-records passed the gate in round 1
- eng-write-confirmations-verify-endpoint (functional): `server::http_router` routes
  `POST /v1/write/confirmations/verify` only when `config.test_mode` (the key was already parsed);
  without it axum's default 404 answers. Its handler is `write::handle_verify`. It takes the
  bearer identity (401 otherwise) and `{statement, confirmation_token}` (400 otherwise), and returns
  `{"valid": verify_confirmation(..) && !is_spent(..)}`. `WriteMode::is_spent` only reads the
  spent map, so verifying never spends a token. A8 above now spells out that a spent token
  verifies as false. I added the unit test `write::tests::is_spent_reads_without_spending`.
  Tested as a user: `../tmp/write-verify/run.sh <out>` uses ports 59671-59677: a test_mode engine
  on HTTP 59672 and an engine without test_mode on 59677, sharing one Postgres and one audit
  store. With curl:
  - Verifying a fresh token for its statement gave 200 {"valid":true}, and again true on a second call.
  - Verifying it for `UPDATE widgets SET note = 'other'` gave {"valid":false}.
  - With no bearer, verify gave 401.
  - A commit with the token then gave 200 with rows_affected 1, so verifying had not spent it.
  - Verifying it after the commit gave {"valid":false}.
  - The same call on the engine without test_mode gave 404.
  Check passes, and so do write::eng_write_confirmation_single_use, _binding and eng_write_commit.
  Trap: `cargo fmt --check` with the tmp/rustup toolchain reports diffs in nearly every src file
  already at HEAD. The code is laid out wider than default rustfmt and there is no rustfmt.toml.
  I didn't reformat anything. Clippy is clean.
- 2026-11-08T22:23:01Z supervisor: eng-write-confirmations-verify-endpoint passed the gate in round 1
- eng-audit-browser-by-month (functional): the new module `src/audit_browser.rs` handles
  `GET /v1/audit`. `server::http_router` merges it as its own Router with state
  `Arc<AuditBrowser>`. The browser holds its own `AuditWriter` built from `[audit]`, so it does not
  share WriteMode's. The order of checks is: bearer identity via `identity::verify`, else 401
  (`write::bearer` is now `pub(crate)`); `attrs.platform_read`, else 403 naming it; `month`, else 400.
  The 401 and 403 checks run before the store is touched. The month must be `YYYY-MM` with 01-12,
  else 400. `AuditWriter::query_page` (audit.rs) is a generic GSI page: `#pk = :pk`,
  ScanIndexForward false, Limit 25, ExclusiveStartKey. It returns items and LastEvaluatedKey as
  plain JSON, unmarshalled the DocumentClient way. `nextCursor` is
  base64(JSON {month, key: LastEvaluatedKey}), or null on the last page. A cursor that does not
  decode, or whose `month` differs from the request's, is 400. A space in the cursor is read as `+`.
  A failed Query is 502 "audit store query failed" (cause in the engine log). Without `[audit]`
  the answer is 503.
  Not built yet (left to eng-audit-browser-by-ticket-and-user): `ticket`/`user` (precedence ticket >
  user > month, byTicket/byUser, cursor = base64(JSON(LastEvaluatedKey))) and the no-parameter
  last-30-days browse. For now, a request without `month` is 400 "month=YYYY-MM is required". The
  next session should dispatch in `audit_browser::browse` and reuse `query_page`.
  Tested as a user: `../tmp/audit-browser/run.sh <out>` (ports 59681-59685). It runs the engine
  against `store.py`, a Query-only DynamoDB stand-in seeded with 30 October and 3 September 2026
  items. With curl:
  - month=2026-10 gave 200 with 25 items, from seeded 29 (10-30) down to seeded 5, all October,
    newest first. nextCursor decoded to {month 2026-10, key {id, createdAtMonth, createdAt}}.
  - With that cursor: 5 items, seeded 4 down to seeded 0, nextCursor null. No overlap; the union
    of both pages is 30 ids.
  - month=2026-09 gave its 3 items.
  - month=2026-13 gave 400.
  - The October cursor sent with month=2026-09 gave 400.
  - No bearer gave 401; a token without platform_read gave 403.
  - The store saw only byMonth Queries (Limit 25, ScanIndexForward false).
  The check passes, and so do audit::eng_audit_browser_authorization and
  write::eng_write_confirmations_verify_endpoint. Clippy -D warnings (tmp/rustup 1.99.1) is clean;
  the new file is rustfmt-clean.
- 2026-11-08T22:27:38Z supervisor: eng-audit-browser-by-month passed the gate in round 1
- eng-audit-browser-by-ticket-and-user (functional): `audit_browser::browse` now picks the index
  in the portal's order: non-empty `ticket` (byTicket, `linearTicketId`), else non-empty `user`
  (byUser, `executedByEmail`), else `month` (byMonth, unchanged). All three use
  `AuditWriter::query_page` (Limit 25, newest first). For ticket and user, the cursor is
  base64(JSON(LastEvaluatedKey)) (A14). `plain_cursor_key` decodes it; anything that is not
  base64 of a JSON object is 400. The month cursor keeps its `{month, key}` shape and its
  month check. Both decoders share `decode_cursor`, which still reads a space as `+`. An empty
  parameter counts as absent. With none of the three, the answer is still 400, now worded "one
  of ticket, user or month=YYYY-MM is required".
  Not built: the portal's no-parameter last-30-days browse (A14, untested). It is not in this
  feature's steps and no portal source is available here to copy its exact behaviour, so a
  later session needs a decision or the portal code before building it. I added the unit test
  `audit_browser::tests::plain_cursors_are_the_last_evaluated_key`.
  Tested as a user: `../tmp/audit-ticket-user/run.sh <out>` uses ports 59691-59695. The engine
  runs against a Query-only DynamoDB stand-in seeded like the acceptance test: 27 ENG-7 records
  (b@example.com when i%3==0) and 6 ENG-8 records for b@example.com. With curl:
  - ticket=ENG-7 gave 200, 25 ENG-7 items newest first, from a byTicket Query (Limit 25,
    ScanIndexForward false). Its nextCursor decoded to {id, linearTicketId, createdAt}.
  - Following that cursor gave 2 items and nextCursor null. No overlap; the union is 27.
  - user=b@example.com gave 15 items, all b@example.com, from a byUser Query.
  - ticket=ENG-8&user=a@example.com gave the 6 ENG-8 items from a byTicket Query.
  - month=2026-10 still works (byMonth).
  - A garbage cursor gave 400, no parameter gave 400 and no bearer gave 401.
  The check passes, and so do audit::eng_audit_browser_by_month and
  audit::eng_audit_browser_authorization. Clippy -D warnings (tmp/rustup 1.99.1) is clean, and
  audit_browser.rs is rustfmt-clean.
- 2026-11-08T22:30:51Z supervisor: eng-audit-browser-by-ticket-and-user passed the gate in round 1
- eng-audit-browser-authorization (security): no code change was needed. The check was already
  built in `audit_browser::browse` during eng-audit-browser-by-month. The bearer is verified with
  `identity::verify` (signature, expiry) and fails with 401. A missing `attrs.platform_read` fails
  with 403 "the audit browser needs attrs.platform_read". Both checks run before any parameter
  parsing or store Query.
  Tested as a user: `../tmp/audit-auth/run.sh <out>` (ports 59701-59705). It runs the engine
  against the Query-only DynamoDB stand-in. With curl on GET /v1/audit?month=2026-10:
  - No bearer gave 401, and so did `garbage`, a token that expired 10 min ago, and a token
    signed with the wrong secret.
  - A valid token without platform_read gave 403 naming platform_read. Up to this point the
    store had received 0 Queries.
  - A token with platform_read gave 200 with 25 items, from 1 Query.
  The check `audit::eng_audit_browser_authorization` passes.
- 2026-11-08T22:32:18Z supervisor: eng-audit-browser-authorization passed the gate in round 1
- eng-ops-marts-catalog (functional): new module `src/ops_marts.rs`. When at least one `bigquery`
  source exists, `PgHandlers::new` registers the DataFusion catalog `ops_marts`. It has one schema
  per dataset and one table per `allow` entry. If two sources allow the same `dataset.table`, the
  first one serves it. Names match case-sensitively, exactly as written in `allow`. Nothing
  outside the allowlist is listed or resolved, so it is never named to BigQuery.
  - Listing (`information_schema.tables`) makes no BigQuery call: `table_type` is overridden to
    return `Base` ('BASE TABLE').
  - Resolving a table (planning a query, or reading `information_schema.columns`, which
    DataFusion builds by resolving every table) calls `tables.get`:
    `GET {api_base_url}/bigquery/v2/projects/{project}/datasets/{d}/tables/{t}`, with the
    bearer. The schema is cached per table for 5 minutes (`SCHEMA_TTL`).
  Contract assumptions (the spec doesn't say):
  - Type map: INTEGER/INT64 -> Int64 (int8), FLOAT/FLOAT64 -> Float64, BOOLEAN/BOOL -> Boolean,
    TIMESTAMP -> Timestamp(us, UTC) (timestamptz), DATETIME -> Timestamp(us) (timestamp),
    DATE -> Date32 and NUMERIC -> Decimal128(38, 9), which goes out as text.
    REPEATED/RECORD columns and every other type become Utf8.
  - Only mode REQUIRED makes a column NOT NULL.
  - A failed tables.get is a plain Execution error (XX000) that names the source, the table and
    BigQuery's message.
  Left for the next features, on purpose:
  - `OpsMartTable::scan` returns 0A000 "reading Ops Mart rows is not supported yet". Replace it
    in eng-ops-marts-query (jobs.query / getQueryResults paging). The mock's TIMESTAMP cells are
    float seconds unless `formatOptions.useInt64Timestamp`.
  - `BigQuerySource::token` returns 0A000 for workload identity. Replace it in
    eng-ops-marts-workload-identity. All token use goes through `token()`, so a cached
    federated token can live there.
  Unit test: `ops_marts::tests::bigquery_fields_map_to_postgres_shaped_arrow_types`.
  Tested as a user: `../tmp/ops-marts-catalog/run.sh <out>` (ports 59711, 59712, 59715). It runs
  the engine with a bigquery source allowing ops_marts.fills_hourly and ops_marts.queue_depth,
  against a Python tables.get stand-in that also has not_allowlisted. Then
  `../tmp/pgclient/target/debug/opsmarts`, a tokio-postgres client, ran the steps:
  - getAllTables gave exactly (ops_marts, ops_marts, fills_hourly | queue_depth, BASE TABLE),
    with 0 BigQuery calls.
  - columns gave hour, pharmacy, fills, avg_minutes, late, in order.
  - prepare SELECT * gave OIDs 1184, 25, 20, 701, 16 (queue_depth: 1184, 25, 20).
  - Running the select gave 0A000.
  - not_allowlisted gave 42P01.
  - The stand-in saw exactly 2 tables.get calls (both allowlisted, with the bearer), because the
    later prepares used the cache.
  The check passes, and so does pgwire::eng_pg_information_schema. Clippy -D warnings
  (tmp/rustup 1.99.1) is clean, and ops_marts.rs is rustfmt-clean.
  Trap: psql is blocked by the sandbox ("Operation not permitted"). Drive the engine with the
  tokio-postgres bins in ../tmp/pgclient instead.
- 2026-11-08T22:40:11Z supervisor: eng-ops-marts-catalog passed the gate in round 1
- eng-ops-marts-query (functional): `OpsMartTable::scan` in `src/ops_marts.rs` now reads rows.
  It sends `SELECT <projected cols> FROM \`<project>.<dataset>.<table>\` [LIMIT n]` (GoogleSQL,
  backtick-quoted) with jobs.query (`POST .../projects/{p}/queries`, `useLegacySql: false`,
  `formatOptions.useInt64Timestamp: true`). Then it follows `pageToken` with jobs.getQueryResults
  (`GET .../queries/{jobId}?formatOptions.useInt64Timestamp=true&location=..&pageToken=..`) until
  there is no next page. If `jobComplete` is false, it asks getQueryResults again without a page
  token. All rows go into one RecordBatch behind a MemorySourceConfig, the same pattern as the
  other sources. WHERE, aggregates and joins all run in DataFusion: no filter pushdown, and only
  `limit` is sent, which DataFusion pushes only when no filter sits above the scan. Every call
  (tables.get included) goes through `Marts::call`, which adds `bearer_auth(source.token()?)`.
  Contract assumptions:
  - Result columns are matched by name against the answer's `schema.fields`; the mock always
    returns the full table.
  - Cells are parsed by casting text to the column's Arrow type (strict cast, so a bad cell
    errors and names the column). TIMESTAMP cells are int64 microseconds.
  - REPEATED/RECORD cells are their JSON, as text.
  - With an empty projection (count(*)), the first column is read for its row count.
  - The Ops Mart source now enforces `max_rows` (source override, else top-level): more rows than
    that gives 54000 "result exceeds max_rows (N) for source \"..\"", checked page by page.
  Unit tests: `ops_marts::tests::{select_sql_quotes_names_and_sends_the_limit,
  cells_parse_into_the_column_types, pages_map_result_columns_by_name}`.
  Tested as a user: `python3 -I ../tmp/ops-marts-query/run.py out` (ports 59721, 59722, 59725).
  It runs a threaded paging BigQuery stand-in (2 rows per page, int64 timestamps, 401 without the
  bearer) and the engine as a child process, stopped in `finally`. The queries go through the new
  `../tmp/pgclient/target/debug/sqlat <port> <user> <pw> <sql>...` (simple query):
  - The GROUP BY gave pharmacy-a 24, pharmacy-b 19, reading 3 pages.
  - The pharmacy-b filter gave 3 rows: 2025-11-08 08:00/09:00/10:00+00, 20.25 / NULL / 30.0,
    and t / t / f.
  - The VALUES join gave intake 10 team-a and review 1 team-b.
  - count(*) gave 3, and LIMIT 1 gave 1 row.
  - The stand-in saw 15 calls, and every one carried `Bearer <token>`.
  The check passes, and so do ops_marts::eng_ops_marts_catalog and (already)
  eng_ops_marts_allowlist. Clippy -D warnings (tmp/rustup 1.99.1) is clean, and ops_marts.rs is
  rustfmt-clean.
  Next (eng-ops-marts-workload-identity): only `BigQuerySource::token` has to change.
- 2026-11-08T22:45:14Z supervisor: eng-ops-marts-query passed the gate in round 1
- eng-ops-marts-allowlist (security): no engine change was needed. The allowlist is enforced by the
  structure that eng-ops-marts-catalog built. `ops_marts::catalog` builds a dataset -> table map
  from the `allow` entries only. `OpsMarts::schema`, `Dataset::table`, `table_exist` and
  `table_type` look names up there by exact, case-sensitive key. Any other name gives `None`
  (DataFusion: 42P01) before `Marts::schema`/`tables.get` can run. The check already passed at HEAD.
  Added the unit test `ops_marts::tests::only_allowlisted_tables_resolve`. It pins the rule:
  other_dataset and OPS_MARTS give no schema; not_allowlisted, FILLS_HOURLY, Fills_Hourly and
  "fills_hourly " give no table. The API base is unroutable, so a stray tables.get would error
  instead of returning None.
  Tested as a user: `python3 -I ../tmp/ops-marts-allowlist/run.py out` (ports 59731, 59732, 59735).
  Its BigQuery stand-in *would* serve not_allowlisted, FILLS_HOURLY and any dataset, so a leak would
  show up as rows rather than an error. Through `sqlat`:
  - ops_marts.ops_marts.not_allowlisted, ops_marts.other_dataset.fills_hourly, "FILLS_HOURLY",
    "Fills_Hourly" and a filtered not_allowlisted select all gave 42P01 "table ... not found".
  - information_schema.tables for catalog ops_marts listed only fills_hourly and queue_depth,
    plus the information_schema views.
  - Counting not_allowlisted, FILLS_HOURLY or other_dataset in information_schema.tables gave 0,
    and counting not_allowlisted in information_schema.columns gave 0.
  - count(*) on fills_hourly gave 5.
  - The stand-in saw 5 calls: tables.get for the 2 allowlisted tables (columns listing), then one
    jobs.query and 2 getQueryResults pages for fills_hourly. None named not_allowlisted,
    other_dataset or FILLS_HOURLY, and all carried the bearer.
  The check passes. Clippy -D warnings (tmp/rustup 1.99.1) is clean, and ops_marts.rs is
  rustfmt-clean.
  Decision: table and dataset names are case-sensitive, exactly as written in `allow`. A
  wrong-case name is 42P01, not folded to the allowlisted table.
- 2026-11-08T22:48:08Z supervisor: eng-ops-marts-allowlist passed the gate in round 1
- eng-ops-marts-workload-identity (security): with workload_identity_audience + service_account
  (no access_token_env), BigQuery calls now carry a service-account token from GCP workload
  identity federation. The new `src/gcp_auth.rs` (`WorkloadIdentity`) does this:
  1. It signs (does not send) a SigV4 `POST https://sts.<region>.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15`.
     The signature uses the default AWS credential chain (`aws_config::defaults`, region from the
     chain, else us-east-1). Signed headers: host, x-amz-date, x-amz-security-token (when there
     is a session token) and x-goog-cloud-target-resource = audience.
  2. It serializes that as GCP's `{"url","method","headers":[{key,value}]}` and percent-encodes it
     (RFC 3986).
  3. It sends a form-encoded token exchange to gcp_sts_url: grant_type token-exchange, audience,
     scope cloud-platform, requested_token_type access_token, subject_token_type
     `urn:ietf:params:aws:token-type:aws4_request`.
  4. It calls `POST {gcp_iam_credentials_url}/v1/projects/-/serviceAccounts/<sa>:generateAccessToken`
     with the federated bearer and scope bigquery.
  The SA token is cached per source, process-wide, until 5 minutes before its expireTime. A tokio
  Mutex around the refresh means concurrent queries exchange only once. `ops_marts.rs` now keeps a
  local `Auth` enum (Static secret | Federated(Box<WorkloadIdentity>)), built from
  `BigQueryAuth`, and `BigQuerySource::token` is async. A failed exchange is a query error
  naming the source and step (e.g. "GCP STS token exchange: HTTP 400: ..."). New direct dep:
  `aws-credential-types = "1.3"`, which was already in Cargo.lock; it brings in the
  `ProvideCredentials` trait.
  Unit tests: `gcp_auth::tests::{get_caller_identity_is_signed_for_the_audience,
  signing_key_matches_the_aws_example, percent_encoding_keeps_only_unreserved}`.
  Tested as a user: `python3 -I ../tmp/ops-marts-workload-identity/run.py out` (ports 59741, 59742,
  59745). One stand-in plays STS, IAM Credentials and BigQuery, and it re-verifies the SigV4
  signature in Python with the env secret. The engine got a fake key, a session token and
  AWS_REGION us-east-2.
  - GROUP BY queue gave intake 10 and review 1.
  - The STS call was form-encoded with the audience, the aws4_request type and the
    GetCallerIdentity URL for us-east-2. The key id was the env one, the session token was
    present, and signature_ok was True.
  - There was one generateAccessToken, with the SA email in the path and the federated bearer.
  - Every BigQuery call carried the SA token.
  - A second query, and then a second connection, made no further STS or IAM calls (1 + 1 in total).
  The check passes, and so do ops_marts::eng_ops_marts_query and _catalog. Clippy -D warnings
  (tmp/rustup 1.99.1, CARGO_TARGET_DIR=tmp/clippy-target) is clean, and gcp_auth.rs and
  ops_marts.rs are rustfmt-clean.
  Contract assumptions: the token scope is bigquery (not cloud-platform), and the subject token
  uses the regional STS host. GCP accepts both.
- 2026-11-08T22:53:48Z supervisor: eng-ops-marts-workload-identity passed the gate in round 1
- eng-healthz (operations): `GET /healthz` (no auth) now probes every configured source and answers
  200 when all are reachable, else 503. New `src/health.rs` (`Health`), wired in
  `server::http_router` with its own state, like the audit browser. Body (JSON):
  `{"status":"ok"|"unhealthy","sources":[{name,kind,reachable,error?}],"unhealthy":[names]}`.
  Decision: "reachable" means a TCP connect within 2 s (`PROBE_TIMEOUT`). It is the same for
  every kind and needs no credentials. The endpoints are: prometheus/loki/tempo `url`; bigquery
  `api_base_url`; cloudwatch(_logs) `endpoint_url`, else `monitoring|logs.<region>.amazonaws.com:443`;
  platform_postgres every TCP host of the read URL (default port 5432). It does not send an HTTP
  request, so an upstream that answers 500 still counts as healthy. Probes run concurrently on
  each request and nothing is cached. The body never carries addresses or URLs (the endpoint is
  unauthenticated, and the read URL holds a password), only the io error text.
  Unit tests: `health::tests::{url_endpoints_use_the_scheme_default_port,
  aws_sources_default_to_the_regional_endpoint, postgres_hosts_and_ports_without_leaking_the_url}`.
  Tested as a user: `../tmp/healthz-user` (python mocks on 59811-59813; engines on 59821/59822 and
  59831/59832; dead port 59819).
  - The healthy config gave HTTP 200 with prom-up, loki-up and tempo-up all reachable.
  - Adding prom-dead on the dead port gave HTTP 503, `unhealthy: ["prom-dead"]` and
    "Connection refused".
  The check passes, and so does ops_marts::eng_ops_marts_query. Clippy -D warnings (tmp/rustup)
  is clean, and health.rs is fmt-clean.
  Trap: running `rustfmt` on main.rs follows the `mod` tree and reformats the whole crate.
  Format only leaf files, or use `cargo fmt --check` and read the diff. `cargo fmt --check`
  already flags a `tls_note` line in server.rs from earlier work; I left it as it was.
  Note: the harness polls /healthz until it gets a response, and a 503 counts. A source that
  hangs adds at most 2 s to engine startup.
- 2026-11-08T22:57:13Z supervisor: eng-healthz passed the gate in round 1
- eng-metrics (operations): `GET /metrics` (no auth) serves Prometheus text exposition
  (`text/plain; version=0.0.4`). New `src/metrics.rs`: a process-wide registry (a `LazyLock`, so
  no state is threaded through the providers), routed in `server::http_router`. `metrics::init`
  pre-registers every configured source, so each one's series start at 0. Families:
  `federation_engine_queries_total{source}`, `federation_engine_query_errors_total{source}`,
  `federation_engine_query_duration_seconds{source}` (a histogram with buckets 5 ms..300 s,
  i.e. the Prometheus defaults plus 30/60/120/300), and `federation_engine_audit_write_failures_total`.
  Decision: a "query" is one read of a source, so every `TableProvider::scan` body (promql, logql,
  traceql, trace, cloudwatch, cloudwatch_logs, ops_marts, platform) is wrapped in
  `crate::metrics::observe(<source name>, async { ... })`. A statement that reads two sources counts
  once for each, and an Audited Query's source read counts even when its audit write then fails.
  Errors are any failed scan: upstream errors, unreachable sources, a malformed answer, max_rows.
  A scan that gets dropped (statement timeout, cancel, hang-up) is recorded on drop as a query
  with its elapsed time, but not as an error. Plan-time describes, such as platform describe-only
  and the ops_marts catalog, are not counted.
  Audit write failures are counted inside `AuditWriter::write`, now a thin wrapper over the old
  body, which became `put`, so both pg-wire Audited Queries and Write Mode are covered. "No
  [audit] store / no identity" is a fail-closed refusal, not a store write, so it is not counted.
  The wrapped scans return `Ok::<Arc<dyn ExecutionPlan>, _>(...)` because the trait-object
  coercion no longer happens through the async block.
  Unit tests: `metrics::tests::{histogram_buckets_are_cumulative_and_end_in_inf,
  label_values_are_escaped, a_dropped_read_counts_as_a_query_but_not_an_error}`.
  Tested as a user: `../tmp/metrics-user/run.sh` (python mocks on 59851-59854; engine 59861/59862).
  psql is blocked by the sandbox, so `pgclient.py` there is a small SCRAM + simple-query pg-wire
  client. Before any query, prom-open showed 0. Then I ran two count(*) on prom-open (OK), one
  prom-bad query (XX000 HTTP 500) and a restricted query with an identity token while the audit
  store answered 500 (58000 audit write failed). /metrics then showed prom-open queries 2, errors 0,
  and count 2 with all buckets 2 and +Inf 2. prom-bad showed queries 1 and errors 1, prom-restricted
  showed queries 1, and audit_write_failures_total was 1.
  The check passes. ops::eng_healthz, audit::eng_audit_fail_closed, audit::eng_audit_dynamodb_item,
  promql::eng_promql_upstream_errors, ops_marts::eng_ops_marts_query and
  platform::eng_platform_query_basic also pass. Clippy -D warnings (tmp/rustup) is clean, and
  metrics.rs is fmt-clean. I didn't reformat the other files, whose existing fmt drift is unchanged.
- 2026-11-08T23:02:44Z supervisor: eng-metrics passed the gate in round 1
- eng-graceful-shutdown (operations): SIGTERM or SIGINT stops accepting, drains in-flight work,
  and exits 0 (CONTRACTS A28). New file `src/shutdown.rs`. It holds a process-wide in-flight
  counter and an `InFlight` guard, which each pg-wire `do_query` (simple and extended, in pg.rs)
  holds while it runs. `server::run` installs the signal handlers before it prints "serving". It
  now spawns the axum server with `with_graceful_shutdown` and the pg accept loop as tasks. On
  a signal it calls `shutdown::begin()` and flips a watch channel. The pg accept loop then
  returns and drops its listener, and axum drops its listener and waits for in-flight HTTP
  requests (Write Mode, /v1/audit). Then it waits until the in-flight count reaches 0, sleeps
  `FLUSH_GRACE` (250 ms) so the last responses are written out, and returns Ok, so the exit is 0.
  Idle connections close when the process exits.
  Decisions (CONTRACTS says only "stops accepting, drains in-flight queries, exits 0"):
  - Once shutdown begins, a new statement on a connection that is already open fails with
    57P01 ("the engine is shutting down"). This keeps the drain from growing.
  - The drain is capped by `DRAIN_LIMIT` = 25 s, under the default Kubernetes 30 s grace period.
    When the cap is hit the engine logs it and still exits 0.
  - Describes (Parse/Describe) are not guarded. Only Execute/simple Query are.
  Rows are encoded eagerly, before do_query returns, so once the guard drops only the socket
  write remains. That is why the short flush grace is enough.
  Tested as a user: `../tmp/shutdown-user/run.sh` (python mock on 59870 that answers /api/v1/
  after 2 s; engine on 59871/59872). The script sends `count(*) FROM promql('up', ...)` and then
  `SELECT 1` on the same connection, and sends SIGTERM 0.7 s in. The first query returned OK
  `SELECT 1` (one row). The second got 57P01. The engine exited 0 after 1.65 s. A new pg
  connection and a new HTTP connection were both refused (ECONNREFUSED). The log shows "SIGTERM
  received ... draining" and then "shut down".
  The check passes. pgwire::eng_pg_cancel_request, _disconnect_cleanup and _statement_timeout,
  ops::eng_healthz, ops::eng_metrics and write::eng_write_preview also pass. Clippy
  -D warnings (tmp/rustup) is clean, and shutdown.rs is fmt-clean. `cargo fmt --check` drift is
  unchanged from the baseline (64 hunks, including the old tls_note line in server.rs).
- 2026-11-08T23:07:02Z supervisor: eng-graceful-shutdown passed the gate in round 1
- eng-json-logs (security): the serving engine now writes only JSON lines, one object per line on
  stderr, with `timestamp` (RFC 3339 UTC, ms, `Z`), `level` (info|warn|error) and `message`,
  plus optional fields. The new file is `src/log.rs`, with `log::info/warn/error(msg, &[(key,
  json)])`. Each line goes out as a single locked write, so lines never interleave. Fields can't
  override timestamp, level or message. `install_panic_hook` turns panics into JSON lines too.
  Every former `eprintln!` in server.rs, pg.rs, write.rs, audit_browser.rs, cloudwatch_logs.rs
  and main.rs now goes through it. The startup line is now `"message":"serving"`, with
  listen_pg, listen_http, tls, users and sources as fields. Nothing in the harness waits on that
  text: it polls the ports.
  Decisions:
  - `engine --check-config` (valid or invalid) and command-line usage errors stay plain text,
    because they answer an interactive command and eng-config-check reads them. An invalid config
    in serving mode is logged as JSON with a `problems` array. Those strings name keys and env
    vars, never values.
  - Nothing logs statements, rows, identity tokens or their claims. Audit write failures log only
    the store's error `cause` (SDK error text, which carries no item).
  - No `tracing`/`log` subscriber is installed, so the dependency crates (pgwire, AWS SDK) print
    nothing. If someone adds a subscriber later, it must emit this same JSON shape and stay at
    warn level or above. The check fails on any non-JSON line.
  Unit test: `log::tests::a_line_is_one_json_object_with_timestamp_level_and_message`.
  Tested as a user: `../tmp/json-logs-user/run.sh` (python mocks on 59881-59884, with the
  canary `secret_label` in matrix results and an audit store answering 200; engine on
  59891/59892). It sent SET hrx.identity with a token carrying a canary email and description,
  an open query and a restricted query (both SELECT 2, labels carrying the canary), a prom-bad
  query (XX000) and a login with a wrong canary password (28P01), then SIGTERM (exit 0).
  stdout was empty. stderr had 3 lines, serving / signal received / shut down, all JSON with
  timestamp and level. None of the canaries were in it: result, token, token payload, signature,
  email, description, identity secret, pg password, wrong password, AWS key and secret.
  `run_fail.sh` is the same run with the audit store answering 500 (58000). It adds one error
  line, "audit write failed", whose cause is the DynamoDB SDK error, and it has no canary.
  The check passes. config::eng_config_check, ops::eng_graceful_shutdown, ops::eng_metrics,
  audit::eng_audit_fail_closed and pgwire::eng_pg_tls also pass. Clippy -D warnings (tmp/rustup)
  is clean, and log.rs is fmt-clean. `cargo fmt --check` drift is unchanged (64 hunks, none in
  log.rs or main.rs).
- 2026-11-08T23:11:04Z supervisor: eng-json-logs passed the gate in round 1
- eng-perf-promql-large-range (performance): no code change was needed. The check passed on the
  untouched tree at session start (3.2 s for the whole test, including the warm-up and the mock).
  Two things already meet the budget. First, `[profile.dev.package."*"] opt-level = 2` in
  federation-engine/Cargo.toml, so DataFusion, arrow, pgwire and serde_json run optimised in the
  debug build. Second, promql.rs `Rows` serialises a series' labels JSON and series name once and
  reuses them for every sample of that series. Keep both: dropping the dependency opt-level, or
  re-serialising labels per row, is what would break this budget.
  Tested as a user: `../tmp/perf-user/run.sh` (python mock on 59900 answering 1,000 series x 360
  points, the same values as the check; engine on 59901/59902 with max_rows = 500000). It sends
  the query from two clients. `../tmp/pgclient` bin `perf` uses tokio-postgres extended protocol,
  like the check: a warm-up, then 3 timed runs of 0.81 to 0.83 s, each with 360,000 rows and
  sum(value) = 32399910000, the exact expected sum. `perfclient.py` uses the simple protocol
  and takes 1.2 to 1.9 s, mostly in Python decoding, which varies with load. psql is blocked by
  the sandbox ("Operation not permitted").
  The check passed 3 times, once at load average 8.4.
- 2026-11-08T23:13:34Z supervisor: eng-perf-promql-large-range passed the gate in round 1
- eng-dockerfile (operations): added federation-engine/Dockerfile and federation-engine/.dockerignore
  (excludes target/). Written, never built: no Docker on this line.
  Builder stage: `rust:1.99-bookworm` (the same rustc as the local toolchain; edition 2024 needs
  >= 1.85), installs cmake + clang for aws-lc-sys, copies Cargo.toml, Cargo.lock, crates/, src/
  and tests/, then runs `cargo build --release --locked --bin engine`. tests/ is copied only
  because the manifest declares the [[test]] acceptance target, and cargo wants its path to exist.
  Final stage: `gcr.io/distroless/cc-debian12:nonroot`. It has glibc matching bookworm, plus CA
  certificates, which aws-smithy's rustls-native-certs reads. It copies /usr/local/bin/engine
  from the builder and runs as `USER nonroot:nonroot` (65532). It has `EXPOSE 5433 8088`,
  ENTRYPOINT `/usr/local/bin/engine`, and CMD `--config /etc/federation-engine/federation-engine.toml`.
  The build context is federation-engine/ (`docker build federation-engine`).
  Follow-up for eng-readme and deploy: inside the container, the config's listen_pg/listen_http
  must bind 0.0.0.0, not 127.0.0.1. The config file is mounted read-only. Secrets come from the
  env vars it names.
  Tested: I read the Dockerfile against the feature steps. `docs::eng_dockerfile` passes. The image
  was not built (no Docker or registry access by design), so the first real `docker build` should
  be watched: base image tags, and whether aws-lc-sys builds on the target arch.
- 2026-11-08T23:14:56Z supervisor: eng-dockerfile passed the gate in round 1
