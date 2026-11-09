# ENG-1799 line `integration`: make the parallel lines work together

Every session starts with an empty memory. Read this file first, then `CONTEXT.md` (glossary; never
use an `_Avoid_` term), `docs/adr/0001`–`0004`, and `docs/eng-1799/CONTRACTS.md`. The other lines'
notes are kept as `PROGRESS-engine.md`, `PROGRESS-mcp.md`, `PROGRESS-ldq.md`, `PROGRESS-viz.md`,
`PROGRESS-alerting.md` (each has a "Contract assumptions" section). Their init scripts are
`scripts/eng-1799/init-<line>.sh`.

The feature list (50 features, ids `int-*`) is kept by the supervisor. Take features **strictly in
order**. Each feature's check is

```bash
bash e2e/eng-1799/acceptance/run.sh <feature-id>.test.ts
```

run from the repo root after `bash ./init.sh`. It exits 0 only when every test in that file passes.

## State at hand-off (init session, 2026-11-08)

- Nothing is built. Every check fails today: the protected vitest config imports
  `e2e/eng-1799/vitest.base.ts`, which does not exist yet, and every test reaches the harness
  `e2e/eng-1799/harness/index.ts`, which does not exist yet.
- Written by this session: `init.sh` (replaced), the `@lightdash/e2e-eng-1799` workspace package
  (`e2e/eng-1799/package.json`, registered in `pnpm-workspace.yaml`, lockfile updated), and the
  protected folder `e2e/eng-1799/acceptance/**` (runner, vitest config, `support.ts`, `fixtures.ts`,
  50 test files).
- **Proven during init** with a throwaway ~100-line prototype harness (deleted again): the protected
  runner, config, `support.ts` and the backend/MCP/common imports work; `int-harness-engine`,
  `int-harness-fake-prometheus`, `int-client-connect`, `int-client-streaming`,
  `int-time-params-engine` and `int-time-cache-key` passed against the real engine;
  `int-fix-alert-time-params-agree`, `int-fix-alert-sql-parameters` and `int-fix-attr-truthiness`
  failed on exactly the conflicts listed below. The prototype only needed `startEngine` and
  `startFakePrometheus`; copy nothing from it, just know the approach works (spawn
  `ENGINE_BINARY --config <toml>` with a cleared env, wait for `GET /healthz` to answer).

## How to build, run and test

| What | Command (repo root) |
|---|---|
| Prepare the tree (no servers) | `bash ./init.sh` (~2 s warm; ~15 min cold, almost all of it the first `cargo build`) |
| One check | `bash e2e/eng-1799/acceptance/run.sh int-harness-engine.test.ts` |
| One check, one test | `bash e2e/eng-1799/acceptance/run.sh int-audit-browser.test.ts -t 'by ticket'` |
| Whole suite (feature `int-docs-integration` writes it) | `bash e2e/eng-1799/run-all.sh` (one file at a time) |
| Engine binary by hand | `tmp/cargo-target/debug/engine --config <file>` |
| Regression gate (set later) | typecheck `common`, `warehouses`, `backend`, `frontend`, `cli`; `tsc` for telemetry-mcp; `cargo check` for the engine |

`init.sh`:
1. reaps leftovers of killed checks under `tmp/e2e/` older than 30 minutes (engine processes by
   their `--config` path, Postgres clusters in `<dir>/pgdata`). **Put every e2e scratch dir under
   `tmp/e2e/<something>/`** with the engine config at `<dir>/federation-engine.toml` and any cluster
   at `<dir>/pgdata` so this works;
2. runs `scripts/eng-1799/init-ldq.sh` (frozen pnpm install; builds formula, common, warehouses,
   visualization when changed; regenerates backend TSOA routes) and `init-mcp.sh` (builds
   telemetry-mcp);
3. `cargo build --bin engine` with `CARGO_TARGET_DIR=tmp/cargo-target`, `CARGO_PROFILE_DEV_DEBUG=0`,
   `CARGO_BUILD_JOBS=2`. (The engine line's own `federation-engine/target` is not used.)

`e2e/eng-1799/acceptance/run.sh` (protected) re-runs that incremental cargo build (a no-op when
nothing changed), exports `E2E_ENGINE_BINARY`, `E2E_REPO_ROOT`, `TZ=UTC`, caps vitest at 2 workers,
and runs `pnpm -F @lightdash/e2e-eng-1799 exec vitest run --config acceptance/vitest.config.ts <file>`.
The protected config: one file at a time, one worker, forks pool, 150 s test / 170 s hook timeouts,
`globals: true`, and it **merges `e2e/eng-1799/vitest.base.ts`** (yours).

Machine rules: one test file at a time; no Docker; no fixed ports; 127.0.0.1 only; stop every
process you start (tests use `track()` + `afterAll(disposeAll)` from `support.ts`); `psql` is
blocked; `/tmp` is not writable, use the repo's `tmp/`; Postgres binaries are `/opt/homebrew/bin/{initdb,pg_ctl,postgres}`.

## Architecture

```
e2e/eng-1799/
  package.json            @lightdash/e2e-eng-1799 (vitest, pg, pg-cursor, jose, @modelcontextprotocol/sdk, @casl/ability)
  vitest.base.ts          YOURS (int-harness-engine): module resolution for Lightdash source
  harness/index.ts        YOURS: the harness API below (split into files as you like)
  run-all.sh              YOURS (int-docs-integration): every acceptance file through acceptance/run.sh
  acceptance/             PROTECTED: run.sh, vitest.config.ts, support.ts, fixtures.ts, int-*.test.ts
```

- Tests import Lightdash code **from source** by repo-relative path (`load('packages/...ts')` in
  `support.ts`): `packages/warehouses/src`, `packages/backend/src/...`, `packages/common/src/...`,
  `packages/telemetry-mcp/src/...`, `packages/visualization/src/render.ts`. So `vitest.base.ts` needs
  the backend's aliases (see `packages/backend/vitest.config.ts`): `@lightdash/common` and
  `@lightdash/common/src` → `packages/common/src`, `@lightdash/warehouses` → `packages/warehouses/src`,
  `@lightdash/formula` → `packages/formula/src`, `@` → `packages/backend/src`. That alone was enough
  for the prototype. Add a `setupFiles` only if a backend module needs env at import time, and never
  stub what the checks observe (fetch to the engine, pg, child processes).
- The engine is always the real binary; Lightdash, the alerting module and the MCP server are the
  real code. Fakes stand in only for Prometheus, Loki, CloudWatch (+ Logs Insights, STS if you use a
  role), Tempo, BigQuery, the audit store (DynamoDB + S3), Okta, a Lightdash API for the MCP-only
  checks, and HTTP receivers (incident.io, webhooks, heartbeat).
- Reference implementations already in the repo (read, don't import across into protected code):
  the engine line's Rust harness `federation-engine/tests/acceptance/harness/` (`aws.rs` decodes
  CBOR / JSON 1.0 / JSON 1.1 / query protocol and implements DynamoDB PutItem/Query over the portal
  GSIs and S3 PutObject; `bigquery.rs`; `pg_cluster.rs`; `telemetry.rs`; `engine.rs` shows the
  config and env), and the MCP line's fakes in `packages/telemetry-mcp/tests/acceptance/helpers/`
  (`okta.ts`, `lightdash.ts`). No CBOR library is in the lockfile: write the small encoder/decoder
  the CloudWatch fake needs (aws-sdk-cloudwatch 1.140 speaks Smithy RPC v2 CBOR).

## Harness API (what the protected tests call; match it exactly)

`e2e/eng-1799/harness/index.ts` exports:

**Constants:** `ENGINE_BINARY` (= `$E2E_ENGINE_BINARY` or `<repo>/tmp/cargo-target/debug/engine`).

**`RecordedRequest`** = `{ method, path, params: Record<string,string> /* query string merged with a
form body */, headers: Record<string,string> /* lower-case keys */, body: string, json?: any }`.
**`FakeServer`** = `{ url: 'http://127.0.0.1:<port>', requests: RecordedRequest[] /* mutable array, in arrival order */, close() }`.

| Function | Returns / behaviour |
|---|---|
| `startEngine(opts)` | Spawns the real binary with a generated config in `tmp/e2e/<dir>/federation-engine.toml` (`listen_pg`/`listen_http` on free 127.0.0.1 ports, `identity_secret_env = "HRX_IDENTITY_SECRET"`, `[[users]] lightdash-operations` / `HRX_PG_PASSWORD_OPERATIONS`, `test_mode = true` unless `testMode: false`, `max_rows` when `maxRows` given). Cleared env: `PATH`, private `HOME`, `HRX_IDENTITY_SECRET=test-identity-secret-not-real`, `HRX_PG_PASSWORD_OPERATIONS=test-password-not-real`, `AUDIT_INTEGRITY_KEY=test-integrity-key-not-real`, `AWS_ACCESS_KEY_ID=AKIDTESTNOTREAL00001` (the CloudWatch check matches `AKID…NOTREAL`), a fake secret key, `AWS_REGION=us-east-2`, `AWS_EC2_METADATA_DISABLED=true`, missing `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE`, `AWS_ENDPOINT_URL=http://127.0.0.1:9`. Waits until pg accepts TCP and `/healthz` answers. Returns `{ host: '127.0.0.1', pgPort, httpUrl, user: 'lightdash-operations', password, database: 'operations', pid, binary, configToml, auditStore, stop() }`. `stop()` SIGTERMs, waits for exit (SIGKILL after a grace period), idempotent. |
| `startEngine` options | `prometheus`, `loki`, `cloudwatch`, `cloudwatchLogs`, `tempo`, `bigquery` (fakes), `platform` (Platform Database), `auditStore` (else the harness starts its own and returns it as `engine.auditStore`; `[audit]` is always configured), `restrictedLokiSelectors: string[]`, `restrictedLogGroups: string[]`, `maxRows`, `testMode`. |
| Source names | `prometheus` (`default = true`) **and** `prometheus-restricted` (`restricted = true`, same fake URL) whenever `prometheus` is given; `loki`; `cloudwatch`; `cloudwatch-logs`; `tempo`; `platform` (read/write URLs via `HRX_PLATFORM_READ_URL`/`HRX_PLATFORM_WRITE_URL`); `ops-marts` (bigquery, `allow` = every fake table as `dataset.table`, `api_base_url` = fake, static `access_token_env`). AWS sources point `endpoint_url` at their fake, region `us-east-2`, no `role_arn` needed. |
| `startFakePrometheus({ series, delayMs? })` | `series: { labels, value }[]`. `/api/v1/query_range` returns each series with one point per step from `start` to `end` **inclusive**; `/api/v1/query` one point at `time`. A query that is a bare metric name returns only series whose `__name__` equals it; any other query returns every series. Extra: `setSeries(series)`, `setDelay(ms)`, `cancelled()` = number of requests whose client hung up before the (delayed) reply. |
| `startFakeLoki({ streams, series? })` | `streams: { labels, lines: [isoTimestamp, line][] }[]`. Log queries (starting with `{`) return the streams' lines inside `[start, end]`; metric queries return `series` as a matrix like Prometheus. |
| `startFakeCloudWatch({ metrics })` | `metrics: { label, points: [iso, number][] }[]`. GetMetricData: for the i-th MetricDataQuery returns `Id` = its Id, `Label` = its Label or `metrics[i].label` (falls back to `metrics[0]`), the points, `StatusCode: Complete`. Extra: `metricDataQueries()` = every decoded MetricDataQuery received, in order, with AWS field names (`Id`, `MetricStat.Metric.{Namespace,MetricName,Dimensions[{Name,Value}]}`, `MetricStat.{Period,Stat}`, `Expression`, `Label`). |
| `startFakeCloudWatchLogs({ results })` | `results: Record<string,string>[]` (fields incl. `@timestamp` `YYYY-MM-DD HH:MM:SS.mmm` UTC, `@message`, `@ptr`). StartQuery → GetQueryResults `Complete` with them. Extra: `startQueries()` = `{ logGroupNames, queryString, startTime, endTime }[]` (epoch seconds). |
| `startFakeTempo({ traces })` | See `syntheticTrace` in `fixtures.ts` for the input shape. `/api/search` returns every trace (`spanSets[].matched` = span count; `limit` param recorded); `/api/traces/<id>` and `/api/v2/traces/<id>` return Tempo's OTLP JSON (base64 ids), 404 for unknown ids. |
| `startFakeBigQuery({ tables })` | See `OPS_MART_TABLES` in `fixtures.ts`. Serves what the engine's Ops Marts client calls (`tables.get`, `jobs.query`/`getQueryResults` or `tabledata.list`). Implemented (int-mcp-telemetry-tools): `tables.get`, `jobs.query` (only the engine's ``SELECT `c`, … FROM `p.d.t` [LIMIT n]``), `jobs.getQueryResults` with `pageToken` paging; optional `pageSize` (default 1000) and `token`. Returns a `FakeServer` plus `tables`, `token` (`BIGQUERY_TOKEN` = `test-bigquery-token-not-real`) and `queries()`. `startEngine({ bigquery })` renders `ops-marts` with project `e2e-ops-marts` and `access_token_env = "HRX_BIGQUERY_TOKEN"`. |
| `startFakeAuditStore()` | `{ dynamodbUrl, s3Url, items(), objects(), setFailing(bool), requests, close() }`. DynamoDB JSON 1.0 `PutItem` and `Query` over the portal GSIs (byTicket, byUser, byMonth; paging with `LastEvaluatedKey`); S3 `PutObject` (aws-chunked bodies). `items()` = stored executions as plain JSON in write order; `objects()` = `{ key, body, headers }[]`. `setFailing(true)` makes every put fail (5xx). |
| `startPlatformDatabase()` | Throwaway Postgres under `tmp/e2e/<dir>/pgdata`, 127.0.0.1, free port, `unix_socket_directories=''`. Roles `engine_read` (SELECT) and `engine_write` (SELECT/INSERT/UPDATE/DELETE) with fake passwords; `public.widgets(id int primary key, name text not null, qty int not null)` with ids 1..200, `name = 'widget-<id>'`, `qty = id % 7`. Returns `{ port, readUrl, writeUrl, query(sql, params?) /* superuser, returns rows */, stop() }`. |
| `startRecorder()` | A `FakeServer` that answers 200 `{}` to everything (incident.io, webhooks, heartbeat). |
| `startFakeOkta()` | `{ issuer, jwksUri, audience, mintAccessToken({ sub, email?, aud?, expiresInSeconds? }), close() }` — RS256 keys of its own (two fakes have different keys). |
| `startFakeLightdashApi({ projectUuid, organizationUuid, users })` | `users: { userUuid, email, isActive?, attributes: Record<string,string> }[]`. Serves what the MCP calls (`/api/v1/org/users`, `/api/v1/org/attributes`, empty alerting state/history) to `Authorization: ApiKey <apiToken>`. Returns a `FakeServer` plus `apiToken`. |
| `startTelemetryMcp({ engine, okta, lightdashUrl, lightdashApiToken, projectUuid, llm? })` | The real MCP server (`packages/telemetry-mcp/src` `loadConfig` + `startServer`, in process, port 0) with `ENGINE_*` from `engine`, `HRX_IDENTITY_SECRET`, `MCP_SOURCES` mirroring the engine's sources (incl. `prometheus-restricted`), `MCP_PLATFORM_SOURCE=platform`, `MCP_USER_CACHE_TTL_MS=1`, `deps.llm = llm`. Returns `{ url /* no path; endpoint is url + '/mcp' */, close() }`. |
| `startLightdash({ engine, env? })` | Boots the Lightdash backend (migrations on a throwaway Postgres under `tmp/e2e/`, minimal env + `env`) with one organization, an admin user with a personal access token, and an **Operations Project** whose connection is the federation flavour pointing at `engine` (`identitySigningSecret` = the engine's secret, `httpBaseUrl` = `engine.httpUrl`), and a space. Returns `{ baseUrl, mode: 'full-boot' \| 'service-layer', pid?, projectUuid, organizationUuid, userUuid, userEmail, apiKey, setUserAttributes(Record<string,string>), runAlertingCycle(), createSqlChart({ name, sql }) → savedSqlUuid, close() }`. `runAlertingCycle()` = what the scheduler worker does once: run the `alertingTick` task, then every `alertRuleEvaluate` job it enqueued, then flush notifications. If a full boot proves impossible, a service-layer app built from the real services and routers is allowed (`mode: 'service-layer'`), and `docs/eng-1799/integration.md` must say why. |

## Findings: where the lines disagree (each is an `int-fix-*` feature)

Verified by reading the code; the decisions are this session's recommendation, recorded so later
sessions don't re-derive them. Record the final decision per entry in
`docs/eng-1799/contract-assumptions.md` (feature `int-assumptions-register`) and amend CONTRACTS
with dated notes (`int-contracts-amended`).

1. **Write Mode confirmation token** (`int-fix-write-confirmation-token`, `int-fix-mcp-write-preview`).
   The engine (A6) requires `{"v":1,"typ":"write_confirmation","statement_sha256","sub","project","iat","exp","nonce"}`
   (`federation-engine/src/write.rs` `verify_confirmation`). Lightdash
   (`packages/backend/src/services/FederationService/writeConfirmationToken.ts`) omits `typ` and
   `iat`; the MCP (`packages/telemetry-mcp/src/identity/confirmation.ts`) uses `stmt_sha256` and
   omits `typ`/`iat`. Decision: the engine's encoding is canonical (most explicit, and ldq's pinned
   test uses `toMatchObject`, so adding keys is compatible). Change Lightdash and the MCP; amend §4.2.
2. **cloudwatch() input** (`int-fix-cloudwatch-query-shape`). The engine reads Grafana's stored
   target model only (`namespace`, `metricName`, `dimensions`, `statistic`, `period`, …;
   `src/cloudwatch.rs`); Investigate (`buildCloudWatchMetricDataQuery`) and the MCP
   `query_cloudwatch` tool send the AWS `MetricDataQuery` shape (`Id`, `MetricStat`…). CONTRACTS §1.1
   names Grafana's shape. Recommended: the engine also accepts the AWS shape (detected by a
   `MetricStat` or `Expression` key) — the narrowest change that keeps every line's tests green;
   amend §1.1.
3. **Reserved parameters in SQL** (`int-fix-alert-sql-parameters`). Investigate/SQL Runner SQL uses
   bare `${ld.parameters.__from}` and Lightdash's `safeReplaceParameters` quotes values; the alerting
   evaluator (`common/src/alerting/queryParameters.ts` `substituteAlertQueryParameters`) inserts them
   verbatim, and `docs/eng-1799/alerting-examples` and `alerting.md` quote them in SQL. Decision:
   Lightdash's convention wins (it is how every other query is compiled, and Investigate's "Save as
   chart" output must work as an Alert Rule query). Change the alerting substitution to produce
   exactly Lightdash's output, and unquote the examples/docs; amend §2.
4. **Duration formatting ≥ 1 week** (`int-fix-alert-time-params-agree`). ldq's
   `formatPrometheusDuration` gives `7d`, alerting's `1w` (see the merge note at the end). Neither
   line's acceptance test pins week values. Recommended: one implementation (ldq's day-based output,
   which the package root already exports); alerting's reserved parameters then equal ldq's for the
   same window.
5. **Identity never sent on Lightdash's query path** (`int-fix-query-path-identity`). Nothing in the
   backend passes `getIdentityToken` to the federation client (`grep -rn createTokenProvider
   packages/backend/src` finds only its definition), so SQL Runner, tiles and alert queries reach the
   engine with no claims. Wire `WarehouseClientFactory` (or the project-model client construction) to
   pass `FederationIdentityService.createTokenProvider(...)` for federation credentials, with the
   request's user, the project, and the query's `audit` (`/query/sql` body `audit`; tiles: source
   `tile`, `resource_uuid` = tile uuid).
6. **Alert evaluator identity** (`int-fix-alert-evaluator-identity`).
   `createProjectAlertWarehouseClients` (`packages/backend/src/createProductionAlertingModule.ts`)
   drops the `AlertRuleQueryContext`, and nothing mints `sub = system:alert-evaluator`. Decision:
   mint the system identity from the context (`sys: true`, `agent: false`, `audit.source:
   'alert_rule'`, description = rule description, `resource_uuid` = rule uuid) with attrs from env
   **`ALERTING_EVALUATOR_ATTRS`** (comma-separated claim names, e.g. `telemetry_restricted,platform_read`;
   unset/empty = none); amend §4.3.
7. **MCP alert tools vs the alerting API** (`int-fix-mcp-real-lightdash`). The MCP sends
   `ruleUuid`, `from`, `to`, `limit`; the alerting router reads `rule` and `since` on `/history` and
   takes no filter on `/state`. The alerting line owns the API (alerting assumption 5). Recommended:
   the MCP maps `rule_uuid → rule`, `from → since`, applies `to`/`limit` itself, and `/state` accepts
   `?rule=` (a small router addition). The same check also proves the MCP's user mapping against the
   **real** `/api/v1/org/users` and `/api/v1/org/attributes` responses.
8. **Attribute truthiness** (`int-fix-attr-truthiness`). ldq: true if any value is exactly `"true"`
   (pinned by ldq's acceptance test `identity-token-attrs`: `['false','true']` → true). MCP
   (`resolveAttrs` in `packages/telemetry-mcp/src/auth/userMapping.ts`): true only if the resolved set
   is exactly `{"true"}`. Recommended: the MCP adopts ldq's reading (ldq's is pinned; changing it
   would break that line's acceptance test).
9. **Example queries browse** (`int-mcp-ask-data`). The MCP's example-queries service calls
   `GET /v1/audit` with no filters; the engine's no-parameter browse (A14) was never tested. The
   check proves it works end to end.

Further items the checks will surface are expected; add each as its own decision row.

## Conventions

- Glossary terms: Federation Engine, Telemetry Source, Restricted Telemetry, Audited Query, Write
  Mode, Preview, Platform Database, Ops Mart, Operations Project, Investigate, Alert Rule, Contact
  Point, Notification Route. Never `_Avoid_` terms (e.g. "datasource" except the Grafana-compatible
  `DatasourceError`/`DatasourceNoData` alert names, "dry run", "prod db").
- Keep the fork rebase-friendly: new code in new files; edits to upstream files stay small. **Never
  touch any `ee/` directory.** Don't edit another line's protected acceptance folders
  (`packages/*/src/__acceptance__/**`, `federation-engine/tests/acceptance/**`,
  `packages/telemetry-mcp/tests/acceptance/**`); a fix must keep those lines' checks green.
- Fixtures are synthetic; secret-shaped values look like `test-…-not-real`. Never log identity
  tokens, confirmation tokens, signing secrets or passwords.
- When you fix a line's code, run that line's own relevant acceptance check too (see its
  `PROGRESS-<line>.md`), plus the typecheck of the touched package.
- Fixes that change engine Rust code: keep `cargo fmt`/`clippy` clean (toolchain note in
  `PROGRESS-engine.md`) and re-run the engine's affected acceptance tests
  (`cargo test --manifest-path federation-engine/Cargo.toml --test acceptance -- <module>::<test> --exact`;
  that uses `federation-engine/target`, a second build — set `CARGO_BUILD_JOBS=2`).

## Feature order

1 int-harness-engine · 2 int-harness-fake-prometheus · 3 int-harness-platform-database ·
4 int-harness-audit-store · 5 int-harness-fake-loki · 6 int-harness-fake-tempo ·
7 int-harness-fake-cloudwatch · 8 int-harness-fake-cloudwatch-logs · 9 int-harness-fake-bigquery ·
10 int-client-connect · 11 int-client-catalog · 12 int-client-metric-functions ·
13 int-client-log-trace-functions · 14 int-client-streaming · 15 int-identity-backend-token ·
16 int-identity-refused-tokens · 17 int-identity-claims-scope · 18 int-identity-agent-restricted ·
19 int-client-platform-functions · 20 int-client-limits-and-errors · 21 int-fix-cloudwatch-query-shape ·
22 int-time-params-engine · 23 int-time-cache-key · 24 int-fix-alert-time-params-agree ·
25 int-fix-alert-sql-parameters · 26 int-fix-write-confirmation-token · 27 int-write-preview ·
28 int-write-commit-once · 29 int-write-agent-commit-refused · 30 int-write-audit-integrity ·
31 int-audit-browser · 32 int-fix-attr-truthiness · 33 int-mcp-oauth-gate · 34 int-mcp-telemetry-tools ·
35 int-mcp-platform-tools · 36 int-mcp-restricted-hidden · 37 int-fix-mcp-write-preview ·
38 int-mcp-ask-data · 39 int-viz-engine-results · 40 int-lightdash-boot · 41 int-fix-query-path-identity ·
42 int-lightdash-sql-chart · 43 int-alert-promql-evaluates · 44 int-fix-alert-evaluator-identity ·
45 int-alert-incident-io-lifecycle · 46 int-alert-engine-down · 47 int-fix-mcp-real-lightdash ·
48 int-assumptions-register · 49 int-contracts-amended · 50 int-docs-integration

Notes on order: harness pieces come first, each proven against the real engine. Checks that use
Lightdash's booted backend (40–47) come after every check that doesn't, so a hard boot can't block
the rest. `int-mcp-telemetry-tools` needs the CloudWatch fix (21) first.

## Known overlaps found while merging the base (2026-11-09)

- `formatPrometheusDuration` is exported by both `packages/common/src/utils/timeRange.ts` (ldq) and
  `packages/common/src/alerting/durations.ts` (alerting). They differ for durations of a week or more
  (`7d` vs `1w`). The package root re-exports ldq's to resolve the clash.
- Alerting's `alerting/queryParameters.ts` builds the CONTRACTS §2 reserved time parameters (`__interval`,
  `__range`, ...) separately from ldq's `utils/timeRange.ts`. The two should agree on every value the engine sees.

## Session log

- 2026-11-08 init: wrote the feature list (50), the protected e2e acceptance suite, `init.sh` and
  this file; validated the harness approach with a throwaway prototype; every check fails on the
  tree as handed off.
- 2026-11-09T01:12:48Z supervisor: initialized: 50 features, run 20261108-192705
- 2026-11-09T01:57:13Z supervisor: initialized: 50 features, run 20261108-203649
- 2026-11-09 int-harness-engine: added `e2e/eng-1799/vitest.base.ts` (the backend's aliases:
  `@`, `@lightdash/common/src`, `@lightdash/common`, `@lightdash/formula`, `@lightdash/warehouses`;
  nothing else), `e2e/eng-1799/tsconfig.json` (so the package's `typecheck` script works; covers
  `harness/` and `vitest.base.ts`, not the protected acceptance files) and the harness:
  `harness/index.ts` (re-exports only), `harness/engine.ts` (`ENGINE_BINARY`, `startEngine`),
  `harness/util.ts` (`scratchDir` under `tmp/e2e/`, `freePort(s)`, `tcpOpen`, `sleep`).
  `startEngine` spawns the binary with the Harness API's cleared env and config, waits for pg TCP +
  any `/healthz` answer (60 s, fails fast with stderr if the process exits), and `stop()` SIGTERMs,
  SIGKILLs after 10 s, then removes its scratch dir (idempotent). Tested by hand with a tsx script
  (start, `SELECT version()` = `PostgreSQL 16.0 (hrx-federation-engine 0.1.0)`, `/healthz` 200,
  stop twice, pid gone, pg port closed, `tmp/e2e` empty) and with the check (2/2 pass, ~3 s).
  Next sessions must know:
  - `startEngine` **throws** for the not-yet-built options (`prometheus`, `loki`, `cloudwatch`,
    `cloudwatchLogs`, `tempo`, `bigquery`, `platform`, `auditStore`, `restricted*`): remove each from
    `NOT_YET_SUPPORTED` in `engine.ts` as its feature renders the `[[sources]]` block.
  - `[audit]` is **not** configured yet (the engine config treats it as optional). Feature
    `int-harness-audit-store` must add it always (own fake store when `auditStore` is not given,
    returned as `engine.auditStore`, closed by `stop()`), per the Harness API.
  - Lazy-loading rule (written at the top of `harness/index.ts`): telemetry-mcp and the Lightdash
    backend app are loaded only with `await import(...)` inside `startTelemetryMcp`/`startLightdash`,
    never statically from `index.ts` or anything it imports statically.
  - Format new harness files with `node_modules/.bin/oxfmt <files>` (the repo's formatter; there is no
    prettier config).
- 2026-11-09T02:03:31Z supervisor: int-harness-engine passed the gate in round 1
- 2026-11-09 int-harness-fake-prometheus: added `harness/fakeServer.ts` (`startFakeServer(handler)`:
  node:http on a free 127.0.0.1 port, records every request as the Harness API `RecordedRequest`
  — query string merged with a form body, lower-case headers, `json` when the body parses; a
  handler returning `undefined` sends nothing; `close()` idempotent and drops open connections;
  `jsonReply()` helper) — **reuse it for every later fake** (Loki, Tempo, recorder, Lightdash API…).
  `harness/prometheus.ts` (`startFakePrometheus({ series, delayMs? })` with `setSeries`, `setDelay`,
  `cancelled()`, per the Harness API; GET or POST; bad params answer Prometheus' 400 `bad_data`).
  `startEngine({ prometheus })` now renders the default `prometheus` source at the fake's URL.
  Tested by hand with a tsx script (outside the repo): 12 rows, types timestamptz/float8/json/text,
  6 points per series 10:00–10:05, fake recorded POST `query_range` `query=up start=1794132000
  end=1794132300 step=60`; a non-bare instant query returns every series; with `setDelay(3000)` and
  `statement_timeout=500` the engine cancels and `cancelled()` = 1; stop leaves `tmp/e2e` empty.
  Check: 2/2 pass; int-harness-engine still 2/2.
  Next sessions must know:
  - **`prometheus-restricted` is NOT rendered yet.** The engine refuses to start with a
    `restricted = true` source and no `[audit]` (engine-config `audited_sources_need_audit`).
    Feature `int-harness-audit-store` must add it (same fake URL, `restricted = true`) together with
    the always-on `[audit]` block, per the Harness API "Source names" row.
  - The engine sends `start`/`end`/`step` as decimal seconds (`seconds_text`) in a POST form body.
- 2026-11-09T02:06:47Z supervisor: int-harness-fake-prometheus passed the gate in round 1
- 2026-11-09 int-harness-platform-database: added `harness/platform.ts` (`startPlatformDatabase()`:
  initdb + pg_ctl from `/opt/homebrew/bin` (override `E2E_PG_BIN`) into `tmp/e2e/platform-…/pgdata`,
  127.0.0.1, free port, `unix_socket_directories = ''`, scram superuser `postgres`; roles
  `engine_read` (SELECT) / `engine_write` (SELECT/INSERT/UPDATE/DELETE); `public.widgets(id, name,
  qty)` 1..200; `query(sql, params?)` as superuser on a fresh connection; `stop()` = `pg_ctl -m fast`
  (falls back to immediate), removes the dir, idempotent). Mirrors the engine line's `pg_cluster.rs`.
  Added `harness/auditStore.ts`: a **minimal** `startFakeAuditStore()` (one fake server for both
  `dynamodbUrl` and `s3Url`; DynamoDB JSON 1.0 `PutItem` → `{}`, any S3 `PUT` → 200 with an ETag,
  anything else 400; table `db-query-portal-executions`, bucket `db-query-portal-audit` as in the
  engine's Rust harness). `startEngine` now accepts `platform` (`[[sources]] platform`,
  `platform_postgres`, `HRX_PLATFORM_READ_URL`, plus `HRX_PLATFORM_WRITE_URL` when `writeUrl` is
  given) and `auditStore`, and **always** renders `[audit]` (integrity key env, region us-east-2, both
  endpoint URLs); without `auditStore` it starts its own fake, returns it as `engine.auditStore` and
  closes it in `stop()`.
  Tested by hand with tsx scripts outside the repo: seed 200 rows (ids 1..200, qty sum 598); through
  the engine with a backend-minted `platform_read` token `platform_query` counts 200; the CTE DELETE
  is refused 42501 (by the engine's write-mode guard, before Postgres); without `platform_read` 42501;
  the fake recorded `PutItem` then `PUT /db-query-portal-audit/executions/…`; connecting directly,
  `engine_read` DELETE → 42501 permission denied, `engine_write` DELETE works; stop twice, pg port and
  audit fake closed, `tmp/e2e` empty, no leftover processes. Check 1/1; engine and prometheus checks
  still 2/2; package typecheck clean.
  Next sessions must know:
  - int-harness-audit-store extends `auditStore.ts` (items()/objects()/setFailing/Query/aws-chunked
    S3 bodies/58000) and adds `prometheus-restricted` to `renderConfig` (now possible: `[audit]` is
    always there).
- 2026-11-09T02:10:59Z supervisor: int-harness-platform-database passed the gate in round 1
- 2026-11-09 int-harness-audit-store: `harness/auditStore.ts` is now the full fake from the Harness API
  (mirrors `federation-engine/tests/acceptance/harness/aws.rs`): DynamoDB JSON 1.0 `PutItem` (table
  check, duplicate `id` → `ConditionalCheckFailedException`) and `Query` (table or GSIs `byMonth`/
  `byTicket`/`byUser`, `createdAt` range, simple FilterExpression, ScanIndexForward, Limit,
  `ExclusiveStartKey`/`LastEvaluatedKey`, `Select: COUNT`); S3 path-style `PutObject` with the key
  percent-decoded and aws-chunked bodies decoded from the raw bytes; `items()` (plain JSON, N →
  number, write order), `objects()` (`{ key, body, headers }`), `setFailing(bool)` → every PutItem
  answers 500 `InternalServerError` and every PutObject 500 `InternalError` (Query keeps working).
  `fakeServer.ts`: handlers get a third argument `rawBody: Buffer` (the utf-8 `body` string can't
  undo byte-counted framing). `engine.ts`: renders `prometheus-restricted` (`restricted = true`,
  same fake URL) next to `prometheus` whenever `prometheus` is given.
  Tested by hand with tsx scripts outside the repo: one platform_query → 1 item (status success,
  mode read, database platform, non-ASCII description intact) + 1 object at
  `executions/<createdAt>/<id>.json` whose body parses to the item (Object Lock COMPLIANCE header);
  `promql(..., 'prometheus-restricted')` is audited (database `prometheus-restricted`); 28 items
  then engine `GET /v1/audit?ticket=` pages 25 + 3 (cursor null at end), `month=` and `user=` work;
  `setFailing(true)` → 58000 `audit write failed`, 0 rows, ~2 s (SDK retries the 5xx), no item
  stored; `setFailing(false)` recovers. A hand-framed aws-chunked PUT (chunk split inside a
  multibyte char, checksum trailer) decodes exactly. Checks: audit-store 1/1; engine 2/2,
  fake-prometheus 2/2, platform-database 1/1; e2e typecheck clean; `tmp/e2e` empty afterwards.
  Next sessions must know:
  - The engine's S3 SDK sent a plain (not aws-chunked) body here; the decoder is there for SDK
    versions/checksum settings that stream.
  - `items()` key order is whatever the engine's PutItem map had (not portal order); checks that
    need portal order re-order themselves (int-write-audit-integrity does).
  - A failing store costs ~2 s per Audited Query (SDK retries); keep that in mind for timeouts.
- 2026-11-09T02:15:34Z supervisor: int-harness-audit-store passed the gate in round 1
- 2026-11-09 int-harness-fake-loki: new `harness/loki.ts` (`startFakeLoki({ streams, series? })`,
  exported from `index.ts` with its types). `/loki/api/v1/query_range` (GET or POST form): a query
  starting with `{` answers `streams` (every fixture stream's lines inside `[start, end]` inclusive,
  ordered by `direction`, cut to the first `limit` over all streams, empty streams left out,
  ns-string timestamps; defaults limit 100 / backward like Loki); any other query answers a
  `matrix` of `series` at every step from start to end inclusive (like the fake Prometheus).
  Selectors are NOT evaluated: every stream is in every log answer. Times: ns, seconds (≤10 digits
  or fractional) or RFC 3339 (fixture timestamps may carry up to 9 fraction digits); bad
  limit/direction/start/end/step → 400 plain text, as Loki. Extras: `setStreams`, `setSeries`;
  `/ready` → 200. `engine.ts`: `loki` option renders `[[sources]] name = "loki" kind = "loki"`
  (the only loki source, so it is the default). `prometheus.ts` now exports `parseStep` and
  `sampleValue` (reused by the Loki fake).
  Tested by hand with a tsx script outside the repo through the real engine over pg-wire: default
  logql() sent limit=1000 direction=backward (the engine's defaults) and returned 3 lines (a 4th
  outside the window left out), sub-ms fixture time truncated to µs; `2,'forward'` → the 2 oldest,
  `1,'backward'` → the newest; logql_metric() step '1m' → `step=60`, 3 points of 0.5 with series
  `{app="a"}`; a log query via logql_metric and a metric query via logql → 42809; setStreams([]) →
  0 rows; limit=0 → 400. Checks: fake-loki 1/1, fake-prometheus 2/2, engine 2/2; e2e typecheck
  clean; no engine left running, `tmp/e2e` empty.
  Next sessions must know:
  - `restrictedLokiSelectors` is still in `NOT_YET_SUPPORTED` (int-mcp-restricted-hidden uses it):
    render it as `restricted_selectors = [...]` on the `loki` source.
  - The engine always sends `limit` and `direction` for logql() (defaults 1000 / backward), so
    the fake's own defaults matter only for direct HTTP calls.
- 2026-11-09T02:19:09Z supervisor: int-harness-fake-loki passed the gate in round 1
- 2026-11-09 int-harness-fake-tempo: new `harness/tempo.ts` (`startFakeTempo({ traces })`, exported
  from `index.ts` with its types; input shape = `syntheticTrace` in fixtures.ts). `/api/search`
  answers every fixture trace in fixture order cut to `limit` (default 20), with `traceID` hex,
  `startTimeUnixNano` string, `durationMs`, and `spanSet` + `spanSets[0]` whose `matched` = span
  count. The TraceQL query and the time range are NOT evaluated (every trace in every answer, as
  the Harness API table says). `/api/traces/<id>` → `{ batches }`, `/api/v2/traces/<id>` →
  `{ trace: { resourceSpans } }`: one resource per service (first-seen order), base64 ids,
  `start/endTimeUnixNano` strings, `STATUS_CODE_*` names, attributes as OTLP AnyValues (integers
  as `intValue` text). Ids are case-insensitive, leading zeros optional; unknown id → 404 (the
  engine turns that into 0 rows); non-hex id or bad limit/start/end → 400 plain text. Extras:
  `setTraces`, `/ready`. `engine.ts`: `tempo` option renders `[[sources]] name = "tempo"
  kind = "tempo"` (removed from `NOT_YET_SUPPORTED`).
  Tested by hand with a tsx script outside the repo through the real engine over pg-wire:
  traceql() → 1 row (root refills-api / POST /refills, start 10:00:01, 120 ms, span_count 2), the
  engine sent q/start/end (unix s)/limit=20; `limit 1` sent limit=1; trace() → 2 spans, root with
  NULL parent and status ok, child parent b7ad…, pharmacy-db, error, attributes
  `{"http.status_code":201}` / `{"db.system":"postgresql"}`, durations 120/80; an upper-case id
  works; unknown id → 0 rows, no error; v2 path answers `trace.resourceSpans`; setTraces([]) →
  0 rows. Checks: fake-tempo 1/1, engine 2/2, fake-loki 1/1, fake-prometheus 2/2; e2e typecheck
  clean; no engine left running, `tmp/e2e` empty.
  Next sessions must know:
  - The engine only calls `/api/traces/<id>` (not v2) and sends `Accept: application/json`.
  - Fixture `durationMs` on a span sets `endTimeUnixNano`; the engine computes `duration_ms` from
    start/end, so sub-ns precision is lost only beyond 1e-6 ms.
- 2026-11-09T02:22:34Z supervisor: int-harness-fake-tempo passed the gate in round 1
- 2026-11-09 int-harness-fake-cloudwatch: new `harness/cloudwatch.ts` (`startFakeCloudWatch({ metrics })`,
  exported from `index.ts` with its types) and `harness/cbor.ts` (a small CBOR codec: decoder takes
  definite/indefinite items, tags, half/single/double floats; encoder writes definite lengths, with
  `cborTimestamp(s)` = tag 1 over a double and `cborDouble(n)` to force doubles). The fake answers
  `GetMetricData` in Smithy RPC v2 CBOR (`POST /service/GraniteServiceVersion20100801/operation/
  GetMetricData`, reply `application/cbor` + `smithy-protocol: rpc-v2-cbor`) and in AWS JSON 1.0
  (`x-amz-target: GraniteServiceVersion20100801.GetMetricData`). i-th query → `Id`, `Label` = query
  Label else `metrics[i].label` (metrics[0] when fewer metrics than queries), that metric's points,
  `Complete`, no NextToken. The query and time range are NOT evaluated (every point in every
  answer). Other operations → 400 `UnknownOperationException`; empty MetricDataQueries → 400.
  SigV4 is NOT verified; checks read the recorded `authorization` header. Extras:
  `metricDataQueries()`, `setMetrics`. For CBOR requests the decoded input is also put on the
  recorded request's `json`. `fakeServer.ts`: `FakeReply.body` may now be a Buffer (binary
  replies). `engine.ts`: `cloudwatch` option renders `[[sources]] name = "cloudwatch" kind =
  "cloudwatch" region = "us-east-2" endpoint_url = <fake>` (removed from `NOT_YET_SUPPORTED`).
  Tested by hand with a tsx script outside the repo through the real engine over pg-wire: Grafana
  builder target with empty label → 2 rows, `series` = the fake's label, labels JSON with
  namespace/metric_name/statistic/dimension; the engine sent `Id: "queryA"`, MetricStat with
  Period 60 / Stat Maximum, `ReturnData: true`, StartTime/EndTime epoch s, ScanBy
  TimestampAscending, CBOR, signed `Credential=AKIDTESTNOTREAL00001/<date>/us-east-2`; a code-mode
  target sent `Expression` + `Label` + `Period` without MetricStat; setMetrics([]) → 0 rows;
  ListMetrics → 400 CBOR error; JSON 1.0 GetMetricData answers JSON. Checks: fake-cloudwatch 1/1,
  audit-store 1/1, engine 2/2; e2e typecheck clean; no engine left running, `tmp/e2e` empty.
  Next sessions must know:
  - The engine's query Id is `query<refId>` (Grafana target) — tests read `MetricDataQueries` by
    order, not Id.
  - CloudWatch Logs (next feature) is a different SDK; check its protocol (the Rust harness
    `aws.rs` decodes CBOR / JSON 1.1). `cbor.ts` is reusable if it speaks CBOR.
- 2026-11-09T02:26:51Z supervisor: int-harness-fake-cloudwatch passed the gate in round 1
- 2026-11-09 int-harness-fake-cloudwatch-logs: new `harness/cloudwatchLogs.ts`
  (`startFakeCloudWatchLogs({ results })`, exported from `index.ts` with its types). The engine's
  aws-sdk-cloudwatchlogs 1.163 speaks **AWS JSON 1.1** (`x-amz-target: Logs_20140328.<Op>`,
  `application/x-amz-json-1.1`), not CBOR, so `cbor.ts` is not used. `StartQuery` records its
  input and answers `queryId` `fake-query-<n>`; `GetQueryResults` for a known id answers
  `Complete` at once with every result (`[{field, value}]` in fixture key order, `@ptr` included
  — the engine drops it); `StopQuery` → `success: true`. Query, log groups and window are NOT
  evaluated. Unknown queryId → 400 `ResourceNotFoundException`; other operations → 400
  `InvalidOperationException`; SigV4 not verified. Extras: `startQueries()` (raw StartQuery
  inputs, epoch seconds), `stoppedQueries()`, `setResults`. `engine.ts`: `cloudwatchLogs` option
  renders `[[sources]] name = "cloudwatch-logs" kind = "cloudwatch_logs" region = "us-east-2"
  endpoint_url = <fake>` (removed from `NOT_YET_SUPPORTED`; default poll interval, the fake never
  answers `Running`).
  Tested by hand with a tsx script outside the repo through the real engine over pg-wire:
  cloudwatch_logs('/synthetic/app, /synthetic/worker', …, 10:00–10:05) → 2 rows, types
  timestamptz/text/json, fields `{@message, @timestamp, status}` without `@ptr`; StartQuery got
  both groups, the query string, startTime/endTime epoch s; signed
  `Credential=AKIDTESTNOTREAL00001/<date>/us-east-2`; a fractional window 10:00:00.5–10:00:10.2
  was sent as …000/…011 (floor/ceil); setResults([]) → 0 rows; explicit 5th arg
  `'cloudwatch-logs'` works. Checks: fake-cloudwatch-logs 1/1, fake-cloudwatch 1/1, engine 2/2;
  e2e typecheck clean; no engine left running, `tmp/e2e` empty.
  Next sessions must know:
  - `restrictedLogGroups` is still in `NOT_YET_SUPPORTED`; it belongs on this `cloudwatch-logs`
    source as `restricted_log_groups = [...]` (see federation-engine/README.md).
  - The fake answers `Complete` on the first poll; a check that needs Running/Failed/Cancel would
    have to extend it (the Rust harness `telemetry.rs` `logs_insights_mock` is the model).
- 2026-11-09T02:30:06Z supervisor: int-harness-fake-cloudwatch-logs passed the gate in round 1
- 2026-11-09T02:34:53Z supervisor: int-harness-fake-bigquery halted: the worker halted on int-harness-fake-bigquery
- 2026-11-09 int-client-connect: **no code change needed.** The integrated base already has
  `packages/warehouses/src/warehouseClients/FederationWarehouseClient.ts` (ldq line, extends
  `PostgresWarehouseClient`) and `warehouseClientFromCredentials` picks it for
  `type: 'postgres'` + `flavor: 'federation'` (`isFederationCredentials`). The check passed on
  the first run after `init.sh` (1/1, ~9 s).
  Tested by hand with a tsx script outside the repo against the real engine + fake Prometheus:
  federation creds → `FederationWarehouseClient`; `test()` resolves; `SELECT 1 AS one,
  'synthetic' AS word, now() AS at, true AS flag, 1.5::float8 AS f` → 1 row, fields number
  (integer) / string / timestamp / boolean / number (float); `promql_instant('up', now())` →
  1 row, fields timestamp/value(number)/labels(string)/series(string); an unknown table function
  surfaces as `WarehouseQueryError` with the engine's planning message; `flavor: 'postgres'` and
  no flavor → `PostgresWarehouseClient`. No engine left running, `tmp/e2e` empty.
  Next sessions must know:
  - Without `options.getIdentityToken` the client sends no `SET hrx.identity`; the engine then
    applies its no-identity rules (fine for the plain SELECT/promql here). Checks that need
    restricted or platform access must pass a token provider (FederationService does).
  - The engine's `json` columns (e.g. promql `labels`) map to Lightdash `string`.
  - Fake servers in the harness stop with `close()` (support.ts `track` handles both).
- 2026-11-09T02:36:57Z supervisor: int-client-connect passed the gate in round 1
- 2026-11-09T02:37:43Z supervisor: int-client-catalog halted: the worker halted on int-client-catalog
- 2026-11-09 int-client-metric-functions: **no code change needed.** The check passed on the first
  run after `init.sh` (1/1, ~5 s); the integrated `FederationWarehouseClient` already parses the
  engine's json `labels` into objects.
  Tested by hand with a tsx script outside the repo (real engine + fake Prometheus/Loki/CloudWatch,
  synthetic series) through `warehouseClientFromCredentials(...).runQuery`: promql (2 series ×
  4 steps), promql_instant, logql_metric and cloudwatch all return the §1.1 columns
  timestamp/value/labels/series typed timestamp/number/string/string, with `labels` arriving as a JS
  object; `label(labels,'route')` → the value, a missing key → null, `series_name(labels)` →
  `{__name__="http_requests",code="200",route="/refills"}` (keys sorted); cloudwatch `series` is the
  target's `label`, and its labels hold the dimensions plus `metric_name`/`namespace`/`statistic`/`label`.
  No engine left running, `tmp/e2e` empty.
  Next sessions must know:
  - Lightdash reports the `labels` field type as `string` even though row values are objects
    (json → string mapping); checks should accept an object or parse a string.
- 2026-11-09T02:39:48Z supervisor: int-client-metric-functions passed the gate in round 1
- 2026-11-09 int-client-log-trace-functions: **no code change needed.** The check passed on the
  first run after `init.sh` (1/1, ~7 s).
  Tested by hand with a tsx script outside the repo (real engine + fake Loki/CloudWatch Logs/Tempo,
  synthetic data) through `warehouseClientFromCredentials(...).runQuery`:
  logql with no optional args → 3 lines across 2 streams, Loki got `limit=1000`,
  `direction=backward` (defaults); `logql(..., 2, 'backward')` → 2 newest lines, Loki got
  `limit=2`; an invalid direction → `WarehouseQueryError` with the engine's message.
  cloudwatch_logs → timestamp/message/fields (timestamp/string/string), `fields` an object without
  `@ptr`. traceql default → 2 traces, Tempo `/api/search` got `limit=20`; `traceql(..., 1)` →
  1 trace, `limit=1`. trace(id) → spans with parent_span_id and `attributes` as an object.
  No engine left running, `tmp/e2e` empty.
  Next sessions must know:
  - `span_count` (int8) arrives as a JS **BigInt**: upstream `PostgresWarehouseClient` sets
    `types.setTypeParser(INT8, BigInt)`. Its field type is still `number`. `JSON.stringify` on
    raw rows throws, so checks and scripts must handle BigInt.
- 2026-11-09T02:42:27Z supervisor: int-client-log-trace-functions passed the gate in round 1
- 2026-11-09 int-client-streaming: **engine change** in `federation-engine/src/promql.rs`.
  The check failed at first: the fake Prometheus (like real Prometheus) refuses a range query of
  more than 11,000 points per series (`bad_data: exceeded maximum resolution`), so a valid
  30000-row `promql()` call failed. CONTRACTS §1.1/§1.2 promise one row per sample and cap only
  at `max_rows`.
  **Contract assumption** (narrowest reading): `promql()` splits a long range into windows of at
  most 11,000 steps, aligned to the original `start` (each window starts one step after the
  previous one ends; the last ends at the original `end`). It fetches the windows one after another
  and merges series with the same labels in time order (series in order of first appearance).
  So the result is exactly what one unlimited request would return. A range that fits, or an
  invalid one (`end < start`), is still a single request with the same error as before. Once the
  merged samples exceed `max_rows`, no more windows are fetched and 54000 is raised as before.
  `promql_instant` is unchanged. New unit tests: `long_ranges_split_into_aligned_windows_of_at_most_11000_points`,
  `windows_merge_into_one_series_per_label_set_in_time_order` (promql 9/9 pass).
  Tested by hand with a tsx script outside the repo (real engine + fake Prometheus, synthetic
  series) through `warehouseClientFromCredentials(...).streamQuery/runQuery`: 30000 points at
  1 s → 30000 distinct rows in order, first T0 and last T0+29999 s, and the fake saw 3 requests
  (11000/11000/8000 points). With 2 series, each had 30000 rows. A 10-minute range → 1 request. Ten days at 1m
  → 14401 rows in 2 windows. `max_rows = 15000` → `WarehouseQueryError: result exceeds max_rows`
  after 1 request. `end < start` → Prometheus' own error. Regression: int-harness-fake-prometheus,
  int-client-metric-functions pass. No engine left running, `tmp/e2e` empty.
  Next sessions must know:
  - Upstream `PostgresWarehouseClient.streamQuery` reads through pg-query-stream (cursor portal
    fetches) but calls the callback **once per row** (`rows: [row]`), so the "batches" in the
    check are callback calls. That's upstream behaviour, deliberately left alone.
  - `logql_metric()` (Loki has the same 11,000-point limit, see `harness/loki.ts`) does **not**
    split yet. Reuse `range_windows`/`merge_matrix` if a later feature needs long Loki ranges.
  - Without ORDER BY, DataFusion may interleave the rows of one promql() result (round-robin
    repartition); queries that need an order must say ORDER BY.
  - rustfmt and clippy are not installed on this machine; only `cargo build`/`cargo test` ran.
- 2026-11-09T02:59:33Z supervisor: int-client-streaming passed the gate in round 1
- 2026-11-09 int-identity-backend-token: **no code change needed.** The check passed on the first
  run after `init.sh` (1/1, ~5 s).
  Tested by hand with a tsx script outside the repo (real engine + throwaway Platform Database,
  synthetic identity): minted a token with the backend's `mintIdentityToken`
  (`packages/backend/src/services/FederationIdentity/identityToken.ts`, platform_read only,
  description + ticket set). `verifyIdentityToken` accepted it. On one pg-wire connection,
  `SET hrx.identity` and then `platform_query('SELECT id FROM widgets')` → count 200. The audit store
  had exactly 1 item with the token's sub, email, description and ticket, `action: query`,
  `mode: read`, `status: success`, `database: platform`. A connection without SET hrx.identity →
  platform_query refused with 42501. No engine or Postgres left running, `tmp/e2e` empty.
  Note: the helper script stayed at `../tmp/manual-identity/try.ts` (outside the repo) because
  the sandbox refused `rm`; it is safe to delete.
- 2026-11-09T03:01:43Z supervisor: int-identity-backend-token passed the gate in round 1
- 2026-11-09 int-identity-refused-tokens: **no code change needed.** The check passed on the first
  run after `init.sh` (1/1, ~4 s).
  Tested by hand with a tsx script outside the repo (`../tmp/manual-refused/try.ts`: real engine +
  throwaway Platform Database + fake Prometheus, synthetic identity). It made each bad token itself
  with the backend's `mintIdentityToken`: tampered (platform_read flipped false→true, old signature
  kept), expired (minted 10 min ago, ttl 300 s), wrong secret, future-dated (iat now+120 s, beyond the
  60 s skew). For each one: `platform_query('SELECT id FROM widgets')` → 42501 `source "platform" is
  the Platform Database and needs platform_read`; `promql('up', <last hour>, '1m')` → 61 rows;
  `verifyIdentityToken` rejected it (bad signature / expired / bad signature / issued in the future).
  Audit store: 0 items after the four. A good token then got count 200 and exactly 1 audit item.
  Trap: the harness fake servers stop with `close()`, not `stop()` (engine and Platform Database use
  `stop()`). My first run threw on `prom.stop` and left the Postgres running; I stopped it with
  pg_ctl and removed its tmp/e2e dir. No engine or Postgres left running, `tmp/e2e` empty.
- 2026-11-09T03:04:07Z supervisor: int-identity-refused-tokens passed the gate in round 1
- 2026-11-09 int-identity-claims-scope: **no code change needed.** The check passed on the first
  run after `init.sh` (1/1, ~4 s).
  Tested by hand with a tsx script outside the repo (`../tmp/manual-claims/try.ts`: real engine +
  throwaway Platform Database, synthetic identities, tokens from the backend's `mintIdentityToken`).
  platform_explain-only token: `platform_explain('SELECT * FROM widgets')` → 1 row (`plan`);
  `platform_query('SELECT 1')` and `platform_tables()` → 42501 `... needs platform_read`. The explain
  wrote 1 audit item (`action: query`, which matches CONTRACTS §2/§6: platform_explain is an
  Audited Query). Sys token (`sub: system:alert-evaluator`, `sys: true`, platform_read,
  `source: alert_rule`): `count(*)` over `platform_query('SELECT id FROM widgets')` worked, and the
  last audit item had `executedBySub: system:alert-evaluator`, `action: assertion`, `mode: read`,
  `status: success`, and the token's description.
  Trap: `email` is a required string even for system identities. My first try used `email: null`,
  so the token was invalid and the engine treated the connection as having no identity (42501 on
  platform_query), not as a bad token. Give system tokens a placeholder email.
  No engine or Postgres left running, `tmp/e2e` empty.
- 2026-11-09T03:06:35Z supervisor: int-identity-claims-scope passed the gate in round 1
- 2026-11-09 int-identity-agent-restricted: the check failed at first with `ParseError: Must specify
  environment variable LIGHTDASH_SECRET`: `FederationIdentityService` imports logging/winston, which
  imports `config/lightdashConfig.ts`, and that runs `parseConfig()` at import. Fix: new
  `e2e/eng-1799/setupEnv.ts`, wired in as a `test.setupFiles` entry in `e2e/eng-1799/vitest.base.ts`.
  It sets local placeholders only when unset: LIGHTDASH_SECRET (a fixed non-secret test string),
  SITE_URL, S3_ENDPOINT (`http://127.0.0.1:9`, never contacted), S3_BUCKET, S3_REGION,
  LIGHTDASH_LOG_LEVEL=error. That was enough for parseConfig; nothing else was required. Unlike
  packages/backend/setupVitest.ts, it does not mock lightdashConfig or stub fetch: the e2e checks
  need real network calls to the harness, and the backend modules should see a real parsed config.
  Engine code did not change: the engine already refuses Restricted Telemetry for agent = true.
  Tested by hand with a tsx script outside the repo (`../tmp/manual-agent/try.ts`; it imports
  setupEnv.ts first): fake Prometheus + real engine, `FederationIdentityService.mintForUser` with
  `telemetry_restricted: ['true']`. Person token on `promql(..., 'prometheus-restricted')` gave rows,
  with 1 audit item (sub = user, database prometheus-restricted, action query, status success). The
  same user minted inside `agentExecutionContext.run` got 42501 `source "prometheus-restricted" is
  Restricted Telemetry, which an AI agent identity (agent = true) may never read`. The open promql
  source still returned rows. Still 1 audit item at the end. The check passes (1/1), and so does
  int-identity-claims-scope with the new setup file.
  Next sessions: any check that imports backend services pulling in lightdashConfig now parses with
  these placeholders. If a later parseConfig needs more env, add it to setupEnv.ts.
- 2026-11-09T03:09:21Z supervisor: int-identity-agent-restricted passed the gate in round 1
- 2026-11-09 int-client-platform-functions: **no code change needed.** The check passed on the first
  run after `init.sh` (1/1, ~7 s).
  Tested by hand with a tsx script outside the repo (`../tmp/manual-platform/try.ts`, run from
  e2e/eng-1799 with `../../node_modules/.bin/tsx`; it imports setupEnv.ts first). It starts a real
  engine and a throwaway Platform Database, then builds `FederationIdentityService.createTokenProvider`
  from a synthetic user with `platform_read: ['true']`, and `warehouseClientFromCredentials`
  (postgres/federation) with `{ getIdentityToken }`. Results: `platform_query` count → 200 (max qty 6);
  `platform_tables()` → public.widgets; `platform_columns('public','widgets')` → id/name/qty, all
  NOT NULL; `platform_explain(...)` → a JSON plan (Seq Scan on widgets, Filter qty > 3). Audit store:
  4 items, each with sub/email = the user, the provider's description, `action: query`,
  `status: success`. The same client without a token provider got `... needs platform_read` on
  platform_tables(), and that wrote no audit item.
  Trap: `count(*)` comes back from the client as a JS BigInt, so `JSON.stringify` of the rows throws
  "Do not know how to serialize a BigInt". Use `Number()` or a replacer.
  No engine or Postgres left running, `tmp/e2e` empty.
- 2026-11-09T03:11:29Z supervisor: int-client-platform-functions passed the gate in round 1
- 2026-11-09 int-client-limits-and-errors: no engine or Lightdash code needed changing. The
  max_rows, 42501 and 58000 tests passed on the first run. The timeout test failed only at
  `prom.cancelled() > 0`. The engine did abandon the request (tokio timeout drops the reqwest
  future), but the fake Prometheus (`e2e/eng-1799/harness/prometheus.ts`) counted a hang-up only
  after its whole `delayMs` sleep (20 s). The check stops waiting about 17 s after the request
  starts. Fix: the fake now counts the hang-up as soon as the response's `close` fires before a
  reply, and stops waiting then. Its behaviour is otherwise the same (it still sends nothing to a
  client that hung up), and the unused `sleep` import is gone.
  Tested by hand with a tsx script outside the repo (`../tmp/manual-limits/try.ts`, run from
  e2e/eng-1799). Results: the timeout case gave a WarehouseQueryError "canceling statement due to
  statement timeout" after about 2.0 s, with 1 Prometheus request and 1 abandoned. The max_rows
  case gave "result exceeds max_rows (1000) for source "prometheus"", and the 1000-row query
  returned n = 1000. No claim gave "... Platform Database and needs platform_read". No description
  gave "audited query requires a description". A failing audit store gave "audit write failed". All
  were WarehouseQueryErrors, and none contained the minted token. The check passes (3/3), and so
  does int-harness-fake-prometheus (2/2). No engine or Postgres left running, `tmp/e2e` empty.
  Next sessions: the fake Prometheus is the only fake with a reply delay or cancel count; Loki
  and Tempo have neither.
- 2026-11-09T03:15:13Z supervisor: int-client-limits-and-errors passed the gate in round 1
- 2026-11-09 int-fix-cloudwatch-query-shape: the engine's `cloudwatch()` only read Grafana's stored
  target (camelCase `namespace`/`metricName`/`statistic`). The AWS `MetricDataQuery` shape that
  Investigate's form builds (`buildCloudWatchMetricDataQuery`) and MCP callers send failed with
  "the target has no namespace". Fix in `federation-engine/src/cloudwatch.rs`: when an object has
  any of the PascalCase keys `Id`, `MetricStat` or `Expression`, the new `Target::parse_aws` reads it
  (Grafana targets never have those keys). It accepts `MetricStat{Metric{Namespace, MetricName,
  Dimensions:[{Name,Value}]}, Period, Stat, Unit?}` or `Expression` + optional `Period` (auto when
  absent), plus `Label` and `Id`. It refuses: both/neither of MetricStat and Expression (22023), no
  Period in the MetricStat (22023), `ReturnData: false` (22023, as it would return nothing), and
  `AccountId` (0A000). `TargetMetric::Stat` gained `unit`, which only the AWS shape sets. Period
  parsing moved into `target_period` and is shared by both shapes. The
  module doc and the `CloudWatchMetricDataQuery` doc comment in common/telemetrySql.ts now say
  both shapes are read. New unit tests: the two shapes of one metric give an equal `Target` and
  an equal SDK query, plus the error cases.
  Contract assumption: CONTRACTS §1.1 says "the CloudWatch MetricDataQuery shape that Grafana's
  CloudWatch datasource stores", which can mean either shape. The engine now reads both.
  Tested by hand (`../tmp/manual-cloudwatch/try.ts`, run from e2e/eng-1799 with tsx): fake
  CloudWatch + real engine + Lightdash client. (1) Investigate's form → buildTelemetrySql →
  withTimeRangeParameters → safeReplaceParametersWithSqlBuilder → 1 row, value 42.5. (2) A Grafana
  target (period "1m", single-item dimension list) → the same row. (3) The MetricDataQuery
  from MCP's `buildCloudwatchQuery`, as a literal → the same row, series = Label. The fake saw an
  identical MetricStat each time. `{"Id":"m1"}` → "the query has neither MetricStat nor
  Expression". The check passes (1/1), as do int-harness-fake-cloudwatch and
  int-client-metric-functions.
  **Trap for int-mcp-telemetry-tools:** the real MCP tool sends `SELECT * FROM cloudwatch($1::json,
  $2, $3)` with bind parameters. Over pg-wire with `pg`, the engine answers 0A000 "Unsupported SQL type
  JSON" for the `::json` cast. This is separate from the query shape, and this feature's check passes
  the JSON as a literal. That session needs to make the engine accept a `::json` parameter cast or
  change the MCP SQL (e.g. `$1::text`).
- 2026-11-09T03:20:38Z supervisor: int-fix-cloudwatch-query-shape passed the gate in round 1
- 2026-11-09 int-time-params-engine: no code change was needed. The check already passed (2/2)
  when this session started. The pieces it uses were already in place:
  `withTimeRangeParameters` (backend AsyncQueryService/queryTimeRange.ts) →
  `resolveReservedParameterValues` (common) → `safeReplaceParametersWithSqlBuilder` → the
  federation client → the engine's promql(). Checked against CONTRACTS §2: relative bounds round
  down to the refresh interval (10 s when there is none). __interval is (to − from)/1000, rounded
  up to the nice-step list with a 15 s floor.
  Tested by hand (`../tmp/manual-time/try.ts`, run from e2e/eng-1799 with tsx) using a fake
  Prometheus and the real engine. Investigate's PromQL SQL was resolved and substituted, then run
  through the client. now-6h..now at 10:00:07.3Z gave 04:00:00Z..10:00:00Z at step 30 s, 721 rows.
  now-24h gave 10:00Z..10:00Z at 300 s, 289 rows. now-1h with a 5m refresh at 10:04:59Z gave
  09:00..10:00 at 15 s (the floor), 241 rows. No missing references. No engine left running.
- 2026-11-09T03:22:56Z supervisor: int-time-params-engine passed the gate in round 1
- 2026-11-09 int-time-cache-key: no code change was needed. The check already passed (1/1) when this
  session started. Relative bounds round down to the refresh bucket in `withTimeRangeParameters`
  (backend AsyncQueryService/queryTimeRange.ts), so the substituted SQL, and with it
  `QueryHistoryModel.getCacheKey`, stay the same inside a bucket.
  Tested by hand (`../tmp/manual-cache-key/try.ts`, run from e2e/eng-1799 with tsx) with a fake
  Prometheus and the real engine: now-15m..now with a 1m refresh at 10:00:05, 10:00:30 and 10:00:55
  gave one cache key and the window 09:45..10:00 (step 15 s). At 10:01:01 the key was different and
  the window was 09:46..10:01. 61 rows each time. No engine left running.
- 2026-11-09T03:25:03Z supervisor: int-time-cache-key passed the gate in round 1
- 2026-11-09 int-fix-alert-time-params-agree: one `formatPrometheusDuration`. Alerting's
  `common/src/alerting/durations.ts` now re-exports ldq's (`utils/timeRange.ts`) instead of having
  its own. The largest unit is now the day, so 7 days is `7d`, not `1w`. This follows recommendation 4
  above. `parsePrometheusDuration` is unchanged and still accepts `w`/`y`. Alerting's reserved
  parameters (`resolveAlertQueryParameters`) now equal ldq's `getReservedTimeParameterValues` for the
  same absolute window. Behaviour change for alerting: the formatter no longer throws on fractional
  ms; it floors them as ldq's always did. It still throws on negative or non-finite input. Updated
  the alerting unit tests (durations.test.ts: `8d` instead of `1w1d`, non-finite instead of
  fractional; queryParameters.test.ts: `__range` `7d`). Also updated the index.ts comment.
  `computeAlertQueryIntervalMs` still duplicates ldq's `getTimeIntervalMs` (same steps and floor;
  only alerting's throws on a negative range). They agree today; merging them is a possible cleanup.
  Tested: with tsx, both modules gave identical params for 10m/7d/14d/30d at 10:00Z
  (`7d` → 15m/7d, `30d` → 1h/30d). The check passes (1/1): every __interval/__range was used as a
  promql() step on the real engine and returned rows. The common alerting unit tests pass and
  common's typecheck is clean.
- 2026-11-09T03:28:11Z supervisor: int-fix-alert-time-params-agree passed the gate in round 1
- 2026-11-09 int-fix-alert-sql-parameters: implemented decision 3. In `common/src/alerting/queryParameters.ts`,
  `substituteAlertQueryParameters` now matches references the way Lightdash's `parameterRegex` does
  (`${ld.parameters.X}` or `${lightdash.parameters.X}`, no inner whitespace) and writes each value as a
  `'...'` SQL literal (`'` doubled), so it gives the same output as `safeReplaceParametersWithSqlBuilder`.
  **Decision (compat):** the alerting line's protected `backend/__acceptance__/alerting/evaluation.accept.ts`
  still uses quoted references (`'${ld.parameters.__from}'`) and expects `ts >= '2026-…Z'`. So a reference
  that is already in single quotes, together with its quotes, becomes the same single literal.
  Lightdash itself would write `''…''` there, which is invalid SQL, so the two only differ on SQL that
  Lightdash can't run anyway. Behaviour change: `${ ld.parameters.__interval }` (with spaces) is no
  longer substituted, the same as in Lightdash. The unit tests are updated to match. Examples
  (`alb-unhealthy-hosts.yml`, `platform-environment-sweep-errors.yml`) are unquoted. `alerting.md` gets
  a paragraph on the convention, and CONTRACTS §2 is amended. Tested: the check passes (2/2). The alerting
  acceptance tests still pass: backend `alert-eval-query-identity`, plus common `docs.accept.ts` and
  `ascode-shadow.accept.ts`. The common unit tests pass and its tsc is clean. By hand
  (`../tmp/manual-alert-sql/try.ts`, run from e2e/eng-1799 with tsx), with a fake Prometheus and the
  real engine: Investigate promql SQL substituted by alerting and by Lightdash was identical for
  10m/6h/7d, and each returned 1 row with value 1. A legacy quoted query also ran. No engine left running.
- 2026-11-09T03:33:51Z supervisor: int-fix-alert-sql-parameters passed the gate in round 1
- 2026-11-09 int-fix-write-confirmation-token: implemented decision 1 for Lightdash. In
  `packages/backend/src/services/FederationService/writeConfirmationToken.ts`, the minted payload now adds
  `typ: "write_confirmation"` (new export `WRITE_CONFIRMATION_TOKEN_TYPE`) and `iat` (mint time, unix s;
  `exp = iat + lifetime`, lifetime still capped at 120 s). So it is exactly the engine's encoding
  (`federation-engine/src/write.rs` `verify_confirmation`). Before this, the engine said `{valid:false}` for
  every Lightdash token. The unit test (`writeConfirmationToken.test.ts`) expects the two new keys. CONTRACTS §4.2
  has a dated note on the payload. ldq's pinned `write-confirmation-route.test.ts` uses `toMatchObject` and
  still passes (4/4). Tested: the check passes (1/1). FederationService.createWriteConfirmation
  runs against the real test-mode engine: the bound statement/user/project gives valid true; a changed
  statement, another user's bearer and another project's bearer give valid false. Backend tsc is clean.
  **Still open (next feature, int-fix-mcp-write-preview):** the MCP's `packages/telemetry-mcp/src/identity/confirmation.ts`
  still uses `stmt_sha256` and has no `typ`/`iat`. It needs the same change.
- 2026-11-09T03:37:15Z supervisor: int-fix-write-confirmation-token passed the gate in round 1
- 2026-11-09 int-write-preview: **no code change needed.** On arrival the check already passed (1/1). The previous
  feature's confirmation-token fix (`typ`/`iat`) was the only thing in the way. The Preview goes
  FederationService.createWriteConfirmation → FederationService.write (mode `preview`) → engine
  POST /v1/write and works end to end. Tested by hand (`../tmp/manual-write-preview/try.ts`, run from
  e2e/eng-1799 with tsx, against the real engine and a throwaway Platform Database) using a different statement
  from the check, `UPDATE widgets SET qty = qty + 1 WHERE id IN (3, 7) RETURNING id, qty`. It gave preview true,
  rows_affected 2, returning = the before-values + 1, and the Platform Database unchanged. The audit item had
  mode write, preview true, status success, rowCount 2, the exact sql and the description. The ticket is
  stored as `linearTicketId` (portal format), not `ticket`. Reusing the spent token for a preview or a commit
  gives 409 "already been used", the DB stays unchanged, and the token on a different statement is refused.
  The HTTP route (`FederationWriteController`, POST /api/v2/projects/{uuid}/write) can't be driven until
  int-lightdash-boot. No engine or Postgres left running.
- 2026-11-09T03:39:39Z supervisor: int-write-preview passed the gate in round 1
- 2026-11-09 int-write-commit-once: **no code change needed.** On arrival the check already passed (1/1). The
  int-fix-write-confirmation-token fix plus the engine's single-use token store were all it needed. Tested by hand
  (`../tmp/manual-write-commit-once/try.ts`, run from e2e/eng-1799 with tsx, against the real engine and a throwaway
  Platform Database) using a different statement from the check, `UPDATE widgets SET qty = qty + 10 WHERE id IN (4, 5)
  RETURNING id, qty`. Commit 1 gave preview false, rows_affected 2, returning = the new values, and the DB changed.
  Reusing the same token raised a LightdashError with statusCode 409 "this confirmation token has already been used",
  and the DB was unchanged. A fresh token for the same statement committed again (+10 more). The audit store holds
  exactly 2 write items (preview false, status success). The refused reuse is not audited as a write. Commit with
  RETURNING returns rows (the check's statement has no RETURNING, so returning is null). No engine or Postgres left running.
- 2026-11-09T03:41:47Z supervisor: int-write-commit-once passed the gate in round 1
- 2026-11-09 int-write-agent-commit-refused: **no code change needed.** On arrival the check already passed (1/1).
  `FederationService.write` throws ForbiddenError (403) on `mode: 'commit'` when `isAgentSession()` is true. It
  does this first, before loading the project or calling the engine. The engine (`federation-engine/src/write.rs`)
  refuses a commit from an identity with `agent = true` with 403 "an AI agent identity (agent = true) may only Preview,
  never commit". Tested by hand (`../tmp/manual-write-agent-commit-refused/try.ts`, run from e2e/eng-1799 with tsx,
  against the real engine and a throwaway Platform Database) using a different statement from the check, `UPDATE
  widgets SET qty = qty * 2 WHERE id IN (2, 9) RETURNING id, qty`. Results:
  - An agent commit in agentExecutionContext gave 403, the DB was unchanged and the audit store stayed empty.
  - An agent preview gave preview true with the doubled RETURNING rows, the DB was unchanged, and the audit item had
    action ai_ask, preview true, status success.
  - A person's commit (outside the agent context) applied.
  - Straight to the engine with a backend-minted bearer: agent=true commit gave 403 naming agent and the DB was
    unchanged. agent=true preview gave 200. agent=false commit gave 200 and applied (control).
  No engine or Postgres left running.
- 2026-11-09T03:44:03Z supervisor: int-write-agent-commit-refused passed the gate in round 1
- 2026-11-09 int-write-audit-integrity: **no code change needed.** On arrival the check already passed (1/1). The engine
  (`federation-engine/src/audit.rs`, `integrity_hash` + S3 body builder) already writes the portal-format item and the
  Object Lock body. Tested by hand (`../tmp/manual-write-audit-integrity/try.ts`, run from e2e/eng-1799 with tsx,
  against the real engine and a throwaway Platform Database) with statements different from the check:
  - My own re-implementation of the portal's computeIntegrityHash (written from CONTRACTS §6, not from support.ts)
    reproduces all 3 portal-computed fixtures in `federation-engine/tests/acceptance/fixtures/integrity_hash.json`
    (hmac and sha256).
  - Commit 1: an UPDATE with quotes, a backslash, ✓ and 🚀 in the SQL, a tab, unicode and an emoji in the description,
    ticket ENG-1799. Commit 2: no ticket. Both items have mode write, database platform, preview false, action query,
    status success, the right rowCount (2 and 1), errorMessage null, an integer durationMs, createdAtMonth = the
    createdAt prefix, and integrityHash equal to my recomputation.
  - S3 key = `executions/<createdAt>/<id>.json`. The body is JSON.stringify(item, null, 2) in portal key order.
  - With no ticket, `linearTicketId` is left out of the item and the body but hashed as null, as the portal does.
    `savedScriptId` is never written (Lightdash has no saved scripts). The check's key-order filter allows for that.
  The db-query-portal snapshot (`refs/db-query-portal@aea73de`) is not on this machine. The fixtures are the only
  portal-computed values available. No engine or Postgres left running.
- 2026-11-09T03:47:02Z supervisor: int-write-audit-integrity passed the gate in round 1
- 2026-11-09 int-audit-browser: **no code change needed.** On arrival the check already passed (1/1). Lightdash side:
  `FederationService.listAudit` (behind `GET /api/v2/projects/{uuid}/federation/audit`, FederationController) checks
  platform_read before it mints a token or calls the engine. Engine side: `federation-engine/src/audit_browser.rs`
  serves `GET /v1/audit` (byTicket / byUser / byMonth GSIs, 25 a page, newest first, base64 cursors). Tested by hand
  (`../tmp/manual-audit-browser/try.ts`, run from e2e/eng-1799 with tsx, against the real engine and a throwaway
  Platform Database) with data different from the check: 41 Audited Queries over 3 tickets (OPS-1 x12, OPS-2 x26,
  OPS-3 x3) and 3 users. Results:
  - Cursor walks give ticket OPS-2 = pages [25, 1] (26 unique), OPS-1 = [12], OPS-3 = [3], unknown ticket = [0].
  - Each user maps to their own ticket with the same page sizes. The current month = [25, 16] (41 unique), all newest
    first. Another month = [0].
  - With ticket and user both given, the ticket wins (portal precedence).
  - month 2026-13 gave 400 (ParameterError, before the engine). A garbage cursor and a request with no filter gave 400
    from the engine.
  - Without platform_read (no attrs, platform_read false, only platform_write) the answer is 403 and the audit store
    sees no request. Straight to the engine: 403 without platform_read, 401 without a bearer.
  No engine or Postgres left running.
- 2026-11-09T03:49:42Z supervisor: int-audit-browser passed the gate in round 1
- 2026-11-09 int-fix-attr-truthiness: decision row 8 applied as recommended: **the MCP adopts ldq's reading**. An
  attr is true when any resolved value is exactly `"true"` (so `["false","true"]` and `["true","x"]` are true;
  `"TRUE"`, `" true"`, `"yes"`, `[]` alone are false). Changed `resolveAttrs` in
  `packages/telemetry-mcp/src/auth/userMapping.ts` (Set-size check → `includes('true')`, doc comments), its unit
  test `src/auth/resolveAttrs.test.ts` (the old "conflicting set is false" cases now expect true; added a mixed set
  with no exact "true" → false) and the attrs sentence in `docs/eng-1799/telemetry-mcp.md`. ldq
  (`identityAttrsFromUserAttributes`) is unchanged; its acceptance test pins this reading. Resolution order (direct +
  group values, defaults only when there are none) is unchanged, so defaults never add a "true" next to an
  assigned "false". Tested by hand (`../tmp/manual-attr-truthiness/try.mts`, run from e2e/eng-1799 with tsx) with
  cases different from the check, through defaults, through several groups, and through the full
  `createLightdashUserResolver` against a stub `/api/v1/org/users` + `/api/v1/org/attributes` server: every case gave
  identical claims on both sides. MCP `tests/acceptance/user-attributes.test.ts` (3/3) and the unit test (4/4) pass;
  MCP tsc clean. No server left running.
- 2026-11-09T03:52:37Z supervisor: int-fix-attr-truthiness passed the gate in round 1
- 2026-11-09 int-mcp-oauth-gate: harness only, **no MCP code change** (the MCP's Okta gate, user mapping and
  no-tools server already did the right thing). New `harness/okta.ts` (`startFakeOkta()`: a FakeServer
  serving `/oauth2/default/v1/keys` with its own RS256 key and random kid, plus the authorization-server
  metadata; `issuer` = `<url>/oauth2/default`, `audience` = `OKTA_AUDIENCE` = `api://telemetry-mcp-e2e`,
  async `mintAccessToken({ sub, email?, aud?, expiresInSeconds? })`, email left out when undefined).
  New `harness/lightdashApi.ts` (`startFakeLightdashApi`: `/api/v1/org/users` substring search with
  `groups: []` when `includeGroups` is asked, `/api/v1/org/attributes` built from each user's
  `attributes` as direct assignments sending both `values` and legacy `value`, no defaults; alerting
  state/history = `[]` for the project, 404 for another; everything behind `ApiKey <apiToken>` with
  `apiToken = test-lightdash-api-token-not-real`). New `harness/telemetryMcp.ts` (`startTelemetryMcp`:
  dynamic import of `packages/telemetry-mcp/src/index.ts` by absolute path, env per the Harness API,
  `MCP_PUBLIC_URL = https://telemetry-mcp.e2e.example.test`, `LOG_LEVEL=debug` captured into
  `mcp.logs` instead of stdout; returns `{ url, logs, close() }`). `engine.ts`: `engineSources(opts)`
  and `engine.sources` (`{ name, kind, default, restricted }[]`, the rendered `[[sources]]` without
  URLs) — `MCP_SOURCES` is exactly that. Tested by hand (`../tmp/manual-mcp-oauth-gate/try.mts`, run
  from e2e/eng-1799 with tsx; the SDK must be imported by absolute path from e2e/eng-1799/node_modules)
  with cases unlike the check: no token, `Basic` auth, a same-issuer token re-signed by another key, a
  10-minute-expired token, a wrong audience and garbage all 401 (challenge with `resource_metadata` /
  `invalid_token`); a valid token initializes (200); protected-resource metadata names the fake issuer;
  a mapped user lists the 14 tools and `list_sources` returns the engine's two prometheus sources; a
  deactivated user, an unknown email and a token with no email list 0 tools and every call is an
  error naming why. Check 1/1; e2e typecheck clean. No engine left running.
  Next sessions must know:
  - `startEngine` has no `platform` in this check, but `MCP_PLATFORM_SOURCE=platform` is always set;
    platform tools are still listed (the MCP lists all 14 regardless of sources and attrs).
  - When a later check adds `restrictedLokiSelectors`, the loki source stays `restricted: false` in
    `engine.sources` (selectors restrict lines, not the source); adjust `engineSources` only if the
    MCP needs to know.
- 2026-11-09T03:57:24Z supervisor: int-mcp-oauth-gate passed the gate in round 1
- 2026-11-09 int-mcp-telemetry-tools: three changes.
  1. **Harness: fake BigQuery** (the check starts one). It was missing because int-harness-fake-bigquery
     halted with its work uncommitted. New `harness/bigquery.ts` (`startFakeBigQuery`, see the Harness API
     row); `engine.ts` gained the `bigquery` option (removed from `NOT_YET_SUPPORTED`), the `ops-marts`
     source in `engineSources`, and `HRX_BIGQUERY_TOKEN` in the env (the helper's variable is now
     `sourceEnv`). The MCP's `list_sources` already drops the per-catalog `information_schema` views, so
     this check does not depend on that halt's open question. **int-harness-fake-bigquery still fails
     only on it** (9 rows instead of 2, because DataFusion lists its information_schema views under
     every catalog); that needs the decision recorded in that halt (engine change or amended check).
  2. **Engine: bind parameters as table-function arguments** (`federation-engine/src/pg.rs`). The MCP
     sends every user value as a bind parameter (`promql($1, $2, $3, $4)`; its own acceptance test
     `sql-injection-safety` requires this). The engine planned at Parse and table functions refuse
     non-constant arguments (0A000 "arguments must be constants, not $1"). Now a Parse whose statement
     has a `$n` inside a table function's arguments is kept as a parsed statement (`Stage::AtBind`) and
     planned at Describe-portal/Execute, with each `$n` replaced by the bound value as a literal AST
     node (DataFusion's `Unparser::expr_to_sql`; never text pasting). Every other statement is
     unchanged (planned at Parse; `$n` bound into the plan). For AtBind statements: parameters are the
     declared type or text; Describe *statement* reports no columns (portal Describe does); the audit
     record's `sql` is the statement with the values in place (otherwise it would only say `$1`).
     Also a `TypePlanner` maps SQL `json` to Utf8 marked as JSON, so `$1::json` (MCP query_cloudwatch)
     and `'{}'::json` plan (before: "Unsupported SQL type JSON", the trap noted under
     int-fix-cloudwatch-query-shape). README paragraph under "SQL functions". Unit tests in pg.rs.
  3. **MCP: `limit` cast to int** (`queryLogql.ts`, `searchTraces.ts`, via a `casts` argument to
     `placeholders` in `telemetryArgs.ts`): parameters arrive as text, and the engine's `limit` must
     be an integer (42804 otherwise). Unit tests updated (`$4::int`).
  Contract assumption: CONTRACTS §1 promises the extended protocol and does not limit table-function
  arguments to constants, so the engine accepts `$n` there (narrowest reading compatible with both
  the MCP's bind-parameter rule and the engine's planning).
  Tested by hand (`../tmp/manual-mcp-telemetry-tools/try.mts` and `audit.mts`, run from e2e/eng-1799
  with tsx; synthetic values unlike the check) through the real MCP over HTTP: list_sources (all
  sources plus a `marts_x.daily` Ops Mart); query_promql range 30s, instant, explicit source, a
  hostile `x'); DROP TABLE …` query (reached the fake Prometheus verbatim, no error); the restricted
  source refused for the agent identity; query_logql forward limit 1, backward, metric; query_cloudwatch
  with an Expression and a Label containing `'`; query_cloudwatch_logs with two groups; search_traces
  limit 5 (Tempo got limit=5); get_trace and an unknown id (0 rows). With `pg` directly: bound
  promql/traceql (named statement reused with new values), a bad bound time gives 22007, `'{}'::json`
  is OID 114, and an audited bound query is audited with the literal SQL. Checks: this one 1/1;
  int-mcp-oauth-gate, int-harness-engine, int-client-log-trace-functions, int-client-platform-functions,
  int-identity-agent-restricted, int-fix-cloudwatch-query-shape, int-client-limits-and-errors pass;
  engine unit tests 95/95 and acceptance pgwire/promql/platform/ops_marts/docs pass; MCP unit tests for
  logql/traces and acceptance sql-injection-safety, tool-query-logql, tool-search-traces,
  tool-query-cloudwatch pass; e2e and MCP typecheck clean. No clippy/rustfmt on this machine.
  Next sessions must know:
  - int-mcp-platform-tools: `platform_query($1)` / `platform_explain($1)` / `platform_columns($1, $2)`
    now plan at Bind, so they should work as sent; the audit record will hold the bound SQL.
  - Engine params bound as text: any non-text table-function argument sent as `$n` needs a cast.
- 2026-11-09T04:11:48Z supervisor: int-mcp-telemetry-tools passed the gate in round 1
- int-mcp-platform-tools (round 1): **no code change needed.** The check passed after `init` on arrival:
  the previous session's engine change (table-function `$n` planned at Bind) is what makes the MCP's
  bound `platform_query($1)` / `platform_columns($1, $2)` / `platform_explain($1)` work.
  Tested by hand (`../tmp/manual-mcp-platform-tools/try.mts`, run from e2e/eng-1799 with tsx; synthetic
  users and values unlike the check) through the real MCP over HTTP with a Platform Database and the
  real engine: platform_schema listed `public.widgets` and its columns id/name/qty (an unknown table
  gives an empty list); platform_query with a `'`-containing SQL, description and ticket ENG-4242 wrote
  exactly one audit item (action ai_ask, the Lightdash user's uuid and email, description, ticket,
  mode read, database platform, status success, sql = the bound `platform_query('…')` literal);
  missing description is refused by the tool schema; a bad column gives 42703 as a tool error;
  platform_explain (advise false and default) returns the JSON plan and is audited as ai_ask; a user
  with only platform_explain can explain but platform_query is refused naming platform_read; a user
  with platform_read 'false' is refused (42501) for query, schema and explain.
  For the next session: platform_explain's default (advise unset) answers `adviceError: "Plan advice
  is not configured on this server"` in the harness, because no advice model is configured. That is
  expected, not a failure.
- 2026-11-09T04:14:07Z supervisor: int-mcp-platform-tools passed the gate in round 1
- int-mcp-restricted-hidden (round 1): **harness only; no product change needed.** The check failed
  on arrival with `startEngine: option(s) restrictedLokiSelectors not supported yet`.
  `e2e/eng-1799/harness/engine.ts` now renders `restrictedLokiSelectors` as the `loki` source's
  `restricted_selectors` (TOML strings; throws if given without `loki`). `restrictedLogGroups` is
  still in `NOT_YET_SUPPORTED`: no acceptance test uses it yet; the next session that needs it
  renders it as `restricted_log_groups` on the `cloudwatch-logs` source the same way.
  The MCP and engine already refuse: the MCP's identity token carries agent = true, so the
  engine answers 42501 and the MCP's tool error says "Access denied ... an AI agent identity
  (agent = true) may never read". Nothing is audited because the refusal happens at planning.
  Tested by hand (`../tmp/manual-mcp-restricted-hidden/try.mts`, run from e2e/eng-1799 with tsx;
  synthetic values unlike the check: selectors `{namespace="billing"}` and `{app="vault"}`, a user
  with telemetry_restricted 'yes') through the real MCP over HTTP: query_promql on
  prometheus-restricted (range and instant), query_logql with the exact selector, a regex overlap
  `{namespace=~"bill.*"}`, a metric query over `{app="vault"}` and an explicit `source: loki` were
  all tool errors naming agent; open `{namespace="web",app="site"}` LogQL and open PromQL
  answered; audit store 0 items; the fake Loki saw only the open query; Prometheus saw one request.
  Checks: this one 1/1; int-mcp-telemetry-tools, int-identity-agent-restricted, int-mcp-oauth-gate
  pass; e2e typecheck clean. No prettier on this machine.
  Trap: the fake Loki does not evaluate selectors (documented in loki.ts), so an open query
  returns every fixture stream, restricted-looking ones included. That is the fake, not a leak:
  assert on `loki.requests`, not on the rows returned.
- 2026-11-09T04:17:27Z supervisor: int-mcp-restricted-hidden passed the gate in round 1
- int-fix-mcp-write-preview (round 1): the MCP now mints confirmation tokens in the engine's encoding.
  `packages/telemetry-mcp/src/identity/confirmation.ts` payload is now
  `{v:1, typ:"write_confirmation", statement_sha256, sub, project, iat, exp, nonce}` (was `stmt_sha256`, no
  `typ`/`iat`), which is the same as the Lightdash backend's minter and `federation-engine/src/write.rs`
  `verify_confirmation`. Lifetime is still 60 s (`exp = iat + 60`, so within the engine's 120 s limit). New export
  `CONFIRMATION_TOKEN_TYPE`. Its unit test (`src/engine/write.test.ts`) now checks the new keys (9/9). MCP tsc is clean.
  Before this, every MCP write_preview got HTTP 403 "confirmation token is missing or not valid".
  Tested by hand (`../tmp/manual-mcp-write-preview/try.mts`, run from e2e/eng-1799 with tsx; synthetic values unlike
  the check) through the real MCP over HTTP with the real engine and a Platform Database:
  `UPDATE ... SET name='renamed' WHERE id=2 RETURNING id, name` gave preview true, rows_affected 1, the returned row;
  a DELETE without RETURNING gave returning null; a bad column gave a 422 tool error. The Platform Database was
  unchanged. There were 3 audit items, all action ai_ask, mode write, preview true (the bad one has status error).
  The only write tool listed is write_preview; there is no commit tool. A user without platform_write is refused by
  the MCP before it calls the engine. The check passes (1/1).
  Trap: only the exact value "true" makes an attribute true (decision 8). A user with `platform_write: 'yes'` is refused.
- 2026-11-09T04:20:42Z supervisor: int-fix-mcp-write-preview passed the gate in round 1
- int-mcp-ask-data (round 1): two gaps between the MCP's example queries and the engine, both fixed.
  1. **Engine** (`federation-engine/src/audit_browser.rs`): `GET /v1/audit` with no `ticket`/`user`/`month`
     answered 400, so ask_data's `find_example_queries` always said "Past-query examples are unavailable
     right now." It now runs the no-parameter browse that A14 asks for (decision 9): the last 30 days, newest first,
     25 a page, walking the `byMonth` partitions from the current month back to the month 30 days ago (one page can
     span more than one partition). Its cursor is base64 of `{recent: {since, month, key}}` (`since` fixed by page 1;
     `key` null starts that month from its newest record). Using a recent cursor with `month=`, or a month cursor with
     no filter, is 400. Contract assumption: the portal's exact recent browse was not available here, so this is the
     narrowest reading (window anchored at the request, no `from`/`to` params). Three new unit tests; README updated.
  2. **MCP** (`packages/telemetry-mcp/src/ask/example-queries.service.ts`): the engine audits a Platform
     Database read as `SELECT * FROM platform_query('<sql>')`. Scrubbing literals removed the whole inner query,
     so no example ever matched. Records in that form are now unwrapped to `<sql>` before the portal's filters and
     scrubbing. Other `platform_*` calls (tables, columns, explain) are skipped. Each example now also shows
     `Purpose: <description>` from its newest run, unless `looksSensitive` flags it (capped at 200 chars). The
     check requires the description. Two new unit tests (12/12).
  Tested by hand (`../tmp/manual-mcp-ask-data/try.mts` and `browse.mts`, run from e2e/eng-1799 with tsx; synthetic
  values unlike the check). Through the real MCP over HTTP with a scripted model, find_example_queries returned both
  seeded widget queries with purpose and unwrapped SQL, run_sql returned rows, and the ai_ask audit items carry the
  question and the caller's uuid. Directly on the engine, 30 records with no filter gave a 25-item page with a cursor,
  then a 5-item page with a null cursor and 30 distinct ids, newest first. A recent cursor with `month=` and a
  garbage cursor each got 400; no platform_read got 403; no token got 401.
  Checks: this one 1/1; int-audit-browser and int-mcp-platform-tools pass; MCP acceptance
  `ask-data-example-queries` 2/2 (run with `--config tests/acceptance/vitest.config.ts`); MCP tsc clean; engine
  audit_browser unit tests pass with no build warnings. rustfmt is not installed here, so the Rust file was not
  formatted by a tool.
  For review: descriptions are free text a person wrote. `looksSensitive` catches emails, phone numbers, ids and
  dates, but not names. ask_data already sends query rows to the model, so this adds no new class of data. It is
  still worth a look.
- 2026-11-09T04:28:18Z supervisor: int-mcp-ask-data passed the gate in round 1
- int-viz-engine-results (round 1): no code change needed. The check passed on a clean tree after `init.sh`: the viz
  line's `log_stream` and `trace_waterfall` already read the engine's column shapes (logql: timestamp, line,
  labels, stream; cloudwatch_logs: timestamp, message, fields; trace: trace_id, span_id, parent_span_id, service,
  name, start, duration_ms, status, attributes).
  Tested by hand (`../tmp/manual-viz-engine-results/try.mts`, run from e2e/eng-1799 with tsx; synthetic values unlike
  the check). Real engine, fake Loki/CloudWatch Logs/Tempo, Lightdash's federation warehouse client, and then
  `renderChart`. logql: four lines, newest first. Label `level: WARN` gives `warning`; lines with no level label give
  `unknown`. CloudWatch: `@message` is the line and the millisecond `@timestamp` (14:00:02.500) is kept. A 3-level
  trace gives depths 0/1/2, offsets 0/5/12 ms, durations, error status and json attributes, including a numeric one.
  An unknown trace id returns 0 rows and renders as kind `empty`, reason `noRows`.
  Trap: the script must `process.exit` at the end, because the warehouse client's pg pool keeps node alive after
  the engine stops. Note: a `severity` label is NOT read as a level. That is the viz line's documented rule (the
  `level` column, then the `level` label, then `detected_level`, else `unknown`), so it was left alone.
- 2026-11-09T04:33:59Z supervisor: int-viz-engine-results passed the gate in round 1
- int-lightdash-boot (round 1): **full boot, not service-layer** (so `docs/eng-1799/integration.md` was not
  needed yet). New harness files:
  - `harness/s3.ts` `startFakeS3()`: in-process path-style fake S3 (PutObject with aws-chunked decoding,
    GetObject, HeadObject, ListObjectsV2 with prefix/max-keys/continuation-token, DeleteObject because the
    backend's results client calls it). Other sub-resources (multipart, ACLs) answer 501, so a new need is
    visible. `objects()` lists what is stored. `decodeAwsChunked` is now exported from `auditStore.ts`.
  - `harness/lightdashDatabase.ts`: the migrated **template cluster** at `tmp/lightdash-template/<key>/pgdata`.
    `<key>` hashes the migration files (recursive), the graphile-worker version and `postgres --version`.
    It is built once (initdb, `CREATE DATABASE lightdash`, then the child in `migrate` mode runs
    `knex.migrate.latest()` with the backend's knexfile (non-ee) and graphile-worker `runMigrations`), and
    later runs reuse it. While building it lives under `tmp/e2e/lightdash-template-build-*` so init.sh reaps a
    killed build. Older keys are deleted when a new one is built. Each boot copies it with `cp -cR` (APFS clone)
    into `tmp/e2e/lightdash-*/pgdata` and starts it on a free port. A cold build costs about 6 s more.
  - `harness/lightdashServer.ts`: the child entry. lightdash.ts forks it with `node --import tsx`, cwd
    `packages/backend` (so tsx uses the backend tsconfig, like `pnpm dev`). In `serve` mode it seeds the cloned
    DB with knex inserts modelled on `database/seeds/development/01_initial_user.ts` + `13_personal_access_token.ts`.
    It creates an org, an admin user (`e2e.admin@example.test`), a PAT (`ldpat_<random>`), the Operations
    Project (`dbt_connection_type none`; the federation creds encrypted with the child's LIGHTDASH_SECRET), a
    space and space admin access. Then it runs `new App({...}).start()` (no ee arguments) and sends
    `{type:'ready', seeded}` over IPC. SIGTERM, SIGINT or a parent disconnect runs `app.stop()` and exits.
  - `harness/lightdash.ts` `startLightdash({ engine, env? })`. It returns `{ baseUrl, mode: 'full-boot', pid,
    projectUuid, organizationUuid, userUuid, userEmail, spaceUuid, apiKey, s3, close() }`. The env is minimal
    and inherits only PATH (HOME = repo tmp/): NODE_ENV=development, LIGHTDASH_SECRET (test value),
    SCHEDULER_ENABLED=false, analytics and update check off, S3_* and RESULTS_S3_* pointing at the fake, PORT,
    SITE_URL, PGCONNECTIONURI, then `env`. `close()` sends SIGTERM (SIGKILL after 15 s), waits for exit, then
    stops the fake S3 and the cluster and removes the dir.
  Tested as a user (`../tmp/manual-lightdash-boot/try.mts` and `twice.mts`, run from e2e/eng-1799 with tsx): a cold
  boot took 12.7 s and later boots about 5 s. `/api/v1/health` gave 200 (`healthy`, `requiresMigration: false`).
  The project gave 200 with `type postgres`, `flavor federation`, the engine's pg port and `httpBaseUrl`, and
  no password, user or identitySigningSecret. Federation access gave 200 with `isFederation: true` and all
  attrs false. Alerting health gave 200 `never_run`. With no auth the API gave 401. The child pid was gone
  after close. Two boots in one process with different env (`ALERTING_EVALUATOR_ATTRS`) both worked. In each,
  a SQL Runner `query/sql` `SELECT 1` came back `ready` with its row, and its results file was in the fake S3.
  The backend's own `@aws-sdk/client-s3` worked against the fake for put, get, head, list paging, the
  404s (NotFound and NoSuchKey) and delete. Checks: this one 1/1 (about 8 s warm, 14 s cold);
  int-harness-audit-store 1/1; e2e typecheck clean. `tmp/e2e` empty and no processes left.
  Next sessions must know:
  - **Not built yet** (named in the Harness API row): `setUserAttributes`, `runAlertingCycle` and
    `createSqlChart`. The backend runs in a separate process, so add each as an IPC op in
    lightdashServer.ts (for example a `{id, op, args}` request and a `{id, ok, result|error}` reply over
    `process.send`) using the App's services (`app.getServiceRepository()`) or knex, and add a parent method in
    lightdash.ts that calls it. `runAlertingCycle` needs the scheduler's tasks run by hand, because the
    scheduler worker is off. The graphile-worker schema is already in the template.
  - Seeding uses knex inserts, not services. `organization_homepage_settings` is an ee table, so it is not
    seeded. ee migrations are not applied, because there is no license key.
  - When a boot fails, the error includes the tail of the child's log. The cluster dir, with the log in it,
    is removed afterwards. A thrown error with a long message can make vitest report only a source-map
    `SyntaxError` ("Unexpected token"). When that happens, run the harness from a tsx script to see the
    real error.
- 2026-11-09T04:44:50Z supervisor: int-lightdash-boot passed the gate in round 1
- 2026-11-09 int-fix-query-path-identity: Lightdash's async query path now sends the user's identity token
  (finding 5). What changed and why:
  - `packages/backend/src/services/FederationIdentity/federationQueryIdentity.ts` (new): an AsyncLocalStorage
    scope `withFederationQueryIdentity({ userUuid, organizationUuid, projectUuid, audit })`, and
    `federationQueryAudit(requestParameters, querySurface)`, which builds the token's `audit` block: a request
    with `tileUuid` → source `tile`, `resource_uuid` = the tile; the MCP query surface → `mcp`; anything else →
    `investigate`. Description and ticket come from the `/query/sql` body's `audit`.
    Why a scope: warehouse clients are cached per project and shared by every user, so a provider can't
    be bound to one user when the client is built.
  - `FederationIdentityService.createScopedTokenProvider({ secret, projectUuid })` mints a token for the
    identity in scope. It reads the user's current attributes and their email (new optional `userModel` dep)
    on every query. It returns `null` outside a scope or for another project.
  - `WarehouseClientFactory` (new optional dep `federationIdentityService`, built in ProjectService's
    constructor) passes that provider as `getIdentityToken` to every client whose credentials are the federation
    flavour with an `identitySigningSecret`.
  - `@lightdash/warehouses`: `IdentityTokenProvider` may return `null`. In that case `FederationWarehouseClient`
    sends `RESET hrx.identity`, because the engine keeps the setting for the life of the pooled connection,
    and a query with no identity must not inherit the previous user's identity. Without a provider, nothing
    is sent (as before, and as ldq's checks pin).
  - `AsyncQueryService`: `executeAsyncSqlQuery` keeps the normalised `audit` in the request parameters, so it
    is persisted in query_history. `RunAsyncWarehouseQueryArgs.federationAudit` is filled from the request
    parameters, both on the main loop and when rebuilt from history (`buildWarehouseQueryArgs`).
    `runAsyncWarehouseQuery` runs inside the scope for registered, non-service-account users. The SQL path's
    `prepareSqlChartAsyncQueryArgs` also runs inside the scope (`withAccountFederationIdentity`), because its
    column discovery runs the user's SQL (`LIMIT 1`) on the engine. The results cache is bypassed for
    federation credentials, because a cached result would skip the engine's per-user check and the audit.
  - Harness: `startLightdash(...).setUserAttributes(Record<string,string>)` is built. It uses the real
    `/api/v1/org/attributes` API with the PAT, creates the attribute or PUTs it, and keeps other users' and
    groups' values. `runAlertingCycle` and `createSqlChart` are still not built.
  Tested as a user (`../tmp/manual-query-path-identity/try.mts`, run with
  `pnpm -F @lightdash/e2e-eng-1799 exec node --import tsx <script>`; plain `node` on PATH is v26 and the
  backend child then fails to load Sentry's native profiler, so use pnpm's pinned node). Before the
  attribute existed, a `platform_query()` SQL Runner query got POST 400 "source "platform" is the Platform
  Database and needs platform_read". The attribute API listed `platform_read` = ["true"] for the user. The
  same query with description and ticket then came back `ready` with n = 200. The engine's audit store then
  had items with sub and email = the Lightdash user, that description, ticket ENG-1799, action `query`,
  status `success`. `SELECT 1` with no audit was ready. A blank description gave 400 "An Audited Query
  needs a description". After `platform_read` = false, the query got POST 400 naming platform_read. Checks:
  this one 1/1; int-lightdash-boot 1/1; ldq `federation-client-identity` 3/3;
  `WarehouseClientFactory.test.ts` 282/282; new `federationQueryIdentity.test.ts` 4/4; warehouses,
  backend and e2e typecheck clean.
  Next sessions must know:
  - **Two audit items per SQL Runner run** on the Platform Database: the column-discovery `LIMIT 1` probe
    and the async run both execute the SQL, and the engine audits each one. A refusal therefore surfaces
    at POST time (HTTP 400 from the probe), not as an async `error` status. Checks should use
    `items.find(...)` rather than count on exactly one item.
  - Only `runAsyncWarehouseQuery` and the SQL path's preparation step are scoped. Other warehouse calls
    send `RESET hrx.identity` and run with no identity: explore compile, field-value search, the
    saved/dashboard SQL chart preparation and catalog. For saved SQL charts (int-lightdash-sql-chart), the
    preparation in `executeAsyncSqlChart*` probably needs the same `withAccountFederationIdentity` wrap.
  - Service-account and embed (JWT) queries get no identity. Alert queries are a separate feature
    (int-fix-alert-evaluator-identity).
  - No prettier config is tracked in this checkout, and a bare `prettier --write` reformats whole files
    (double quotes, 2 spaces). Use `node node_modules/.pnpm/prettier@3.7.4/node_modules/prettier/bin/prettier.cjs
    --single-quote --tab-width 4 --trailing-comma all --print-width 80`. That version still expands a few
    one-line object literals in ProjectService/AsyncQueryService, so check `git diff` for unrelated hunks.
- 2026-11-09T04:58:22Z supervisor: int-fix-query-path-identity passed the gate in round 1
- 2026-11-09 int-lightdash-sql-chart (round 1): a saved SQL chart and a time-ranged SQL Runner query run
  through Lightdash's async query path against the engine.
  Changed: only the harness. `startLightdash(...).createSqlChart({ name, sql, limit? })` is built
  (`e2e/eng-1799/harness/lightdash.ts`). It calls the real `POST /api/v1/projects/{uuid}/sqlRunner/saved`
  with the PAT, saving a table chart (`config: { metadata: { version: 1 }, type: 'table', columns: {} }`,
  limit 500 by default) in the seeded space, and returns `savedSqlUuid`. No backend change was needed:
  `query/sql-chart` and `query/sql` with `timeRange` already worked end to end on this tree.
  Tested as a user (`../tmp/manual-sql-chart/try.mts`, run with the pnpm-pinned node as before). The saved
  chart's GET returned 200, name "Synthetic up", type table, in the seeded space. `query/sql-chart` came back
  ready with 6 rows, value 1 and the `up` series. Prometheus was asked for 10:00–10:05 at step 60.
  Investigate's `buildTelemetrySql({kind:'promql'})` SQL with timeRange 09:00–10:00 came back with 241 rows,
  and Prometheus was asked for exactly start 09:00 and end 10:00 at step 15. With a 6 h range it was 721 rows
  at step 30. Checks: this one 1/1; e2e typecheck clean.
  Next sessions must know:
  - Each run asks the source **twice**: the column-discovery `LIMIT 1` probe, then the async run. This holds
    for saved charts too.
  - `executeAsyncSqlChartQuery` / `executeAsyncDashboardSqlChartQuery` preparation still runs **without**
    `withAccountFederationIdentity` (`RESET hrx.identity`). It is harmless for telemetry, but a saved SQL chart
    over `platform_query()` will probably be refused during preparation. That was left alone here because it
    is outside this feature's steps and needs an audit-description decision for saved charts (they carry none).
  - `runAlertingCycle` is still not built.
- 2026-11-09T05:01:52Z supervisor: int-lightdash-sql-chart passed the gate in round 1
- 2026-11-09 int-alert-promql-evaluates (round 1): one alerting scheduler cycle evaluates a promql() Alert
  Rule through the real engine, and the alerting API shows it firing.
  Changed and why:
  - **Backend fix** (`packages/backend/src/App.ts`): the alerting router (`/api/v2/projects/:projectUuid/alerting/*`)
    never ran Lightdash's API-key authentication. That auth is a per-route tsoa middleware, so a personal access token
    got 401 "You don't have authorization" even for an org admin. App.ts now mounts `allowApiKeyAuthenticationIfPresent`
    on `ALERTING_PROJECT_API_PATH` just before the alerting router. With no Authorization header, the session user is
    used as before. A bad token gives 401. The health route (`/api/v1/alerting/health`) is untouched and needs no auth.
    PAT, service-account and OAuth bearers now work there exactly as on tsoa routes. The MCP's alert_state/history
    calls with `ApiKey` (int-fix-mcp-real-lightdash) need this too.
  - Harness: `startLightdash(...).runAlertingCycle()` is built. lightdashServer.ts now answers IPC ops after `ready`
    (`{type:'op', id, op}` → `{type:'op-result', id, ok, result|error}`; lightdash.ts `callChildOp`). The
    `runAlertingCycle` op builds the alerting module with `createProductionAlertingModule` from the App's public
    getters, exactly as SchedulerApp does. It calls `seedTick()`, which queues an `alertingTick` for now with job key
    `alerting-tick` and replaces the self-rescheduled tick 15 s out. It then runs graphile-worker `runOnce` with a
    task list of only `alertingTick` + `alertRuleEvaluate`, which runs the tick and every evaluate job it enqueued
    until none is due. Last, it calls `notifier.flush()`. Any task that throws rejects the cycle with its error
    (graphile would only log and retry it). Cycles are serialised.
  Tested as a user (`../tmp/manual-alert-promql/try.mts`, run from e2e/eng-1799 with `pnpm exec node --import tsx`,
  with absolute `E2E_ENGINE_BINARY`/`E2E_REPO_ROOT` and TZ=UTC). Rules GET with no auth gave 401, and with a bogus PAT
  also 401. Health with no auth gave `never_run`. Creating the rule with the PAT gave 200, state normal. One cycle
  took about 40 ms. The fake Prometheus got one `query_range` for `db_cpu` with end - start = 300 s, step 15. The
  rule was `firing`: db-1 firing, value 95, labels with alertname/team/instance, summary "db-1 CPU is 95"; db-2
  normal, 10. `/state` listed only [rule, db-1, firing]. Health was `ok`, lag 0. A second cycle in the same 30 s
  slot made no new Prometheus call (the slot was already claimed). Checks: this one 1/1; int-lightdash-boot 1/1;
  backend and e2e typecheck clean; prettier check clean on the three files.
  Next sessions must know:
  - `runAlertingCycle()` evaluates a rule only once per interval slot. Within the same slot, a later cycle only
    flushes notifications (which is what the incident.io/engine-down checks rely on with groupWait 1s). To
    evaluate again, wait for the next slot (`nextSlot(seconds)` in acceptance/support.ts).
  - The evaluator's engine identity (system:alert-evaluator, attrs, audit as assertion) was not checked here.
    That is int-fix-alert-evaluator-identity's job; this unrestricted telemetry rule worked without it.
- 2026-11-09T05:08:05Z supervisor: int-alert-promql-evaluates passed the gate in round 1
- 2026-11-09 int-fix-alert-evaluator-identity (round 1): the alert evaluator now queries the engine as
  `system:alert-evaluator` (`sys: true`, `agent: false`), with the attrs from `ALERTING_EVALUATOR_ATTRS` and the
  rule's audit block (description, `source: alert_rule`, `resource_uuid` = rule uuid). The engine audits it as `assertion`.
  Changed and why:
  - `services/FederationIdentity/federationQueryIdentity.ts`: `FederationQueryIdentity` is now a union of the
    existing user identity and a new `FederationSystemQueryIdentity` (`{system: {sub, email, attrs}, organizationUuid,
    projectUuid, audit}`; guard `isFederationSystemQueryIdentity`). Existing user call sites are unchanged.
  - `FederationIdentityService.createScopedTokenProvider`: for a system identity in scope, it mints `sys: true`,
    `agent: false` (whatever the client reports) with the given sub, email and attrs. It needs no userModel.
  - `createProductionAlertingModule.ts`: `getAlertEvaluatorAttrs(env)` parses `ALERTING_EVALUATOR_ATTRS`
    (comma-separated claim names; unset or empty means none; an unknown name throws at module build, like the
    heartbeat config). `createProjectAlertWarehouseClients` takes `evaluatorAttrs` and runs every rule query
    (evaluation and "Test rule" preview) inside `withFederationQueryIdentity` built from the evaluator's
    `AlertRuleQueryContext`. Before this, the context was dropped and alert queries reached the engine with no
    identity.
  - Unit tests: a system-identity token test in federationQueryIdentity.test.ts, and getAlertEvaluatorAttrs tests.
  Decision (contract gap, narrowest reading): the engine refuses a token with a blank `email`, and §3/§4.3 name
  none for the system identity. The token's email is therefore the subject `system:alert-evaluator` (also the audit's
  `executedByEmail`), so no address is invented. int-contracts-amended should record this alongside the
  `ALERTING_EVALUATOR_ATTRS` amendment in §4.3.
  Tested as a user (`../tmp/manual-alert-identity/try.mts`, run from e2e/eng-1799 with `pnpm exec node --import tsx`,
  TZ=UTC and absolute `E2E_REPO_ROOT`/`E2E_ENGINE_BINARY`). With `ALERTING_EVALUATOR_ATTRS=telemetry_restricted`,
  a preview of a rule over `prometheus-restricted` gave `firing`. The rule was created (200), and after one cycle it
  was `firing` with value 500. The audit store held 2 items (preview and evaluation): sub/email
  `system:alert-evaluator`, action `assertion`, mode read, status success, description = the rule's description.
  With it unset, the preview returned the engine error "... is Restricted Telemetry and needs telemetry_restricted".
  After a cycle the rule was `error` with a DatasourceError instance whose annotation `error` gave the same text,
  and the audit store held 0 items. Checks: this one 2/2 (and 1 failed / 1 passed with the change stashed);
  int-alert-promql-evaluates 1/1; int-fix-query-path-identity 1/1. The two unit files pass, backend tsc is clean,
  and oxfmt was applied.
  Next sessions must know: a deployment whose rules read Restricted Telemetry or the Platform Database must set
  `ALERTING_EVALUATOR_ATTRS` on both the app and the scheduler worker (both build the module from process.env).
- 2026-11-09T05:14:42Z supervisor: int-fix-alert-evaluator-identity passed the gate in round 1
- 2026-11-09 int-alert-incident-io-lifecycle (round 1): the fake Prometheus driven through firing and resolving sends
  Alertmanager v4 payloads to a fake incident.io with the Contact Point's secret bearer, and the heartbeat URL gets
  a GET on every cycle.
  Changed and why: the alerting code (incident.io integration, notification flush, heartbeat) already worked from
  earlier merges. The only gap was the Harness API's `startRecorder()`, which was listed but never built. Added
  `e2e/eng-1799/harness/recorder.ts` (a `FakeServer` from `startFakeServer` answering 200 `{}` to everything) and
  exported it from harness/index.ts. No app code changed.
  Tested as a user (`../tmp/manual-alert-incident-io/try.mts`, run from e2e/eng-1799 with `pnpm exec node --import tsx`,
  TZ=UTC and absolute `E2E_REPO_ROOT`/`E2E_ENGINE_BINARY`): the contact point (incident_io, `secretRef` resolved from
  `ALERTING_SECRET_INCIDENT_IO_MANUAL`), routes and rule all returned 200. Cycles 1 and 2 sent one POST to
  `/v2/alert_events/alertmanager/manual`: `Bearer <secret>`, version "4", status firing, labels with alertname/instance/team,
  summary "db-1 CPU is 95", endsAt `0001-01-01T00:00:00Z`, and a 16-hex fingerprint. The rule state was `firing`.
  After the series was lowered to 20 and cycles 3 and 4 ran in the next 30s slot, there was one resolved POST with the
  same fingerprint and endsAt = slot time, still only one firing POST, and the rule state was `normal`. The
  heartbeat recorder saw 4 `GET /beat` (one per cycle). Check: 1/1. e2e typecheck is clean, and oxfmt is clean on
  the two files.
  Next sessions must know: the rule's own labels include `__name__` from the series (here `db_cpu`) next to
  alertname/instance/team. The check uses toMatchObject, so this is fine, but it is visible in incident.io payloads.
- 2026-11-09T05:18:56Z supervisor: int-alert-incident-io-lifecycle passed the gate in round 1
- 2026-11-09 int-alert-engine-down (round 1): with the engine down, an Alert Rule goes to `error` with a DatasourceError
  instance, a history transition and a DatasourceError notification.
  Changed and why: nothing in the app or harness. The errorState handling, the DatasourceError instance, history and
  notification flush already worked from the alerting merge and earlier integration features. The check passed on the
  first run after init (1/1).
  Tested as a user (`../tmp/manual-alert-engine-down/try.mts`, run from e2e/eng-1799 with `pnpm exec node --import tsx`,
  TZ=UTC and absolute `E2E_REPO_ROOT`/`E2E_ENGINE_BINARY`). The webhook contact point, routes and rule returned 200
  (rule errorState defaults to `error`). One cycle with the engine up gave `normal`. I then stopped the engine, waited
  for the next 30s slot and ran two cycles. The rule became `error` with one instance {alertname: DatasourceError,
  rulename: <rule name>, state error, annotations.error "connect ECONNREFUSED 127.0.0.1:<port>"}. History held one
  `transition` normal -> error. The webhook got one POST /hook with version "4", status firing and the DatasourceError
  alert carrying the same error annotation.
  Next sessions must know: a rule is evaluated only once per `interval` slot. Cycles run again inside the same 30s slot
  after a successful evaluation do not re-evaluate it, so a rule that went normal and then lost the engine in the
  same slot stays `normal` until the next slot. The check avoids this because the engine stops before the first evaluation.
- 2026-11-09T05:23:02Z supervisor: int-alert-engine-down passed the gate in round 1
- 2026-11-09 int-fix-mcp-real-lightdash (round 1): the MCP server maps users through the real Lightdash API, and
  alert_state/alert_history read the real alerting API with their rule filters working.
  Changed and why: this resolves decision 7 above. User mapping (`/api/v1/org/users`, `/api/v1/org/attributes`) and
  ApiKey auth on the alerting router already worked. The gap was the filters: Lightdash ignored the MCP's
  `ruleUuid`/`from`/`to`, and `/state` took no filter at all, so `alert_state {rule_uuid}` returned every rule.
  - Backend (alerting line's API): `GET .../alerting/state?rule=<uuid>` (`parseAlertStateQuery`;
    `listState(user, project, {ruleUuid})` gives that rule only, 404 for an unknown rule, 400 for a non-uuid).
    `GET .../alerting/history` also takes `until=<ISO>` (at or before; 400 if before `since`). `AlertHistoryFilters`
    in common has `until`, and `AlertStateHistoryModel.listForProject` filters `at <= until`. The `limit` stays
    exact because Lightdash applies it after `until`.
  - MCP: `alert_state` sends `rule`. `alert_history` sends `rule`, `since`, `until` and `limit`. Both also still send
    `ruleUuid`/`from`/`to`, which Lightdash ignores. **Deviation from decision 7's recommendation**: it said "the MCP
    applies `to`/`limit` itself", but the MCP line's protected check (`packages/telemetry-mcp/tests/acceptance/
    tool-alert-history.test.ts`) pins `ruleUuid`, `from`, `to` and `limit=25` in the query it sends. Filtering `to`
    locally would make `limit` wrong, so `until` went into Lightdash instead, and the old names are kept to keep that
    check green. Once that check is allowed to change, drop the duplicate names.
  - docs/eng-1799/alerting.md lists the new parameters. New unit tests cover the backend parsers
    (AlertRuleService.test.ts, 17/17), and the MCP unit tests were updated (alertState 9/9, alertHistory 14/14).
  Tested as a user (`../tmp/manual-mcp-real-lightdash/try.mts`, run from e2e/eng-1799 with `pnpm exec node --import
  tsx`, TZ=UTC and absolute `E2E_REPO_ROOT`/`E2E_ENGINE_BINARY`): Lightdash with two promql rules (db_cpu 95,
  queue_depth 500, threshold 90) and one alerting cycle. Over REST, `state?rule=<queue>` returned only that rule,
  `state?rule=nope` returned 400 and `history?until=2000-...` returned 0 entries. Over the MCP (14 tools), alert_state
  listed both rules firing, `{rule_uuid: cpu}` returned only the CPU rule, `alert_history {rule_uuid: queue}` returned
  one queue transition normal -> firing, `{to: now-1d}` returned 0 and `{from: now-1h, to: now}` returned 2.
  With Lightdash attribute platform_read=false, platform_query was refused ("needs platform_read"). After setting it to
  true, a new session (upper-case email) got n=200, and the audit item was `ai_ask` with executedBySub = the Lightdash
  user uuid.
  Checks: int-fix-mcp-real-lightdash 1/1. MCP line tool-alert-state 4/4 and tool-alert-history 3/3. Alerting line
  `shadow-ascode-ai.accept.ts -t '^alert-ai-'` 2/2. tsc is clean in backend, common and telemetry-mcp, and oxfmt
  made no changes.
- 2026-11-09T05:30:47Z supervisor: int-fix-mcp-real-lightdash passed the gate in round 1
- 2026-11-09 int-assumptions-register (round 1): new `docs/eng-1799/contract-assumptions.md`. It has one table row for
  every numbered contract assumption (engine A1–A30, ldq 1–12, mcp 1–10, alerting 1–8, viz 1–7). It also has rows
  for assumptions that were recorded only in session logs: `ldq-log-1..8`, `mcp-log-1..7`, `alerting-log-1..8`,
  and `integration-log-1..5` for this line's own readings. Each row has a Kept, Changed or Superseded decision and
  a source feature. Every Changed row names its int-fix feature, and a summary table at the top lists the
  cross-line conflicts (findings 1–8) with the winning and losing sides. There are 14 Changed rows: engine-A19,
  ldq-2/3, ldq-log-1/8, mcp-2/4, mcp-log-1, alerting-1/5 and alerting-log-1/2/3/5.
  `PROGRESS-mcp.md`: the session-log "Contract assumption 9" (example-query paging, from
  mcp-example-queries-port) and "10" (engine-side Ask audit and catalog, from mcp-data-assistant-port) are now items 9
  and 10 of its numbered list. The text is unchanged and each item says where it came from.
  Decisions worth a look in the morning:
  - **alerting-7 is Superseded.** Its numbered list says the ADR 0003 routing bugs are fixed in the as-code tree, but
    alert-grafana-port-examples later chose not to apply them (alerting-log-4). Their target channels are still a
    human decision.
  - engine-A6 and ldq-8 are Kept. In each pair the other side changed (ldq-3 and mcp-4 for A6, engine-A19 for ldq-8).
  Tested as a user: I read the doc top to bottom and checked every table row has 5 cells (no stray `|` in the
  text). I counted rows per line (engine 30, ldq 20, mcp 17, alerting 16, viz 7, integration 5) and listed the
  Changed rows with their int-fix ids. All 9 `int-fix-*` features appear. Source feature ids were checked against
  the feature headings in each line's progress file. Check: int-assumptions-register 2/2.
  For int-contracts-amended: use the Changed rows and integration-log-1..5 as the list of CONTRACTS amendments.
- 2026-11-09T05:36:29Z supervisor: int-assumptions-register passed the gate in round 1
- 2026-11-09 int-contracts-amended (round 1): docs only. `docs/eng-1799/CONTRACTS.md` now has dated notes
  ("amended 2026-11-09, <int-fix id>") for the readings this line settled. The Changed rows and integration-log-3/5 of
  contract-assumptions.md were used as the list:
  - §1.1 `cloudwatch()` accepts both shapes: Grafana's stored target (metricEditorMode builder/code mode,
    Metrics Insights refused) and the AWS MetricDataQuery (Id/MetricStat/Expression), with the SQLSTATEs for its errors
    (engine-A19).
  - §2: the old one-line note is now a full "Quoting in SQL" amendment. It covers bare `${ld.parameters.__from}` and
    `${lightdash.parameters.*}`, values written as `'...'` literals with `'` doubled, alerting producing Lightdash's SQL,
    the legacy quoted-reference compatibility, and the shared duration formatter (alerting-log-1/2).
  - §3: attrs are true when any value is exactly "true" (mcp-log-1). With no identity in scope, a federation client sends
    `RESET hrx.identity` (ldq-2, ldq-log-8).
  - §4.2: the inline note is now a full amendment with the payload JSON (`typ`, `statement_sha256` hex, `iat`, `nonce`).
    It covers the 60 s iat skew and 120 s lifetime, and says that single use is engine-only (spent by signature) and that the MCP mints the same
    token (ldq-3, ldq-log-1, mcp-4).
  - §4.3: `ALERTING_EVALUATOR_ATTRS` (comma-separated claim names, unknown name fails module start), the system token
    and audit block, and email = `system:alert-evaluator` (alerting-1, alerting-log-5, integration-log-3).
  - §7: the alerting state/history query parameters (rule, since, until, limit 100/1000), and the duplicate
    ruleUuid/from/to kept for the MCP's pinned check (mcp-2, alerting-5, alerting-log-3, integration-log-5).
  Every detail was checked against the code (engine cloudwatch.rs/write.rs, getAlertEvaluatorAttrs, MCP
  confirmation.ts and alerting.ts, AlertRuleService history parser) rather than only against the progress notes. The
  §4.1 note and all other text are unchanged.
  Tested as a user: I read the amended sections in place and checked each claim against its source. Check:
  int-contracts-amended 1/1. No server was started.
- 2026-11-09T05:40:36Z supervisor: int-contracts-amended passed the gate in round 1
