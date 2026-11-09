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
- 2026-11-09 int-docs-integration (round 1): docs and a runner only, no product code changed.
  - New `docs/eng-1799/integration.md`. It covers how to run the suite (`bash ./init.sh`, the protected
    `acceptance/run.sh`, `run-all.sh`) and the ground rules (No Docker, ephemeral ports, `tmp/e2e` layout,
    caps). A Harness section has one row per `start*` helper and says `startLightdash` is a full boot, not
    service-layer. "What each check proves" has one row per acceptance file (50) in feature order, with
    its kind. "Open checks" describes the two failing checks. "Reconciled assumptions" links
    `contract-assumptions.md` and lists the 8 code-changing conflicts with their int-fix checks.
  - New `e2e/eng-1799/run-all.sh` (executable). It runs every `acceptance/*.test.ts` in name order, each
    through `acceptance/run.sh`, and takes an optional id prefix (`run-all.sh int-write-`). It keeps going
    after a failure, prints passed/failed counts and the failed ids, and exits non-zero on any failure.
  Tested as a user: I read the doc. I ran `bash e2e/eng-1799/run-all.sh` for the whole suite: 48 passed and
  2 failed, 370 s. No process or `tmp/e2e` dir was left behind. Check: int-docs-integration 2/2.
  Next sessions must know: the two failures do not share a cause.
  - `int-harness-fake-bigquery` gets 9 rows: DataFusion's information_schema views are listed under the
    ops_marts catalog. This needs a decision (engine change or amended check).
  - `int-client-catalog` gets past `getAllTables` but fails on `getFields`. `hour` and `fills` come back as
    `string`, not `timestamp`/`number`, so the Ops Mart column types that reach Lightdash through
    information_schema.columns are wrong.
  When those pass, update the "Open checks" section and the "Not passing yet" notes in rows 9 and 11 of
  integration.md.
- 2026-11-09T05:51:07Z supervisor: int-docs-integration passed the gate in round 1
- 2026-11-09 int-harness-fake-bigquery (round 1): no product code changed. The check was amended by the
  controls engineer in 3e018f8ce (it now filters out `table_schema = 'information_schema'`). With that,
  the existing fake (harness/bigquery.ts) and the engine's ops-marts source pass as they are.
  - `docs/eng-1799/integration.md`: row 9 drops "Not passing yet" and records the amendment. "Open
    checks" marks this check settled (DataFusion's information_schema views stay listed under every
    catalog, as Postgres does) and leaves `int-client-catalog` as the only open one.
  Tested as a user: a throwaway driver (in ../tmp, since deleted) started the fake BigQuery with the two
  OPS_MART_TABLES and the real engine, then queried over the pg wire. Unfiltered information_schema.tables
  for ops_marts gave 9 rows (7 information_schema views and fills_hourly, queue_depth). Filtered, it gave
  exactly the 2 mart tables. `SELECT site, fills FROM ops_marts.ops_marts.fills_hourly` gave 2 rows, and
  queue_depth count 1. The fake recorded 2 table GETs and 2 query POSTs. No engine process was left.
  Check: int-harness-fake-bigquery 1/1; int-docs-integration 2/2 after the doc edit.
  Next session (int-client-catalog) must know: information_schema.columns.data_type for Ops Marts is the
  Arrow type name (`Timestamp(µs, "UTC")`, `Utf8`, `Int64`, `Float64`), not a Postgres type name. That
  is probably why getFields maps `hour` and `fills` to `string`.
- 2026-11-09T05:55:29Z supervisor: int-harness-fake-bigquery passed the gate in round 1
- 2026-11-09 int-client-catalog (round 1): client fix in packages/warehouses, no engine change.
  - Cause: the engine's `information_schema.columns.data_type` is DataFusion's Arrow type name
    (`Timestamp(µs, "UTC")`, `Utf8`, `Int64`, `Float64`). The Postgres type map read every one of them as
    `string`. CONTRACTS §1.1 names DataFusion's information_schema as the catalog, so the client adapts.
  - `PostgresWarehouseClient.ts`: `PostgresClient` has two new protected hooks,
    `mapCatalogFieldType(dataType)` and `getCatalogTimestampDomain(dataType)`. They default to the
    existing Postgres behaviour, and `getCatalog` and `parsePostgresCatalog` (`getFields`) call them.
    The internal `mapFieldType` is now exported as `mapPostgresFieldType`. Postgres and Redshift behave
    as before.
  - `FederationWarehouseClient.ts`: new `mapFederationFieldType` maps Arrow names (Int*/UInt*/Float*/
    Decimal* to number, Date32/64 to date, Timestamp(..)/Time32/64(..) to timestamp, Boolean to boolean,
    Utf8 etc. to string) and falls back to the Postgres map for anything else. The timestamp domain is
    left undefined for engine columns. Trap: the domain sidecar `__lightdashTimestampDomains` is a plain
    string key on the catalog, so setting one would break the protected check's `toEqual` on getFields.
    A follow-up could classify `Timestamp(.., "UTC")` as `aware` if the check is amended.
  - New unit test `FederationWarehouseClient.test.ts` (18 cases).
  - `docs/eng-1799/integration.md`: row 11 and "Open checks" now mark this check settled.
  Tested as a user: a throwaway driver (temporary vitest config plus a test file in e2e/eng-1799, both
  deleted) started the fake BigQuery with OPS_MART_TABLES and the real engine and used
  `warehouseClientFromCredentials` (FederationWarehouseClient). Raw information_schema.columns showed the
  Arrow names. getAllTables listed both Ops Marts. getFields(queue_depth) gave at=timestamp, depth=number,
  and getCatalog gave fills_hourly hour/site/fills = timestamp/string/number. The preview query returned
  2 rows with fills typed as an integer number. No engine was left running.
  Checks: int-client-catalog 1/1; int-client-connect, int-client-platform-functions,
  int-harness-fake-bigquery and int-docs-integration pass. Unit: Federation 18/18, Postgres 35/35.
  warehouses tsc clean. eslint/prettier are not installed in this tree, so they were not run.
- 2026-11-09T06:00:45Z supervisor: int-client-catalog passed the gate in round 1

---

# Line `demo`: the end-to-end demonstration and promo video

This section is the hand-off between the demo line's sessions. Each session starts with an empty memory: read
this whole section first, then `CONTEXT.md` (glossary: use its terms, never its `_Avoid_` terms), `docs/adr/0001`-
`0004`, `docs/eng-1799/CONTRACTS.md`, and the `PROGRESS-<line>.md` of the piece you are wiring.

The goal: `demo/eng-1799/up.sh` brings up a complete local HouseRx-like observability stack with live synthetic
telemetry (no Docker, no network); a Playwright walkthrough drives the real UI through an incident in eight
recorded scenes; `pnpm -F eng-1799-demo video` turns the recordings into a short promo MP4; `run-all.sh` does it
all. The feature list (45 entries, ids `demo-*`) is kept by the supervisor. **Take features strictly in order.**

## How to run things

| What | Command (repo root) |
|---|---|
| Prepare the tree | `bash ./init.sh` (it runs the integration line's init, then `scripts/eng-1799/init-demo.sh`; see the top of `init.sh`) |
| One feature's check | its `check`, e.g. `bash demo/eng-1799/acceptance/run.sh --stack platform-db.spec.ts` |
| A check with a grep | `bash demo/eng-1799/acceptance/run.sh --stack alert-lifecycle.spec.ts --grep "demo-alert-fires:"` |
| Bring the stack up / down by hand | `bash demo/eng-1799/up.sh` / `bash demo/eng-1799/down.sh` |
| Regression gate (the supervisor sets it later) | `pnpm -F common typecheck && pnpm -F backend typecheck && pnpm -F frontend typecheck && pnpm -F @lightdash/cli typecheck && pnpm -F eng-1799-demo typecheck` |

- **`init.sh` starts no server.** The goal and `specs/goal-common.md` say init only installs and builds; that
  overrides the generic "init starts the app" step. `scripts/eng-1799/init-demo.sh` checks the Postgres binaries,
  makes sure ffmpeg-static's binary and Playwright's chromium exist, rebuilds the **frontend production build**
  (`pnpm -F frontend build`, about 15 s, into `packages/frontend/build`) when its inputs changed, and checks the
  engine binary and `packages/telemetry-mcp/dist`. Stamps and logs: `tmp/.demo-init/`. Add demo build steps there.
- **`acceptance/run.sh [--stack] <spec> [playwright args]`** (protected) runs ONE spec with
  `pnpm -F eng-1799-demo exec playwright test --config acceptance/playwright.config.ts`. With `--stack` it runs
  `down.sh`, then `up.sh` (output in `tmp/demo-acceptance/up.log`), then the spec, and **always** `down.sh` on exit
  (trap). `DEMO_*` env passes through to `up.sh`. Playwright output: `tmp/demo-acceptance/test-results/`.
- **`ps` is blocked in the factory sandbox** (`operation not permitted`). Use `pgrep -lf <regex>` (works) or pid
  files. The checks use `pgrep -lf <path of .state>` to prove nothing is left running.
- `/tmp` may not be writable; use the repo's `tmp/` (gitignored) for scratch, and `demo/eng-1799/.state/` for stack state.
- Postgres: `/opt/homebrew/bin/{initdb,pg_ctl,postgres}`; `psql` is blocked. Listen on `127.0.0.1`, a free port,
  `unix_socket_directories=''` (socket paths are longer than macOS allows). Use the `pg` package (in the demo
  package) to run SQL.
- Machine etiquette: one check at a time; `CARGO_BUILD_JOBS=2`; `-threads 2` for ffmpeg; stop what you start.

## State at hand-off (init session, 2026-11-08)

- `demo/eng-1799/package.json`: the workspace package `eng-1799-demo` (in `pnpm-workspace.yaml`, lockfile
  updated) with devDependencies only: `@playwright/test` 1.63.0 (chromium-1243 is installed in the user cache),
  `ffmpeg-static` 5.3.0 (binary downloaded at **install** time; allowed in `allowBuilds`), `pg` 8.13.1, `@types/pg`,
  `@types/node`, `tsx`, `typescript` 7.0.2. **`scripts` is empty**: `typecheck`, `walkthrough`, `video` and `ask`
  are features. No source, no `up.sh` yet. Every check fails today.
- `demo/eng-1799/acceptance/**` (**protected**): `run.sh`, `playwright.config.ts`, `helpers/stack.ts`,
  `helpers/scenarioWindows.ts` and 40 spec files covering the 45 features.
- `.gitignore`: `/demo/eng-1799/.state/`, `/out/`, `/test-results/`, `/playwright-report/`, and every audio
  extension under `/demo/`.
- `init.sh` loops over `viz ldq mcp alerting engine demo`; `scripts/eng-1799/init-demo.sh` is new.
- Measured on this machine (feasibility smoke, not committed): a fresh Lightdash Postgres migrates in **16 s**
  (`pnpm -F backend migrate`, core migrations only with `LIGHTDASH_LICENSE_KEY` empty); the backend started with
  `tsx src/index.ts` answers `/api/v1/health` after **22 s**, serves the production frontend at `/` (200), and its
  in-process scheduler made `GET /api/v1/alerting/health` report `ok`. It **refuses to start without S3**
  (`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`): the demo needs a local S3-compatible fake (see below).
- `tmp/demo-smoke/` may hold that smoke's stopped Postgres data dir; it is scratch, delete it freely.

## Pinned interfaces (the protected tests use exactly these; build to them)

### Files and commands

| Path / command | Contract |
|---|---|
| `demo/eng-1799/up.sh` | Validates `DEMO_INCIDENT_AT` / `DEMO_RECOVERY_AT` (integers, seconds, `0 <= incident < recovery`; default 90 and 300) **before starting anything**, naming the bad variable on failure. Starts everything in the background on free `127.0.0.1` ports, seeds (itself or via `seed.sh`), writes `.state/stack.json`, prints `Lightdash: <lightdash.url>` and exits 0 once everything answers. Idempotent: if the stack is already up it prints the same line and changes nothing (same pids). All state under `demo/eng-1799/.state/`. |
| `demo/eng-1799/down.sh` | Stops every process it started (process groups), so that no process's command line mentions `.state`, every pid in `stack.json` is gone and every port is closed. Exit 0 also when nothing runs. |
| `demo/eng-1799/run-all.sh [--keep]` | up, seed, `scenario/restart` with the `DEMO_*` offsets, `walkthrough/run.sh` (all scenes), the video build, then down (skipped with `--keep`). Non-zero on the first failure, and still down (trap). |
| `demo/eng-1799/walkthrough/run.sh [scene-id ...]` | Runs the given scenes (default: all eight, in order) against the RUNNING stack; never restarts the scenario clock; writes `demo/eng-1799/out/scenes/<scene-id>/video.webm` (1920x1080) and `key-moment.png` (1920x1080). Exit non-zero if a scene's assertions fail. |
| `demo/eng-1799/walkthrough/<scene-id>.spec.ts` | One Playwright spec per scene, ids `01-sign-in 02-incident 03-alert-fires 04-service-health 05-investigate 06-ai-question 07-write-mode 08-recovery`. Each asserts what it shows (the checks require at least 3, or 4 for scenes 04 and 07, `expect(` calls). Wait on the scenario clock and on UI state with deterministic waits; no long sleeps. Standalone runs must work: the checks restart the scenario, then run one scene. |
| `out/scenes/06-ai-question/answer.json` | The scripted client's output for scene 6 (same shape as `ask --json`). |
| `pnpm -F eng-1799-demo ask --json "<question>"` | Scripted MCP client, no real model: gets a token from the fake Okta for the demo user, calls telemetry-mcp (`query_promql` or `ask_data`), prints ONE JSON line `{question, tool, arguments, query, result: {columns: string[], rows: unknown[][]}, answer}`. "fill queue backlog" questions query `hrx_fill_queue_backlog`; numeric cells are numbers or numeric strings. |
| `pnpm -F eng-1799-demo video [--scenes-dir D] [--out O] [--music F]` | `demo/eng-1799/video/build.ts` (or `.sh`). Default D = `out/scenes`, O = `out`. Writes `O/eng-1799-demo.mp4` (H.264, 1920x1080, exactly 30 fps, AAC only with `--music`), `O/thumbnail.png` (or `.jpg`, 1920x1080 or 1280x720), `O/CHAPTERS.md`. Title card: a distinct card (not drawn over scene 1), 2-7 s, "Lightdash for HouseRx operations". Every scene in full, in order, with a lower-third caption. Crossfades (a real mix, `xfade=fade`), at most 1.5 s. End card: distinct from the last scene. `--music`: faded in and out (the check wants the first 0.4 s and last 0.5 s at least 10 dB under the middle); a missing file exits non-zero naming it. Uses `ffmpeg-static` only. |
| `CHAPTERS.md` | Exactly ten chapter lines `- mm:ss Title` (title card at `00:00`, the eight scenes, the end card), increasing times, distinct titles. |
| `pnpm -F eng-1799-demo typecheck` | `tsc` over the demo's TypeScript, **acceptance folder included** (it typechecks with `--strict --module nodenext --moduleResolution nodenext --lib es2022,dom --types node --skipLibCheck --esModuleInterop`; mirror that in `demo/eng-1799/tsconfig.json`). |
| `docs/eng-1799/demo.md` | See the `demo-docs` check: headings for prerequisites, one command, presenting live, timeline, scenes, music; mentions `run-all.sh`, `--keep`, `up.sh`, `down.sh`, `pnpm -F eng-1799-demo video`, `--music`, licensing, `DEMO_INCIDENT_AT`, `DEMO_RECOVERY_AT`, `T+90s`, `T+5min`, every scene id, the frontend mode (production build) and why. |
| `demo/eng-1799/seed/grafana/*.json` | A synthetic Grafana dashboard JSON (no HouseRx hosts) whose every non-row panel title is a Tile title of one seeded dashboard. |
| `demo/eng-1799/seed/portal-scripts.json` | A synthetic portal saved-scripts export (`[{id, title, sql, ...}]`); `seed.sh`/`up.sh` must call `lightdash import portal-scripts`. The SQL is Platform Database SQL, kept verbatim. |

### `.state/stack.json`

```jsonc
{
  "lightdash":  { "url": "http://127.0.0.1:<port>", "projectUuid": "<Operations Project uuid>" },
  "demoUser":   { "email": "<something>@example.com", "password": "<fake>" },
  "scenario":   { "url": "http://127.0.0.1:<port>" },
  "prometheus": { "url": "..." }, "loki": { "url": "..." }, "tempo": { "url": "..." }, "cloudwatch": { "url": "..." },
  "engine":     { "host": "127.0.0.1", "pgPort": 0, "httpUrl": "...", "user": "lightdash-operations",
                  "password": "<fake>", "database": "operations", "identitySecret": "<fake, shared with Lightdash and MCP>" },
  "platformDb": { "host": "127.0.0.1", "port": 0, "user": "<cluster superuser>", "password": "<fake>", "database": "<db>" },
  "incidentIo": { "url": "..." },
  "mcp":        { "url": "..." },
  "okta":       { "issuer": "..." },
  "processes":  [ { "name": "engine", "pid": 123 }, ... ]   // every process up.sh started
}
```

- Every `*.url` / `*Port` is on 127.0.0.1 and never a well-known port (5432, 5433, 8080, 8088, 3000, 9090, 3100, 3200).
- `platformDb` is the cluster superuser (checks read `data_directory` and `pg_roles`). The engine uses its own
  read and write roles. Names of processes: the engine's contains `engine`, telemetry-mcp's `mcp`, Lightdash's
  `lightdash` or `backend`.
- Fake secret values look like `test-...-not-real`; the demo user email ends in `@example.com`.

### Scenario clock and data

- `GET {scenario.url}/scenario` → `{startedAt, incidentAt, recoveryAt, now, phase: 'baseline'|'incident'|'recovered'}` (ISO strings).
- `POST {scenario.url}/scenario/restart` with `{incidentAfterSeconds, recoveryAfterSeconds}` (may be negative)
  restarts the timeline at now and returns the same shape. Data at time t is a pure function of t and the current
  timeline, so a timeline shifted into the past fills look-back windows at once (`helpers/scenarioWindows.ts`).
- **Prometheus** `hrx_fill_queue_backlog` (label `queue`, at least `queue="fill"`; also with `{queue="fill"}`, and
  `promql_instant`): baseline values in `[0, 60]` and not constant; from `incidentAt+30s` to `recoveryAt`, at least
  120; from `recoveryAt+60s`, at most 60. The Alert Rule threshold is 100.
- **Loki** `{app="fill-service"}`: lines contain `level=info` / `level=error` (logfmt). `|= "level=error"` gives at
  most 2 lines/min in the baseline and at least 10/min from `incidentAt+30s` to `recoveryAt`, and incident error
  lines mention `shipping-label-api`. `sum(count_over_time({app="fill-service"} |= "level=error" [1m]))` agrees.
- **Tempo**: `{ resource.service.name = "fill-service" }` returns at least 2 traces/min (root service
  `fill-service`, at least 3 spans, one child span of service `shipping-label-api`); adding `&& duration > 2s`
  returns only incident traces (at least 1/min), whose `shipping-label-api` span is at least 2000 ms; baseline
  downstream spans are under 500 ms.
- **CloudWatch** `GetMetricData`: Grafana target `{namespace: AWS/SQS, metricName: ApproximateNumberOfMessagesVisible,
  dimensions: {QueueName: hrx-demo-fill-queue}, statistic: Maximum, period: 60}` follows the backlog numbers.
  The engine's `aws-sdk-cloudwatch` speaks **Smithy RPC v2 CBOR**; see `federation-engine/tests/acceptance/harness/aws.rs`
  for the wire details your Node fake must answer (also JSON 1.1 for Logs, JSON 1.0 for DynamoDB, REST for S3).
- **CloudWatch Logs Insights** on `/hrx/demo/fill-service`: messages containing `ERROR` follow the error-log numbers;
  support `fields ... | filter @message like /X/ | sort ... | limit N` and plain `fields ... | limit N`.
- **incident.io fake**: `POST {incidentIo.url}/webhook` (Alertmanager v4 JSON, any bearer) records it;
  `GET {incidentIo.url}/api/received` → `{notifications: [{receivedAt, payload}]}` in arrival order;
  `GET {incidentIo.url}/` is an HTML page titled with "incident.io" with one table row per received alert
  (alertname and status `firing`/`resolved`).
- **Okta fake**: `POST {okta.issuer}/v1/token` with `{"email": "..."}` → `{access_token}` (RS256 JWT, iss = issuer,
  aud = the MCP's `OKTA_AUDIENCE`); JWKS at `{okta.issuer}/v1/keys`. Demo only.

### Names the seed must use

Project name contains `Operations` (flavor `federation`). Dashboards `Pharmacy Ops overview` (with a Dashboard
Time Range; Tiles `Fill queue backlog` (time series, `thresholds` with a step at 100), `Current fill queue backlog`
(stat), a bar gauge titled `... by queue`, a Tile with `valueMappings`), `Service health` (a `log_stream` Tile, a
`trace_waterfall` Tile, a Tile titled with "heatmap" or "state timeline"), `Platform DB` (at least two `sql_chart`
Tiles calling `platform_query`). Alert Rules `Fill queue backlog high` and `Fill service error log rate`, neither
paused nor shadow, routed to an `incident_io` Contact Point whose URL starts with `incidentIo.url` and whose token is
a `secretRef`. The demo user has user attributes `platform_read` and `platform_write` = `true`.

## Suggested architecture (nothing is built yet; change it if you must, keep the pins)

- `demo/eng-1799/stack/*.ts`: small Node servers run with `tsx` (or plain node), no new runtime deps unless needed:
  one **scenario + telemetry fakes** process (scenario API, Prometheus, Loki, Tempo, CloudWatch + Logs on separate
  ports, sharing one clock), one **AWS fakes** process (DynamoDB `PutItem`/`Query` over the portal GSIs, and an
  S3-compatible store for both the engine's audit objects and **Lightdash's results**: path-style
  Put/Get/Head/List/Delete, multipart if Lightdash uses it), the **incident.io** fake, the **Okta** fake.
  Deterministic data: seeded hash of (series, time bucket), never `Math.random()`.
- `up.sh`: pick free ports (node `net.listen(0)`), write configs into `.state/`, start each server in its own
  process group with logs in `.state/logs/`, record pids, wait for each to answer, then seed. `down.sh`: TERM each
  group, wait, KILL leftovers, `pg_ctl stop` both clusters. Make `up.sh` detect a live stack via `stack.json` pids.
- **Engine**: `tmp/cargo-target/debug/engine --config .state/engine/federation-engine.toml` (the binary the root `init.sh` builds; the `e2e/eng-1799` harness uses the same one). Keys are in
  `PROGRESS-engine.md` ("Config"). Give AWS clients `endpoint_url`/`dynamodb_endpoint_url`/`s3_endpoint_url`, set fake
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`, `AWS_EC2_METADATA_DISABLED=true`; leave `role_arn` out
  unless you also fake STS. `platform_postgres` needs `read_url_env`/`write_url_env` and `[audit]` (fail-closed:
  without a working audit store every Audited Query fails with 58000).
- **Lightdash backend**: `pnpm -F backend migrate`, then `tsx packages/backend/src/index.ts` (production
  `node dist/index.js` needs `pnpm -F backend build`; tsx boots in about 22 s). Env seen to work: `PGHOST/PGPORT/
  PGUSER/PGPASSWORD/PGDATABASE`, `LIGHTDASH_SECRET`, `SITE_URL`, `PORT`, `LIGHTDASH_LICENSE_KEY=` (empty: core
  migrations only, pgvector is absent), `S3_ENDPOINT/S3_BUCKET/S3_REGION/S3_ACCESS_KEY/S3_SECRET_KEY` (→ the S3
  fake; check whether Lightdash needs path-style/force-path env). Also set `TZ=UTC`,
  `RUDDERSTACK_ANALYTICS_DISABLED=true` and anything else that phones home (no network: grep parseConfig for
  `https://`), `ALERTING_SECRET_<NAME>` for the incident.io token (`ALERTING_SECRET_INCIDENT_IO_DEMO` for
  `secretRef: incident-io-demo`). The scheduler ran in-process in the smoke (alerting health `ok`); check
  `SCHEDULER_ENABLED` and the scheduler's task list if you split it out. The frontend is the production build in
  `packages/frontend/build`, served by the backend (say so in `docs/eng-1799/demo.md`).
- **Seeding**: first user/org through the API (`/api/v1/register` or the org-registration flow the health
  endpoint asks for: `requiresOrgRegistration: true`), a personal access token, then the CLI from source
  (`pnpm -F @lightdash/cli exec tsx src/index.ts ...` with `LIGHTDASH_URL`, `LIGHTDASH_API_KEY`) for `upload`,
  `upload --alerting-only` and `import portal-scripts`; user attributes and groups through the API. The project is
  `type: postgres, flavor: federation` with `identitySigningSecret` = the engine's identity secret and `httpBaseUrl`
  = the engine's HTTP URL. The alert evaluator's system identity needs `platform_read` only if a rule reads the
  Platform Database.
- **telemetry-mcp**: `node packages/telemetry-mcp/dist/main.js` with the env in `PROGRESS-mcp.md` ("Env vars"):
  `OKTA_ISSUER`/`OKTA_AUDIENCE`/`OKTA_JWKS_URI` → the Okta fake, `LIGHTDASH_URL` + a service account/PAT for
  `LIGHTDASH_API_TOKEN`, `LIGHTDASH_PROJECT_UUID`, `ENGINE_PG_*`, `ENGINE_HTTP_URL`, `HRX_IDENTITY_SECRET`,
  `MCP_SOURCES` (JSON list matching the engine config).
- **Walkthrough**: `demo/eng-1799/walkthrough/playwright.config.ts` with `use.video: {mode: 'on', size: {width:
  1920, height: 1080}}` and `viewport` 1920x1080, one worker, scenes in file order; `run.sh` copies each scene's
  video and screenshot to `out/scenes/<id>/`. Read the URLs from `.state/stack.json`. The dashboard grid is
  react-grid-layout (`.react-grid-item`); the log stream and trace waterfall expose `data-testid`s
  (`log-stream-row` with `data-level`, `trace-span-row`, a Drawer on span click: see `PROGRESS-viz.md`).
- **Video**: build with one ffmpeg `filter_complex`: per input `fps=30,scale=1920:1080,drawbox+drawtext` (font e.g.
  `/System/Library/Fonts/Supplemental/Arial.ttf`; ffmpeg-static has `drawtext`, `xfade`, `afade`, `libx264`, `aac`),
  `xfade=transition=fade` chained with offsets = running length − fade, `-threads 2`. A throwaway prototype of
  exactly this passed all four video checks in the init session (about 25 s per build of 2.5 min of video).

## Risks and open questions for the feature sessions

1. **The integration branch.** Decision 2026-11-09: before the demo build run, the controls engineer merges the
   promoted `eng-1799-integration` branch into this one. After it lands, look for `e2e/eng-1799/` (fakes and boot
   code to reuse) and re-read `PROGRESS.md`/`PROGRESS-*.md` for changes. Prefer reusing over rewriting.
2. **Registry charts (stat, bar gauge, heatmap, state timeline)** are data-app visualizations under `ee/`; without
   a licence they may not render. The checks do not require registry charts: the stat may be a built-in big number
   with conditional formatting (the check looks for a red text/background/fill/stroke or a red `data-color` inside
   the `Current fill queue backlog` grid item, including same-origin iframes), the bar gauge a built-in chart, the
   heatmap a custom (Vega-Lite) chart. Record the choice in the docs.
3. **Explore-backed chart types.** `log_stream`, `trace_waterfall` and cartesian `thresholds` are saved-chart
   (explore) configs. A `none` project has no explores: use the native-git Lightdash semantic layer
   (`semanticLayer: 'lightdash'`) or virtual views over the engine's table functions, with the reserved
   `${ld.parameters.__from}` / `__to` / `__interval` parameters. Prove one Tile end to end before seeding all.
4. **Platform DB Tiles are Audited Queries** and need `audit.description`. If ldq's tile path sends none, the
   smallest fix (a description from the saved chart's description) is a small upstream edit outside `ee/`; record it.
5. **Alert timing.** Rule `interval` minimum is 30 s; the tick runs every 15 s. Seed the rules with `interval: 30s`,
   `for: 0s` (or short), and a route with short `groupWait`/`groupInterval` (about 5-10 s) so the alert checks fit.
6. **Check budget.** Most `--stack` checks should stay under 3 minutes warm, which means `up.sh` (boot + seed)
   must stay well under a minute and a half. `demo-stack-lifecycle` (two ups) and `demo-run-all` are allowed longer.

## Conventions

- New code in `demo/eng-1799/**` and `docs/eng-1799/demo.md`. Edits to upstream files only when unavoidable and
  small (a registration line). **Never touch any `ee/` directory** (the `demo-hygiene` check diffs against `f85d1ce60`).
- Never edit `demo/eng-1799/acceptance/**`. If a test is truly wrong, stop and say why in your result.
- Synthetic data only, obviously fake (names with Demo/Example/Fake, emails `@example.com`); no PHI; fake secrets
  `test-...-not-real`. No network at run time (no URLs other than localhost/example in demo code).
- **Music:** the video takes optional music only from `--music <file>` supplied by the person running it. The repo
  never contains, downloads or references any commercial or copyrighted audio (decision 2026-11-09: a request for a
  specific commercial track was declined). No audio files are committed (`.gitignore` enforces it).
- Glossary in UI copy, captions and docs: Telemetry Source, Federation Engine, Operations Project, Tile, Dashboard
  Time Range, Investigate, Alert Rule, Contact Point, Notification Route, Audited Query, Write Mode, Preview,
  Platform Database. Never: datasource, panel (for a Tile), dry run, notification policy, prod DB.
- `pnpm install --frozen-lockfile` must pass: whoever adds a dependency runs `pnpm install` and keeps the lockfile.
- Stop every server you start; leave no process running at the end of a session.

## Contract assumptions (demo line)

1. `up.sh` seeds by default; the goal allows `seed.sh` too, so `up.sh` may call it. The scenario clock starts when
   its server starts; `run-all.sh` restarts it right before the walkthrough so scene 1 begins at T.
2. "Ephemeral or configurable ports": ephemeral; the checks reject well-known ports.
3. The scripted AI client may call `query_promql` directly (the "model" is a script); `ask_data` is optional.
4. Alert Rules in the demo are ordinary (not Shadow Run), so notifications leave the process (to the local fake only).

## Feature order

package-workspace, config-validation, scenario-clock, platform-db, engine-boot, fake-prometheus, fake-loki,
fake-tempo, fake-cloudwatch-metrics, fake-cloudwatch-logs, audit-store, engine-healthy, fake-incident-io,
lightdash-backend, lightdash-frontend, stack-lifecycle, seed-project, lightdash-engine-query,
dashboard-pharmacy-ops, dashboard-pharmacy-ops-ui, dashboard-service-health, dashboard-platform-db, grafana-fixture,
portal-script, alerting-seed, alert-fires, alert-resolves, mcp-server, mcp-ask, scene-01 … scene-08, video-build,
video-cards-captions, video-thumbnail-chapters, video-music, docs, run-all-fails-cleanly, hygiene, run-all
(all prefixed `demo-`).

## Status

- 2026-11-08 init session: package skeleton, protected acceptance harness (40 specs, 45 features), `init-demo.sh`,
  this section. `bash ./init.sh` exits 0 (warm about 5 s). Checks run and failing for the intended reason:
  package (no `typecheck` script), config-validation (no `up.sh`), scenario-clock and pharmacy-ops-ui (`--stack`:
  "up.sh does not exist yet"), lifecycle, docs (no `demo.md`), hygiene (no `up.sh`), run-all-failure, video-build
  (no `video` script). The four video checks were also shown passable against a throwaway prototype build.
- 2026-11-09T01:56:50Z supervisor: initialized: 45 features, run 20261108-201404

## Merged with the integration line (2026-11-09, controls engineer)

The demo base now includes `eng-1799-integration` (8a033e710: all 50 integration checks pass). Reuse it:
- `e2e/eng-1799/harness/` has working fakes (Prometheus, Loki, CloudWatch and Logs Insights, Tempo, fake BigQuery,
  the audit store and fake S3), throwaway Postgres helpers and the Lightdash boot path (`int-lightdash-boot`).
  Read `docs/eng-1799/integration.md` and the integration section above before writing a new fake.
- The engine binary is `tmp/cargo-target/debug/engine` (one build for both lines).
- The engine lists DataFusion's `information_schema` views under every catalog; filter `table_schema <> 'information_schema'`
  when you list a source's tables.
- 2026-11-09T06:48:02Z supervisor: initialized: 45 features, run 20261109-013019
- 2026-11-09T06:49:33Z supervisor: demo-package-workspace halted: the worker halted on demo-package-workspace

### demo-config-validation (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/up.sh`: validates `DEMO_INCIDENT_AT` / `DEMO_RECOVERY_AT` (defaults 90 / 300; whole
  non-negative seconds, at most 9 digits, incident < recovery) **before** creating anything, exit 2 with a message
  naming the variable. With a valid timeline it currently prints the timeline, creates `.state/`, then exits 1
  ("no stack services are implemented yet; nothing was started"): it never claims a stack that is not there.
  **Next sessions:** replace that tail (the `# ---- stack` section) with the real start-up; keep validation first.
- New `demo/eng-1799/down.sh` (idempotent, exit 0 when nothing runs): `pg_ctl -m fast stop` for every
  `postmaster.pid` under `.state/`, TERM to each `stack.json` `"pid"` (its process group `-pid` and the pid) and to
  any process whose command line mentions `.state` (`pgrep -f`), KILL after `DEMO_DOWN_GRACE_SECONDS` (10), then
  removes `stack.json` (keeps logs/configs). So: start each service as a process-group leader and record its pid in
  `stack.json`; pass a `.state/...` path on each service's command line so the leftover sweep catches it.
- Tested as a user: `down.sh` with no state (exit 0); `up.sh` with `soon`, `-5`, `120/60`, `60/60`, `' 30'` all
  refused naming the variable; default `up.sh` exits 1 with the "not implemented" line; `down.sh` stopped a fake
  recorded pid and a fake process with `.state` in its command line; `pgrep -lf .state` empty afterwards.
  Check `bash demo/eng-1799/acceptance/run.sh config-validation.spec.ts` passes (exit 0).
- Note: demo-package-workspace halted earlier in this run (no `typecheck` script / `tsconfig.json` yet); this
  feature does not depend on it.
- 2026-11-09T06:51:17Z supervisor: demo-config-validation passed the gate in round 1

### demo-scenario-clock (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/clock.ts`: `ScenarioClock` (timeline = startedAt/incidentAt/recoveryAt in epoch ms,
  `phaseAt(t)`, `restart(incidentAfterSeconds, recoveryAfterSeconds)`, `view()` = the pinned JSON plus
  `incidentAfterSeconds`/`recoveryAfterSeconds`) and `validateOffsets` (finite numbers, |x| <= 999999999,
  recovery > incident; negative allowed). **Fakes must read `clock.current()` / `phaseAt(t)` per request** so data
  at t is a pure function of t and the current timeline.
- New `demo/eng-1799/stack/telemetry-fakes.ts`: the one "scenario + telemetry fakes" process. Serves
  `GET /scenario`, `POST /scenario/restart` (400 with `{error}` on bad offsets or bad JSON), `GET /healthz` on an
  ephemeral 127.0.0.1 port, then writes `--ready-file` (`.state/run/telemetry-fakes.json`, `{scenario:{url}}`)
  atomically. **Add Prometheus/Loki/Tempo/CloudWatch here** as more `http.Server`s on their own ports, add them to
  `servers` and to the ready-file JSON. Runs as `node --import tsx` (one process, cwd = demo dir, no
  `"type": "module"`, so no top-level await). The clock starts when this process starts (T = process start).
- `up.sh` `# ---- stack` section now: if `stack.json` exists and every recorded pid is alive and the clock answers,
  it says "already running; nothing changed" and exits 0 (same pids); otherwise it runs `down.sh` first. Services
  start through `start <name> <cmd...>` (perl `setpgrp` + `exec`: own process group, pid kept, log in
  `.state/logs/<name>.log`) and `wait_ready`; on failure the EXIT trap TERMs what this run started. `stack.json`
  is written by a `node -e` block at the end with **only** `scenario` and `processes` so far: later features add
  their keys there. The `Lightdash: <url>` line is not printed yet (the Lightdash feature adds it in `report()`).
- Tested as a user: `DEMO_INCIDENT_AT=100 DEMO_RECOVERY_AT=400 up.sh` → GET shows offsets 100/400, phase
  baseline; restart 3/7 → baseline, incident from ~3 s, recovered from ~7 s (polled once a second); restart
  -120/-30 → recovered with incidentAt 2 min ago; -60/600 → incident; 10/5, a string offset and non-JSON → 400;
  second `up.sh` kept pid; `down.sh` stopped it, no process left. Check `scenario-clock.spec.ts` (--stack) passes;
  `config-validation.spec.ts` still passes. `tsc --strict --module nodenext` over `stack/*.ts` is clean
  (pass `--ignoreConfig`: a parent tsconfig is picked up otherwise; the demo still has no `tsconfig.json`).
- 2026-11-09T06:54:45Z supervisor: demo-scenario-clock passed the gate in round 1

### demo-platform-db (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/platform-db.ts` (CLI, not a module: importing it runs it). `prepare --dir .state/platform-db`
  wipes and `initdb`s a fresh cluster (superuser `demo_admin`, scram, C locale), appends port (free ephemeral),
  `listen_addresses = '127.0.0.1'`, `unix_socket_directories = ''`, fsync off; prints the port. `seed --port --pid
  --ready-file` waits for the server, creates database `platform`, roles `engine_read` (SELECT) and `engine_write`
  (SELECT/INSERT/UPDATE/DELETE), tables `queues` (4: demo-intake/fill/verification/shipping), `orders` (120,
  `DEMO-ORD-nnnnn`, "Demo Customer n", `@example.com`), `fills` (120, one per order, 48 `queued`), `shipments` (72,
  `FAKE-TRK-…`, "… Example Street, Demo City"), timestamps relative to seed time; writes `.state/run/platform-db.json`.
  Every name/email/phone/address-shaped value says demo/example; no dob/mrn/ssn-shaped columns (spec checks this).
- `up.sh`: between the scenario clock and stack.json, runs `prepare`, then `start platform-db $PG_BIN/postgres -D
  .state/platform-db/pgdata` (own process group, pid in `processes`; down.sh's `pg_ctl stop -m fast` handles it),
  then `seed`. `PG_BIN` = `DEMO_PG_BIN` or the dir of `postgres` on PATH (/opt/homebrew/bin). Logs:
  `.state/logs/platform-db.log` (server), `platform-db-init.log` (initdb/seed). **The data is reset on every fresh
  up.sh** (Write Mode commits do not survive a restart; a live stack is kept as-is).
- `stack.json` now has `platformDb: {host, port, user, password, database, roles: {read: {user,password}, write:
  {user,password}}}`; `user` is the superuser (the spec needs `show data_directory`). **The engine feature should use
  `roles.read`/`roles.write`** for Audited Queries / Write Mode. `report()` prints the Platform Database URL (no password).
- Tested as a user: `up.sh` → connected with stack.json credentials (node pg; no `psql` on this machine): data dir under
  `.state`, listen 127.0.0.1, counts 120/120/4/72, sample rows all demo/example/fake; `engine_read` can select but
  UPDATE is refused, `engine_write` can update. Second `up.sh` kept the stack; `down.sh` stopped Postgres, no
  `.state` process left. Checks `platform-db.spec.ts` and `scenario-clock.spec.ts` (--stack), `config-validation.spec.ts`
  pass; `tsc --ignoreConfig --strict --module nodenext --types node stack/*.ts` clean.
- 2026-11-09T06:58:14Z supervisor: demo-platform-db passed the gate in round 1

### demo-engine-boot (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/engine-config.ts` (CLI): `--dir .state/engine --platform-file .state/run/platform-db.json
  --ready-file .state/run/engine-config.json`. Picks 9 distinct free ports at once (engine pg + http, and one per
  endpoint the engine points at) and writes `federation-engine.toml` (sources `prometheus`, `loki`, `tempo`,
  `cloudwatch`, `cloudwatch-logs` (kind `cloudwatch_logs`), `platform` (`platform_postgres`, read as `engine_read`,
  Write Mode as `engine_write`), `[audit]` table/bucket `demo-federation-audit`, region us-east-2, integrity key),
  `engine.env` (0600: the engine's whole env: fake secrets, fake AWS creds, `AWS_ENDPOINT_URL` at dead port 9,
  no user AWS config, Platform URLs) and the ready file `{engine: {...stack.json engine...}, endpoints: {prometheus,
  loki, tempo, cloudwatch, cloudwatchLogs, auditDynamodb, auditS3}}`.
- **Endpoint ports are reservations.** The fake features (prometheus, loki, tempo, cloudwatch(-logs), audit-store)
  must make their servers listen on exactly `endpoints.*` from `.state/run/engine-config.json` (up.sh writes it
  before starting the engine; today it runs after the telemetry-fakes process starts: either pass the ports to that
  process, or move the engine-config step before it). Until then `/healthz` is 503 with those sources unreachable
  (only `platform` reachable) and Audited Queries fail closed (no audit store).
- `up.sh`: after the Platform Database, writes the config, runs `engine --check-config`, then `start engine`. `start`
  now honours `DEMO_START_ENV_FILE=<file>` (perl clears `%ENV` and loads `KEY=value` lines; no secret on a command
  line). Ready = `/healthz` answers any status (60 s). `stack.json` gains `engine` (host, pgPort, httpUrl, user
  `lightdash-operations`, password, database `operations`, identitySecret) and process `engine`; it is now written
  0600. `report()` prints the engine URL.
- **Binary path decision:** the spec pgreps `federation-engine/target/(debug|release)/engine`, but the one build is
  `tmp/cargo-target/debug/engine`. up.sh runs `federation-engine/target/debug/engine`, a symlink (gitignored dir) it
  (re)creates to the tmp/cargo-target build; a real file there (the engine line's own build) is used as is;
  `DEMO_ENGINE_BIN` overrides. No second cargo build.
- Tested as a user: `up.sh` → engine log "serving, sources 6"; pg-wire with stack.json engine creds: `version()` =
  `PostgreSQL 16.0 (hrx-federation-engine 0.1.0)`, wrong password refused; `/healthz` 503 naming all six sources;
  pgrep shows the symlink path with `--config .state/engine/federation-engine.toml`; the same config minus `[audit]`
  → `--check-config` exit 1 "audited sources "platform" need an [audit] table"; second up.sh kept the pids;
  down.sh left no process. Checks engine-boot, platform-db, scenario-clock (--stack) and config-validation pass;
  `tsc --ignoreConfig --strict --module nodenext --types node --noEmit stack/*.ts` clean.
- 2026-11-09T07:03:29Z supervisor: demo-engine-boot passed the gate in round 1

### demo-fake-prometheus (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/prometheus.ts`: `prometheusHandler(() => clock.current())`, served by the telemetry-fakes
  process. Series `hrx_fill_queue_backlog{job="fill-service", queue="fill"|"pack"|"ship"}`, 15 s scrapes; the value at
  evaluation time t is the latest scrape <= t, jitter = sha256 of (series, scrape time) (no `Math.random()`).
  `fill`: baseline 18..48; ramps to 140..175 over 15 s from incidentAt; falls back over 45 s from recoveryAt. **The
  ramps are 15 s shorter than the pinned bounds because a sample can be one scrape old** (keeps >= 120 from
  incidentAt+30s, <= 60 from recoveryAt+60s). `pack` 8..22 and `ship` 3..12 always. The CloudWatch fake ("follows
  the backlog numbers") can reuse `fillBacklog` (export it).
- API: `/api/v1/query_range` (matrix), `/api/v1/query` (vector), labels, label values, series, metadata, buildinfo,
  `/-/healthy`, `/-/ready`; GET or POST form. PromQL subset: one selector with `= != =~ !~` matchers, optionally in
  `sum|min|max|avg|count [by|without (...)] (...)`. Anything else (`rate(...)`, `[5m]`, comparisons) is 400 bad_data;
  extend `parseQuery` if a later feature (alert rule, dashboards, MCP) needs more.
- `telemetry-fakes.ts` now requires `--endpoints-file .state/run/engine-config.json` and listens on exactly
  `endpoints.prometheus`; its ready file is `{scenario:{url}, prometheus:{url}}`. **up.sh order changed**: Platform
  Database → engine config → telemetry-fakes (clock T starts here, a few seconds later than before) → engine. Later
  fakes (Loki, Tempo, CloudWatch(-Logs)) should listen on their `endpoints.*` in the same way. `stack.json` gains
  `prometheus.url`; `report()` prints it.
- Tested as a user: `up.sh`, restart -240/-90, `promql('hrx_fill_queue_backlog', now-400s, now, '15s')` through the
  engine (pg-wire, stack.json creds): 81 rows, 3 series; fill 22..48 before the incident, 137..173 during, 117/68 on
  the way down, 28..47 after; two runs identical; `promql_instant('...{queue="fill"}', now)` = 47; `sum by (job)` works;
  a broken query gives the engine error "HTTP 400: bad_data: ..."; `/healthz` shows prometheus reachable. Checks
  fake-prometheus, engine-boot, platform-db, scenario-clock (--stack, 100/400) and config-validation pass; `tsc
  --ignoreConfig --strict --module nodenext --types node --noEmit stack/*.ts` clean; no `.state` process left.
- 2026-11-09T07:08:15Z supervisor: demo-fake-prometheus passed the gate in round 1

### demo-fake-loki (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/loki.ts`: `lokiHandler(() => clock.current())`, served by telemetry-fakes on
  `endpoints.loki`. Two streams `{app="fill-service", env="demo", level="info"|"error"}`, logfmt lines. One slot
  per whole second: the line's ms offset, level and wording are a sha256 hash of the second. Baseline/recovered:
  ~20 info lines/min plus one ordinary error line every 40 s, **so every 1 m window has 1 or 2 errors, never 0**
  (an error-rate Alert Rule gets data in the baseline, not NoData). Incident `[incidentAt, recoveryAt)`: an extra
  error every 3 s plus ~1/6 of the other seconds (~27/min seen), all `msg="create shipping label failed"
  downstream=shipping-label-api duration_ms=2000..4999`; "label created" info lines carry the same slow
  durations in the incident and 120..479 ms otherwise (matches the Tempo pin).
  `fillServiceLogs(fromMs, toMs, timeline)` is exported for the CloudWatch Logs fake ("ERROR follows the
  error-log numbers"): reuse it rather than writing a second generator.
- API: `/loki/api/v1/query_range` (streams or matrix), `/loki/api/v1/query` (metric only, like Loki),
  labels, label values, series, buildinfo, `/ready`; GET or POST form; errors are Loki-style plain-text 400s.
  Loki defaults: limit 100 (max 5000), direction backward, start = end-1h, step = max(range/250, 1s); times in ns,
  s or RFC 3339; ranges over 7 days refused (lines are generated on demand). LogQL subset: selector + line
  filters `|= != |~ !~`; `count_over_time|rate|bytes_over_time(... [range])`, optionally in
  `sum|min|max|avg|count [by|without (...)]`. Metric points with no lines are omitted, as Loki does. Not yet:
  `| logfmt`, label filters, `unwrap`; extend `parseLogQuery`/`parseMetricQuery` if a dashboard, rule or MCP needs them.
- `prometheus.ts` now exports `BadData`, `Labels`, `Matcher`, `Selector`, `parseSelector`, `parseGrouping`,
  `matches`, `parseStep` (shared with the Loki fake, behaviour unchanged). `up.sh` checks `$LOKI_URL/ready`, puts
  `loki.url` in stack.json and `report()` prints it.
- Tested as a user: `up.sh`, restart -240/-90, through the engine (pg-wire, stack.json creds):
  `logql('{app="fill-service"} |= "level=error"', now-400s, now, 5000, 'forward')` → 76 lines, 1.6/min baseline,
  27.3/min incident, every incident error mentions shipping-label-api; `{app="fill-service"}` baseline 51 lines
  (default backward, newest first); `logql_metric('sum(count_over_time(... [1m]))', ..., '30s')` 1-2 in the
  baseline, 11..28 in the incident, back to 1 after recovery; `sum by (level) (rate(...[1m]))` works; `| json`
  → engine error "HTTP 400: parse error: ..."; `{app="other"}` → 0 rows; repeated query identical. Checks
  fake-loki, fake-prometheus, engine-boot, scenario-clock, platform-db (--stack) and config-validation pass;
  `tsc --ignoreConfig --strict --module nodenext --types node --noEmit stack/*.ts` clean; no process left.
- 2026-11-09T07:14:26Z supervisor: demo-fake-loki passed the gate in round 1

### demo-fake-tempo (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/tempo.ts`: `tempoHandler(() => clock.current())`, served by telemetry-fakes on
  `endpoints.tempo`. One slot per whole second: a trace starts in every second divisible by 15 plus ~1/8 of the
  others (~11/min); offset, ids and timings are sha256 hashes of the second. Spans: root fill-service SERVER
  `POST /fills/{fill_id}/ship` → fill-service `SELECT demo.fills` (3..32 ms), fill-service CLIENT
  `POST shipping-label-api /v1/labels` → **shipping-label-api SERVER `POST /v1/labels`** (120..479 ms, 2000..4999 ms
  for traces starting in `[incidentAt, recoveryAt)`), and `publish fill.label_created` when the call succeeded.
  About half of the incident traces fail (`context deadline exceeded`, status error on root/client/server, 504,
  no publish span). So the shipping-label-api span's parent is the fill-service client span, not the root.
- **Trace id = slot second as 8 hex + 24 hex hash**, so `trace(id)` needs no time range; ids are a function of
  the second, but the spans (slow/fast) follow the current timeline, so a restart can change an old id's trace.
  Exported for later fakes/scenes: `fillServiceTraces(fromMs, toMs, timeline)`, `traceById(id, timeline)`.
  Traces are NOT correlated with the Loki lines (different hash keys; only the same duration ranges).
- API: `/api/search` (q, start/end unix s, default last 1 h, max 168 h; limit default 20; minDuration/maxDuration;
  newest first; `matched` = matching span count), `/api/traces/<id>` (`batches`) and `/api/v2/traces/<id>`,
  `/api/search/tags`, `/api/v2/search/tags`, `/api/(v2/)search/tag/<t>/values`, `/api/echo`, buildinfo, `/ready`;
  errors are plain-text 400s, unknown id 404. TraceQL subset: spanset filters `{...}` (several joined by one of
  && / ||), conditions with && / || / parentheses, ops `= != > >= < <= =~ !~`, intrinsics name, status, kind,
  duration (span duration, as Tempo), rootName, rootServiceName, traceDuration, attributes `resource.x`,
  `span.x`, `.x`. Pipelines (`| count()`) and structural operators answer 400; extend `parseQuery` if needed.
- `up.sh` checks `$TEMPO_URL/ready`, writes `tempo.url` to stack.json, `report()` prints it. `/healthz` now shows
  tempo reachable (only cloudwatch/cloudwatch-logs unreachable).
- Tested as a user: `up.sh`, restart -240/-90, through the engine (pg-wire, stack.json creds), 400 s window, limit
  500: `{ resource.service.name = "fill-service" }` → 76 traces (27 baseline, 35 incident, 14 recovered), all root
  fill-service; `&& duration > 2s` → 35, all in the incident, min 2027 ms; default limit → 20 rows;
  `{ status = error }` → 16, all incident; `trace(<slow id>)` → 5 spans, shipping-label-api 2757 ms under the
  fill-service client span (2760 ms) under the root (2774 ms); a baseline trace's label span 285 ms; unknown id →
  0 rows; a pipeline → engine error "HTTP 400: invalid TraceQL query: ..."; repeated query identical. Checks
  fake-tempo, fake-loki, fake-prometheus, engine-boot, scenario-clock (--stack) and config-validation pass; `tsc
  --ignoreConfig --strict --module nodenext --types node --noEmit stack/*.ts` clean; no process left.
- 2026-11-09T07:20:16Z supervisor: demo-fake-tempo passed the gate in round 1

### demo-fake-cloudwatch-metrics (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/cloudwatch.ts`: `cloudwatchHandler(() => clock.current())`, served by telemetry-fakes
  on `endpoints.cloudwatch`. Metric AWS/SQS `ApproximateNumberOfMessagesVisible` {QueueName=hrx-demo-fill-queue}
  (unit Count): one raw sample every 10 s (epoch-aligned, sha256 jitter), baseline 20..50, from incidentAt a 20 s
  ramp to 150..190, from recoveryAt a 30 s ramp back. Samples after "now" do not exist; empty buckets are
  left out. Other metrics/dimensions/units → Complete result with no datapoints; add entries to `METRICS`.
- **Wire protocol trap:** the engine's aws-sdk-cloudwatch 1.140 speaks **Smithy RPC v2 CBOR**
  (`POST /service/GraniteServiceVersion20100801/operation/GetMetricData`, `smithy-protocol: rpc-v2-cbor`),
  not the query protocol. The fake has its own small CBOR codec (no new dependency): timestamps are tag 1 +
  float seconds, Values are always CBOR doubles, errors are 400 `{__type, message}`. AWS JSON 1.0
  (`X-Amz-Target: GraniteServiceVersion20100801.GetMetricData`, epoch-second timestamps) is answered too, for curl.
  The CloudWatch Logs fake (next) will need the same check: look at
  `~/.cargo/registry/src/*/aws-sdk-cloudwatchlogs-*/src/operation/start_query.rs` for the protocol it sends.
- Buckets start at StartTime + k·Period (StartTime is NOT rounded to the minute) while they start before
  EndTime. Stats: Average, Sum, Minimum, Maximum, SampleCount, pNN(.N) (nearest rank). ScanBy both ways;
  MaxDatapoints/NextToken paging (token = base64 offset); at most 200 000 buckets per request (else 400).
  Expression queries (SEARCH, metric math) answer 400 InvalidParameterValue; extend `parseQuery` if a dashboard needs them.
- `up.sh` checks `$CLOUDWATCH_URL/ready` (a non-AWS route), writes `cloudwatch.url` to stack.json, `report()`
  prints it. `/healthz` now shows only cloudwatch-logs unreachable.
- Tested as a user: `up.sh`, restart -240/-90, `cloudwatch(<Grafana target>, now-400s, now)` through the engine
  (pg-wire): 7 one-minute rows at hh:mm:38.762 (the request's StartTime), Maximum 41, 47 (baseline), 119 (the
  minute straddling incidentAt), 186, 189, 175 (incident), 48 (recovered); Minimum in full incident minutes 150,
  152; SampleCount 6 per full minute; series and labels.label = metric name, or the Grafana `label` when set;
  period 300 over an hour → 12 rows; QueueName=nope → 0 rows; a code-mode expression → engine error
  "GetMetricData failed: InvalidParameterValue: ...". AWS JSON via curl: p90, MaxDatapoints 2 → 2 points +
  NextToken; StartTime > EndTime → 400 ValidationError. Checks fake-cloudwatch, fake-tempo, fake-loki,
  fake-prometheus, engine-boot, scenario-clock (--stack) and config-validation pass; `tsc --ignoreConfig --strict
  --module nodenext --types node --noEmit stack/*.ts` clean; no demo process left.
- 2026-11-09T07:26:58Z supervisor: demo-fake-cloudwatch-metrics passed the gate in round 1

### demo-fake-cloudwatch-logs (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/cloudwatch-logs.ts`: `cloudwatchLogsHandler(() => clock.current())`, served by
  telemetry-fakes on `endpoints.cloudwatchLogs`. Log group `/hrx/demo/fill-service` only (others → 400
  ResourceNotFoundException). Events are the fake Loki lines (`fillServiceLogs()`), rewritten as
  `<ISO time> INFO|ERROR <logfmt rest>`, so ERROR counts follow Loki: ~1.5/min baseline and recovered, 20..30/min
  in the incident (each mentions shipping-label-api). Fields: @timestamp (`YYYY-MM-DD HH:MM:SS.mmm` UTC), @message,
  @logStream, @log, @ptr. Window is [startTime, endTime] in epoch seconds, both inclusive, never after now.
- **Protocol:** aws-sdk-cloudwatchlogs 1.163 speaks **AWS JSON 1.1** (`X-Amz-Target: Logs_20140328.<Op>`), not
  CBOR. Ops: StartQuery (runs the query at once), GetQueryResults (always `Complete`), StopQuery (`success: false`),
  DescribeLogGroups; the last 200 query ids are kept. Errors are 400 `{__type, message}`.
- Logs Insights subset: `fields`/`display` (plain lists), `filter` (`like /re/flags`, `like "text"`, `not like`,
  `=~`, `=`, `!=`, with and/or/not/parentheses), `sort <field> [asc|desc]` (none → newest first), `limit` (none →
  1000, max 10000; a `limit` command wins over the StartQuery `limit` parameter). `stats`, `parse`, `dedup` etc.
  → 400 MalformedQueryException: extend `parseQuery`/`runQuery` if a dashboard or alert needs them. Range at most 7 days.
- `up.sh` checks `$CLOUDWATCH_LOGS_URL/ready`, writes `cloudwatchLogs.url` to stack.json, `report()` prints it.
  Engine `/healthz` is now `status: ok` with every source reachable.
- Tested as a user: `up.sh`, restart -240/-90, through the engine (pg-wire): the spec query
  (`filter @message like /ERROR/ | sort @timestamp desc | limit 2000`, now-400s..now) → 77 rows, all ERROR, newest
  first; 1.2/min baseline, 28.4/min incident, every incident row mentions shipping-label-api; `fields` json =
  {@message, @timestamp} (engine drops @ptr); `fields ... | limit 2000` over the baseline → 60 lines (56 INFO); no
  fields/limit → @log/@logStream too; `like /error/i and not ... like /shipping/ | sort asc | limit 3` → 3 ascending
  rows, message NULL (not selected); `stats ...` → engine error "StartQuery failed: MalformedQueryException: ...";
  log group `/nope` → "ResourceNotFoundException: Log group ..."; repeated query identical. Checks fake-cloudwatch-logs,
  fake-cloudwatch, fake-loki, fake-tempo, fake-prometheus, engine-boot, scenario-clock (--stack) and config-validation
  pass; `tsc --ignoreConfig --strict --module nodenext --types node --noEmit stack/*.ts` clean; no demo process left.
- 2026-11-09T07:32:52Z supervisor: demo-fake-cloudwatch-logs passed the gate in round 1

### demo-audit-store (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/audit-store.ts`: one in-memory `AuditStore` served by telemetry-fakes on the two
  endpoints engine-config already reserved, `endpoints.auditDynamodb` and `endpoints.auditS3`. Table and bucket
  names (`AUDIT_TABLE`, `AUDIT_BUCKET`, both `demo-federation-audit`) now live there; engine-config.ts imports them.
- **DynamoDB** (AWS JSON 1.0, `X-Amz-Target: DynamoDB_20120810.<Op>`): PutItem (only `attribute_not_exists(id)`
  as condition, which the engine always sends), Query on the table or the portal GSIs byMonth / byTicket / byUser
  (sort key createdAt; ScanIndexForward, Limit, ExclusiveStartKey/LastEvaluatedKey, an optional createdAt range;
  FilterExpression → 400), GetItem, DescribeTable. Errors are `{__type: com.amazonaws.dynamodb.v20120810#X}`.
- **S3 Object Lock** (path-style): PutObject (`?x-id=PutObject` is allowed; each put is a new version; lock mode
  must be COMPLIANCE/GOVERNANCE with a future retain-until date; aws-chunked bodies decoded), GET/HEAD (with
  `versionId`, returns the lock headers), ListObjectsV2 (`?list-type=2&prefix=`). DELETE → 403 AccessDenied while
  locked (501 otherwise: the demo never deletes).
- Records live as long as the telemetry-fakes process: down.sh / a fresh up.sh discards them (a live-stack up.sh
  keeps them). `up.sh` checks `/ready` on both endpoints, writes `auditDynamodb.url` / `auditS3.url` to stack.json,
  `report()` prints them.
- Observation (engine, not changed): an Audited Query whose SQL fails while the engine plans `platform_query`
  (e.g. 42P01 unknown relation) is not audited; only failures inside `run()` (pg.rs) are. Scene 7 / Write Mode
  sessions should not rely on a record for such a statement.
- Tested as a user: `up.sh` (baseline before the change: platform_query → 58000 "audit write failed",
  `/v1/audit` → 502). After: pg-wire `SET hrx.identity` (platform_read, description, ticket ENG-1799) +
  `platform_query('select count(*) as n from orders')` → 120; a token without platform_read → 42501 "... needs
  platform_read"; `GET /v1/audit?ticket=ENG-1799` → 200 with the record (description, database platform,
  linearTicketId, createdAtMonth, hmac-sha256 integrityHash); S3 object `executions/<createdAt>/<id>.json` has all
  17 fields and COMPLIANCE lock 7 years out, DELETE → 403. 27 more queries: ticket, month, user and recent browse
  each 2 pages, newest first, no duplicates; no platform_read → 403. Checks audit-store, engine-boot,
  fake-cloudwatch-logs (--stack) and config-validation pass; `tsc ... stack/*.ts` clean; no demo process left.
- 2026-11-09T07:39:20Z supervisor: demo-audit-store passed the gate in round 1

### demo-engine-healthy (2026-11-09, run 20261109-013019)

- No code change needed: the earlier fakes (prometheus, loki, tempo, cloudwatch, cloudwatch-logs) plus the Platform
  Database already make the engine's `/healthz` return 200 `status: ok` with every source `reachable: true`
  (sources: prometheus, loki, tempo, cloudwatch, cloudwatch_logs, platform_postgres; `unhealthy: []`).
  The audit store is not a health source in the engine.
- Tested as a user: `init.sh`, `up.sh`, `curl $engine.httpUrl/healthz` → 200 with all six sources reachable. Negative
  check: killed the telemetry-fakes process → `/healthz` 503 `status: unhealthy`, the five telemetry sources
  "unreachable: Connection refused", platform still reachable (so health is probed live, not hardcoded). `down.sh`
  stopped everything. `run.sh --stack engine-healthy.spec.ts` passes; no demo process left.
- 2026-11-09T07:41:23Z supervisor: demo-engine-healthy passed the gate in round 1

### demo-fake-incident-io (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/incident-io.ts`: an in-memory fake incident.io receiver, served by the telemetry-fakes
  process on an **ephemeral** port (it is not an engine endpoint, so engine-config does not reserve one).
  `up.sh` checks its `/ready`, writes `incidentIo.url` to stack.json and `report()` prints it.
  - `POST /webhook`: an Alertmanager v4 payload (version "4", status firing|resolved, groupKey, non-empty
    alerts[] each with status, string labels/annotations, startsAt, endsAt, fingerprint). It needs
    `Authorization: Bearer <any non-empty token>` (missing → 401; the token value is not checked or stored).
    Bad shape/JSON → 400 naming the field. Accepted → 202 `{status: "success", message, deduplication_key}`.
  - `GET /api/received` → `{notifications: [{receivedAt, payload}]}`, oldest first, payload exactly as posted
    (the newest 1000 are kept). Notifications are lost when the process stops (down.sh / a fresh up.sh).
  - `GET /`: HTML page titled "incident.io (fake) - received alerts", one `<tr>` per alert (not per
    notification), newest first: Status (FIRING red / RESOLVED green), Alert (alertname), other labels,
    summary, Started, Ended (blank for Alertmanager's 0001-01-01 zero time), Received. All values HTML-escaped.
    It refreshes itself every 5 s (`<meta http-equiv=refresh>`), so the walkthrough can leave it open.
- For demo-alerting-seed: point the incident_io Contact Point at `${stack.incidentIo.url}/webhook`, with the token
  from a secretRef (the acceptance spec forbids an inline secret). Only `/webhook` is routed; incident.io's real
  `/v2/alert_events/alertmanager/<id>` path is not.
- Tested as a user: `up.sh` printed the receiver URL. With curl: a firing then a resolved v4 payload → 202 each; no
  bearer → 401; version "3" → 400; non-JSON → 400. `/api/received` listed both in order. Opened `/` in Playwright's
  Chromium: title as above, one firing and one resolved row for the alert, firing in red, `<b>` in the summary shown
  escaped. Checks incident-io-receiver (--stack) and engine-healthy (--stack) pass; `tsc ... stack/*.ts` clean;
  no demo process left.
- 2026-11-09T07:45:08Z supervisor: demo-fake-incident-io passed the gate in round 1

### demo-lightdash-backend (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/lightdash.ts`: `prepare` initdb's a fresh cluster in `.state/lightdash/pgdata`
  (127.0.0.1 only, free port, no socket), picks a free backend port and writes `.state/lightdash/lightdash.env`
  (0600, the backend's whole env) and `.state/run/lightdash.json`; `migrate` waits for the cluster, creates the
  `lightdash` db and runs `stack/lightdash-migrate.ts` (all non-ee knex migrations + graphile-worker's, ~10 s, so
  no template cache: every up.sh starts from an empty, freshly migrated Lightdash).
- New `stack/lightdash-server.ts` boots the backend's `App` (like `src/index.ts` and the e2e harness's
  lightdashServer.ts) **without index.ts's Sentry/tracing bootstrap**, run from `packages/backend` (tsx needs the
  backend tsconfig). up.sh starts it via `start` with the new `DEMO_START_DIR` option and the env file.
  `SCHEDULER_ENABLED=true`: the scheduler worker, and with it the alerting tick, runs in-process (one
  `lightdash` process, plus `lightdash-db`, in stack.json `processes`). `/api/v1/alerting/health` is `ok` ~15 s
  after start and a cycle completes every ~15 s.
- **Trap: Node version.** Plain `node` on PATH is v26; `@sentry/profiling-node` has no native addon for it and
  the backend dies on import (App imports tracing/bootstrap too). up.sh runs the backend (and the migrate step) on
  the workspace's pnpm-pinned Node (`pnpm exec node` → node@runtime+24.22.1); `DEMO_LIGHTDASH_NODE` overrides.
- New `stack/results-s3.ts`: in-memory S3 fake (path-style; Put/Get with Range/Head/Delete, multipart upload as
  lib-storage's `Upload` does it, ListObjectsV2, HeadBucket, `/ready`), served by telemetry-fakes on an
  ephemeral port (`lightdashS3.url` in stack.json). S3_* and RESULTS_S3_* point at it, bucket
  `demo-lightdash-results`.
- Phone-home off through env: `RUDDERSTACK_ANALYTICS_DISABLED`, `LIGHTDASH_DISABLE_UPDATE_CHECK`,
  `LIGHTDASH_CHART_REGISTRY_URL=` (empty = disabled), `HEADWAY_ENABLED=false`, `AWS_EC2_METADATA_DISABLED`;
  Sentry/Intercom/Pylon/PostHog unset. The backend held only 127.0.0.1 connections in lsof.
- Ports: Lightdash PORT, its Postgres and the S3 fake are ephemeral; the engine already was. telemetry-mcp is
  not started yet: demo-mcp-server must set `MCP_PORT` and `ENGINE_PG_PORT` (defaults 8080/5433) explicitly.
- Known limitation: the App binds every interface (no listen-address setting in Lightdash); not changed.
- stack.json gains `lightdash: {url, port}` (demo-seed-project adds `projectUuid`; the Stack type wants it),
  `lightdashDb`, `lightdashS3`. `NODE_ENV=development` like the e2e harness; demo-lightdash-frontend may revisit
  how the production frontend build is served. Logs: `.state/logs/lightdash.log`, `lightdash-init.log`.
- Tested as a user: `up.sh` (~27 s) printed `up.sh: Lightdash: http://127.0.0.1:<port> (...)`; `GET
  /api/v1/health` → `status: ok`, healthy, `requiresMigration: false`, headway off, rudder/latest empty; polled
  `/api/v1/alerting/health` 40 s: `ok`, lastCycleAt advancing every 15 s, lag ≤ 10. Re-run up.sh → "already
  running" with the Lightdash line. AWS SDK + lib-storage against the S3 fake: small put, 12 MiB multipart,
  byte-exact get, range get, list, delete → 404. `down.sh` stopped everything. Checks lightdash-backend,
  engine-healthy, incident-io-receiver (--stack) pass; `tsc ... stack/*.ts` clean; no demo process left.
- 2026-11-09T07:59:29Z supervisor: demo-lightdash-backend passed the gate in round 1

### demo-lightdash-frontend (2026-11-09, run 20261109-013019)

- Decision: **production build served by the backend** (no Vite dev server). init-demo.sh already builds
  `packages/frontend/build` (stamped, skipped when unchanged) and the backend's `App` serves it (`/assets/*` +
  `index.html` catch-all) regardless of `NODE_ENV`, so the UI is at the URL up.sh prints; no new process or port.
- New `docs/eng-1799/demo.md` with only a "Frontend mode" section (mode, why, what you see, rebuild after frontend
  edits). **demo-docs must extend this file**, not replace the section (docs.spec.ts also wants
  `production build|dev server`).
- `up.sh`: preflight fails fast if `packages/frontend/build/index.html` is missing (uses `$DEMO/../..`; `ROOT` is
  only defined later in up.sh); after `/api/v1/health` it fetches `/login` and requires `<div id="root"`
  (captured into a variable, not `curl | grep -q`, to avoid SIGPIPE under pipefail).
- Browser notes for scene specs: before sign-in the UI makes 401 calls (`/api/v1/user/account`, `/org`,
  `/aiAgents/settings`) that log console errors, plus a CSP report-only console error and Intercom warnings;
  none are page errors. The only off-box requests are Google Fonts (Inter).
- Tested as a user: up.sh; opened the printed URL in Playwright Chromium → redirected to `/register` ("Register -
  Lightdash"), Sign up form with Email address field, no page errors, screenshot looked right; down.sh. With the
  build moved aside up.sh stopped with the "no frontend production build" message and started nothing. Checks
  lightdash-frontend and lightdash-backend (--stack) pass; no demo process left.
- 2026-11-09T08:04:44Z supervisor: demo-lightdash-frontend passed the gate in round 1

### demo-seed-project (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/stack/seed.ts`, run by up.sh right after the UI check and before stack.json is written
  (log `.state/logs/seed.log`, ready file `.state/run/seed.json`). It seeds **only through Lightdash's public HTTP
  API** on the session cookie registration returns: `POST /api/v1/user` (first user; refuses to run unless
  `/api/v1/health` says `requiresOrgRegistration`), `PUT /api/v1/org` ("HouseRx Demo (synthetic)"), `PATCH
  /api/v1/user/me/complete`, `POST /api/v1/org/projects` (`dbtConnection: none`, `type: postgres, flavor:
  federation`, identitySigningSecret = engine.identitySecret, httpBaseUrl = engine.httpUrl, from
  `.state/run/engine-config.json`), then `POST /api/v1/org/attributes` for `platform_read` and `platform_write` =
  `"true"` on the demo user, and verifies `GET /api/v2/projects/<uuid>/federation/access` before writing.
- Pinned values: demo user `demo.operator@example.com` (Demo Operator, an org **admin** as the registering user),
  password `test-demo-password-1-not-real`; project name `Operations Project` (slug `operations-project`).
- stack.json gains `demoUser: {email, password, userUuid}` and `lightdash.projectUuid`. up.sh's report (also on the
  "already running" path) prints the demo user's email and the project home URL.
- No personal access token, space or CLI yet: the next seed features (upload, alerting, portal scripts, MCP) add
  what they need; reuse the `Session` class in seed.ts or log in with `POST /api/v1/login`. The session cookie is
  enough for `org/projects` and `org/attributes` (no PAT needed).
- The project home shows the "Welcome, Demo!" onboarding panel (no content yet). AI-agent/credits endpoints answer
  422 (licence-gated ee), harmless. up.sh warm: ~18 s including the seed (~1 s).
- Since a user now exists, `/` redirects to `/login` (not `/register`); lightdash-frontend's spec accepts both.
- Tested as a user: up.sh; in Playwright Chromium opened the printed URL → `/login`, typed the stack.json email
  and password into the sign-in form → `/projects/operations-project/home` with "Operations Project" in the
  project switcher and the welcome panel, no page errors; `GET /api/v1/projects/<uuid>` → postgres/federation,
  no `password`/`identitySigningSecret` keys returned; `GET /api/v2/.../federation/access` → `isFederation: true`,
  platform_read/platform_write true. Re-ran up.sh → "already running" with the sign-in line; down.sh. Checks
  seed-project, lightdash-frontend, lightdash-backend (--stack) pass; `tsc --ignoreConfig ... stack/*.ts` clean;
  no demo process left.
- 2026-11-09T08:12:06Z supervisor: demo-seed-project passed the gate in round 1

### demo-lightdash-engine-query (2026-11-09, run 20261109-013019)

- **No code change needed.** The tree from demo-seed-project already meets this feature: the Operations Project
  (postgres/federation flavour) sends SQL Runner queries to the Federation Engine, and the async query results are
  written to the fake results S3 (`demo-lightdash-results`). The check passed on the first run with nothing edited.
  This entry is the only change in this session.
- API path the specs use: `POST /api/v1/login` → `POST /api/v2/projects/<uuid>/query/sql` (`context: sqlRunner`,
  `invalidateCache: true`) → poll `GET /api/v2/projects/<uuid>/query/<queryUuid>` until `status: ready`; cell
  values come back as `{value: {raw}}`.
- Scenario restart body uses `incidentAfterSeconds` / `recoveryAfterSeconds`. With `incidentAt`/`recoveryAt` the
  clock answers 400, so the data stays on the default timeline.
- Tested as a user: up.sh; signed in as the stack.json demo user through `/api/v1/login`; set the scenario to
  incident −240 s and recovery −90 s; ran through the SQL Runner API
  `promql('hrx_fill_queue_backlog{queue="fill"}', from, to, '15s')` → 27 rows, baseline max 47, incident window
  141–166 (≥120); `count(*)` over `logql('{app="fill-service"} |= "level=error"', ...)` → 47 in the incident window
  vs 4 at baseline. The fake S3 bucket gained one object per query (3 → 6 over three queries). down.sh; no demo
  process left. `run.sh --stack lightdash-engine-query.spec.ts` passes (1 test).
- 2026-11-09T08:16:41Z supervisor: demo-lightdash-engine-query passed the gate in round 1

### demo-dashboard-pharmacy-ops (2026-11-09, run 20261109-013019)

- New `demo/eng-1799/content/` (Lightdash content as code, keys sorted as `lightdash download` writes them so the
  CLI prints no warnings): virtual view `hrx_fill_queue_backlog` (`ts`, `queue`, `backlog` from
  `promql('hrx_fill_queue_backlog', now() - INTERVAL '6 hours', now(), '15s')`, queue parsed from `series` with
  `regexp_replace`: the engine has no `->>`/json_get), four charts in space `pharmacy-ops`, dashboard
  `pharmacy-ops-overview` ("Pharmacy Ops overview"). Field ids: `hrx_fill_queue_backlog_ts_raw`, `_queue`, `_backlog`;
  metrics are chart `additionalMetrics` (max of backlog), since virtual views have no metrics.
- Tiles, all **built-in** charts (no registry/ee): `Current fill queue backlog` big number (latest sample of
  queue=fill: dims ts_raw sorted desc, limit 1; conditional formatting `#E02F44` at >= 100), `Fill queue backlog`
  cartesian line with `thresholds` (dashed, steps null/#73BF69 and 100/#F2495C; y axis pinned 0..200 so the line
  shows in the baseline too), `Peak backlog by queue` horizontal bar (flipAxes, 0..200) = the bar gauge, `Queue
  status` table whose Status column has Grafana range `valueMappings` (OK < 60, Elevated 60..99.999, Backlogged >= 100).
  Dashboard Time Range `now-30m..now`, refresh `30s`, every Tile mapped to `hrx_fill_queue_backlog_ts_raw`.
- **Trap: explore charts get no reserved time parameters** (`withTimeRangeParameters` is only applied in
  `executeAsyncSqlQuery` and `executeAsyncDashboardSqlChartQuery`; dashboard chart Tiles get only the `inBetween`
  tile filter). Thresholds/valueMappings exist only on explore charts, so the view window is fixed (6 h) and the
  range filters inside it. SQL chart Tiles (Service health, Platform DB) can use `${ld.parameters.__from}` instead.
- Seed (`stack/seed.ts`) step 5: creates a PAT (`POST /api/v1/user/me/personal-access-tokens` needs
  `autoGenerated: false`), runs `lightdash upload --project <uuid> --path demo/eng-1799/content` and checks every
  dashboard in `CONTENT_DASHBOARDS` (name + chart Tile count) and each Tile's saved chart. **Add new dashboards
  there** (Service health, Platform DB). The PAT is in `.state/run/seed.json` as `lightdash.apiToken` (not copied
  to stack.json) for later seed steps (`upload --alerting-only`, `import portal-scripts`).
- **Trap: how the CLI runs.** Not via pnpm: the CLI writes `~/.config/lightdash` (sandbox refuses the real home),
  so it runs with `HOME=.state/cli-home`, and pnpm with a moved HOME refuses to start (its pinned version
  check). So the seed spawns `<pinned node> packages/cli/node_modules/tsx/dist/cli.mjs src/index.ts upload ...` with
  cwd `packages/cli`; up.sh passes `--cli-node "$LIGHTDASH_NODE"`. New `stack/no-network.mjs` (preloaded with
  `NODE_OPTIONS=--import`) makes `dns.lookup` answer ENOTFOUND for anything but localhost: the CLI otherwise posts
  analytics to Lightdash's analytics host and checks GitHub for upgrades on every run. Upload takes ~5 s; warm
  up.sh ~22 s.
- `docs/eng-1799/demo.md` gains "Dashboards as code" (the Tiles, the chart choices, the fixed window).
- Tested as a user: fresh up.sh (seed log: 1 virtual view, 4 charts, 1 dashboard created); in Chromium signed in
  through the /login form, Browse → dashboards → Pharmacy Ops overview: header "Last 30 minutes" with the Refresh
  select at 30s; baseline: stat 34–37 in black, line ~20–48 under a red dashed line at 100, bars fill 48 / pack 22 /
  ship 12, Status OK in green; during the default incident: stat 169 in red, the line jumps over the threshold,
  Status for fill "Backlogged" in red. No page errors, no tile errors. Re-upload over the running stack updated in
  place (4 charts, 1 dashboard updated). Checks: `run.sh --stack dashboard-pharmacy-ops.spec.ts --grep
  "demo-dashboard-pharmacy-ops:"` passes; `seed-project.spec.ts` (--stack) passes; the `-ui:` test also passed once
  against a running stack (not this feature's gate). `tsc --ignoreConfig --strict --module nodenext --types node
  stack/*.ts` clean; no demo process left.
- 2026-11-09T08:32:57Z supervisor: demo-dashboard-pharmacy-ops passed the gate in round 1

## demo-dashboard-pharmacy-ops-ui (functional) — 2026-11-09

- No code change: the dashboard content from demo-dashboard-pharmacy-ops (e3d40f853) already renders live and
  meets every step. This session only verified it and wrote this entry.
- Tested as a user: `init.sh` ok; `up.sh` by hand; in Chromium (a throwaway Playwright script under the run's tmp/,
  not in the repo) signed in through the /login form, went to the project's dashboards list and clicked "Pharmacy Ops
  overview". Baseline (scenario restarted with the incident 900 s out): header "Last 30 minutes" + Refresh 30s, four
  Tiles with no error text, stat 27 in near-black rgb(24,24,27), line ~20–48 under the red dashed threshold at 100,
  Status OK (green). Incident (restart -120/900, a few reloads): stat 143 in rgb(224,47,68), the line jumps above
  100, Peak fill 160, Status "Backlogged" in red. 0 page errors. down.sh afterwards; no demo process left.
- Check: `run.sh --stack dashboard-pharmacy-ops.spec.ts --grep "demo-dashboard-pharmacy-ops-ui:"` passes (11.9 s).
- For the next session: after a scenario restart the stat can take one or two reloads to go red. Results are
  cached per rounded Dashboard Time Range, which is why the spec reloads in a loop. Keep that in mind for scene specs.
- 2026-11-09T08:39:26Z supervisor: demo-dashboard-pharmacy-ops-ui passed the gate in round 1
- 2026-11-09T08:43:02Z supervisor: demo-dashboard-service-health halted: the worker halted on demo-dashboard-service-health

## demo-dashboard-platform-db (content) — 2026-11-09

- Content: `demo/eng-1799/content/charts/{orders-by-status,open-fills-by-queue,shipments-by-carrier}.yml` (saved SQL
  charts, `contentType: sql_chart`, space `platform-db`) and `dashboards/platform-db.yml` ("Platform DB", three
  `sql_chart` Tiles). Each SQL is `SELECT ... FROM platform_query('<aggregate over orders | fills+queues |
  shipments>')`. They are aggregates only, with no row-level column. Two bar charts and one table. Every chart has a
  `description`, **which is required**, see below.
- **Backend fix (outside ee/)**, as anticipated by risk 4: saved SQL charts carry no audit block, and
  `executeAsyncSqlChartQuery` / `executeAsyncDashboardSqlChartQuery` ran their column-discovery probe with no
  identity (`RESET hrx.identity`). A `platform_query` Tile would therefore have been refused. Both methods now:
  - take the Audited Query description from the saved chart's description (new `savedSqlChartAudit` in
    `queryTimeRange.ts`, trimmed, `ticket: null`, and undefined for a blank description);
  - run `prepareSqlChartAsyncQueryArgs` inside `withAccountFederationIdentity`. A dashboard Tile is audited with
    source `tile` and `resource_uuid` = the tile uuid; a standalone saved chart as `investigate`;
  - persist `audit` (and `tileUuid` for the dashboard path) in the request parameters, so the async run (and a
    rebuild from history) mints the same audit block through `federationQueryAudit`.
  A SQL chart with no description over a non-audited source works as before. Over the Platform Database, the
  engine refuses it with "audited query requires a description".
- Seed: `CONTENT_DASHBOARDS` entries now have `sqlChartTiles`, and `checkContent` also resolves each SQL Tile's
  `savedSqlUuid` (`GET /api/v1/projects/<p>/sqlRunner/saved/<uuid>`). Platform DB = 0 chart + 3 SQL Tiles.
- Docs: `docs/eng-1799/demo.md` "Dashboards as code" gains a Platform DB paragraph (the Tiles, the description rule).
- Unit: `queryTimeRange.test.ts` +2 tests (15/15). Backend `pnpm run typecheck` clean; demo `tsc ... stack/*.ts`
  clean.
- Tested as a user: fresh `up.sh` (the seed accepted 3 SQL Tiles). In Chromium (a throwaway script in the run's tmp/),
  signed in through the /login form, went to Browse → dashboards → "Platform DB". Orders by status shows 5 bars,
  Open fills by queue shows 2 bars (demo-intake, demo-fill), and Shipments by carrier is a 4-row table. No error
  text, no 5xx (only the pre-sign-in 401s and the unrelated aiAgents 422s). Engine audit browser: 6 records, 2 per
  Tile (probe + run), action `query`, status `success`, database `platform`, executed by the demo user, with each
  chart's description.
- Checks: `run.sh --stack dashboard-platform-db.spec.ts` passes. Regression: `seed-project.spec.ts` and
  `dashboard-pharmacy-ops.spec.ts` (both tests) pass with --stack.
- For the next session: SQL chart Tiles on audited sources need a chart `description`. A Tile's results are not
  cached (federation bypasses the results cache), so each dashboard load writes 2 audit records per Tile.
- 2026-11-09T08:54:36Z supervisor: demo-dashboard-platform-db passed the gate in round 1
- 2026-11-09T08:55:29Z supervisor: demo-grafana-fixture halted: the worker halted on demo-grafana-fixture
- 2026-11-09T08:56:57Z supervisor: demo-portal-script halted: worker demo.feature.demo-portal-script.r1 stopped: STOP file present

## Decisions by the controls engineer (2026-11-09, after three halts)

- **`demo-package-workspace`:** the protected `package.spec.ts` ran `git check-ignore -q` with two paths, which git
  always rejects. Fixed in the spec (one call per path). Redo the feature; the earlier session's notes still apply.
- **`demo-dashboard-service-health` (trace waterfall), decided: a pinned example trace, no engine change.**
  - The demo's fake Tempo serves one **pinned example trace** for the incident's slow call under a fixed,
    documented trace id that never changes with the scenario clock or a restart: for example the hex id
    `de300000000000000000000000000001`. Put it in one shared constant. The trace has the slow
    `shipping-label-api` span and looks like the incident's other slow traces. The fake returns it from
    `trace(<id>)` at any time, and it shows in `traceql()` search results while the incident runs.
  - The Service health dashboard gets a `trace_id` parameter whose default is that id. The trace_waterfall
    Tile's SQL is `SELECT ... FROM trace('${ld.parameters.trace_id}')` (or the reserved-parameter form the
    viz/ldq lines use), so a viewer can paste any trace id, like a Grafana trace-id variable. No SQL in the
    content rebuilds the fake's own ids.
  - Do not change the engine. The limit (table-function arguments must be constants, so no "latest slow trace"
    subquery) is recorded as an ENG-1799 follow-up in `docs/eng-1799/demo.md` under "Known limits".
  - Scene 4 may open the waterfall through the parameter default or by setting the parameter.
- **`demo-grafana-fixture`:** blocked only by Service health. Redo it once that passes.

### demo-package-workspace (2026-11-09, run 20261109-013019, redo after the spec fix)

- New `demo/eng-1799/tsconfig.json`: the flags the acceptance specs typecheck with (`strict`, `module`/`moduleResolution`
  `nodenext`, `lib` es2022+dom, `types` node, `esModuleInterop`, `skipLibCheck`, `noEmit`), `include` every
  `**/*.ts|mts|cts` in the package (acceptance included: 43 files plus 16 under `stack/` today), excluding
  `node_modules`, `.state`, `out`, `test-results`, `playwright-report`. Having its own tsconfig also stops `tsc` from
  picking up the repo root `tsconfig.json`, so `--ignoreConfig` is no longer needed.
- `demo/eng-1799/package.json` scripts: `typecheck` = `tsc --noEmit -p tsconfig.json` (TypeScript 7.0.2, under a
  second). `walkthrough`, `video` and `ask` are **stubs** that print "not implemented yet (…feature…)" and exit 1.
  They are `node -e "…" --`: the trailing `--` matters, because pnpm appends the caller's args (`--json`, `--music`)
  and node rejects unknown flags otherwise. **Next sessions:** replace the stub with the real command
  (`bash walkthrough/run.sh`, `tsx video/build.ts`, `tsx ask/…`). The package stays CommonJS (no `"type": "module"`).
- No change to `init-demo.sh`: it already re-runs ffmpeg-static's install or `playwright install chromium` only
  when the binary / chromium executable is missing; two warm `bash ./init.sh` runs downloaded nothing.
- Tested as a user: `pnpm install --frozen-lockfile` (lockfile up to date, exit 0); `pnpm -F eng-1799-demo typecheck`
  exit 0, and exit 1 with a deliberately wrong probe file under `stack/` (removed again); `git check-ignore -v` for
  `.state/probe` and `out/probe.mp4` → `.gitignore:185/186`; each stub with extra args prints its message and fails.
  Check `bash demo/eng-1799/acceptance/run.sh package.spec.ts`: 1 passed.
- 2026-11-09T09:01:31Z supervisor: demo-package-workspace passed the gate in round 1

### demo-dashboard-service-health (2026-11-09, run 20261109-013019, redo after the controls-engineer decision)

- **Pinned example trace** (as decided): `PINNED_TRACE_ID = 'de300000000000000000000000000001'` exported from
  `stack/tempo.ts`, the only place the id is written. The fake's trace builder was split into `slot()` +
  `shipTrace(key, …)` (slot traces keep their exact hash keys, so they are unchanged). `pinnedTrace(tl)` is a slow,
  successful 5-span trace starting at `incidentAt + 1 s` (shipping-label-api span 2000–4999 ms). `traceById()`
  returns it at any time; `fillServiceTraces()` inserts it by start time, so `/api/search` (and `traceql()`) lists it
  once the incident is running. Its first 8 hex digits are a 2088 slot second, so it never collides with a slot trace.
- **Seed**: before the upload, `PUT /api/v2/projects/<uuid>/parameters` defines the project parameter `trace_id`
  (label "Trace ID", default = PINNED_TRACE_ID, `options: [id]`, `allow_custom_values: true`). **Trap:** a virtual
  view may only reference *defined* project parameters (`validateVirtualViewParameterReferences`), so the definition
  must come before `lightdash upload`. `CONTENT_DASHBOARDS` gains `Service health` (3 chart Tiles).
- **Content**: three virtual views and three explore charts in space `service-health`. Dashboard `Service health` has
  no Dashboard Time Range, so the windows are fixed:
  - `hrx_fill_service_log_rate`: `logql_metric('sum by (level) (count_over_time({app="fill-service"}[1m]))', now()-30m,
    now(), '1m')` → chart `Log level heatmap` (`type: custom`, a Vega-Lite `rect` heatmap, minute × level; **built in,
    no chart registry**);
  - `hrx_fill_service_logs`: `logql('{app="fill-service"}', now()-30m, now(), 500)`, with the level parsed from the
    line's `level=` and `CAST(labels AS VARCHAR)` → `Fill service logs` (native `log_stream`, newest first);
  - `hrx_fill_service_trace`: `trace(${ld.parameters.trace_id})` (bare reference; Lightdash writes it as a quoted
    literal), `CAST(attributes AS VARCHAR)` → `Slow trace waterfall` (native `trace_waterfall`).
- **Traps found:**
  - SQL chart Tiles (`DashboardSqlChartTile`) only render table, big number, cartesian and pie charts, so log_stream
    and trace_waterfall must be **explore charts** over virtual views.
  - Virtual-view timestamp columns get `_raw/_day/_week/_month/_quarter/_year` only, **no `_minute`**. That is why
    the heatmap has its own per-minute view. Use `<view>_<col>_raw` as the field id (by-name binding misses `_raw`).
  - Charts as code need `version: 1`, or the upload fails with "'version' is required".
  - Vega-Lite `timeUnit` must be `utchoursminutes`, or the axis shows the browser's local time.
- Docs: `docs/eng-1799/demo.md` gains a Service health paragraph (Tiles, the trace_id parameter, how to paste an id)
  and a new **"Known limits"** section with the ENG-1799 follow-up: table-function args must be constants, so there
  is no "latest slow trace" subquery.
- Tested as a user: fresh up.sh, then the scenario restarted at incident −180 s. In Chromium (throwaway scripts in
  the run's tmp/) I signed in through the /login form and went to Browse → dashboards → Service health. The header
  shows "Trace ID is de30…0001". The heatmap's error row turns dark red in the last 3 minutes (about 30/min against a
  pale baseline), and the x axis is in UTC, matching the log timestamps. The log stream shows "500 of 500 lines",
  newest first, with mostly red error rows ("create shipping label failed …"). The waterfall shows 5 spans: root
  4.9 s, `POST /v1/labels` on shipping-label-api 4.86 s, in two service colours. No tile errors, no page errors.
  Pasting another slow trace id from `/api/search?q={ duration > 2s }` into the Trace ID parameter ("Add …") reran
  the waterfall with that trace (4 spans, 3.21 s, a failed one). The fake Tempo search lists the pinned id, and
  `/api/traces/<pinned>` returns 200.
- Checks: `run.sh --stack dashboard-service-health.spec.ts` passes (1 test). Regression, each with --stack:
  fake-tempo, seed-project, dashboard-platform-db, dashboard-pharmacy-ops (2 tests) pass. `pnpm -F eng-1799-demo
  typecheck` is clean. Stack down afterwards.
- **Next:** `demo-grafana-fixture` was blocked only by this feature, so redo it now. Scene 4 can open the waterfall
  through the parameter default (no URL parameter needed).
- 2026-11-09T09:18:21Z supervisor: demo-dashboard-service-health passed the gate in round 1

### demo-grafana-fixture (2026-11-09, run 20261109-013019, redo after Service health passed)

- **No importer CLI in the base.** `packages/cli` has only `alerting shadow-report --grafana-history`; the Grafana
  side is the mapping module `packages/common/src/eng1799/grafanaPanelMapping.ts` (and docs), with no dashboard
  importer. So the conversion is the hand-written YAML route that the feature allows.
- New `demo/eng-1799/seed/grafana/pharmacy-ops-overview.json`: a synthetic Grafana export (schemaVersion 39, a
  `DS_DEMO_PROMETHEUS` datasource input, no hosts) of **Pharmacy Ops overview**. Four panels: `stat` "Current fill
  queue backlog", `timeseries` "Fill queue backlog" (dashed threshold at 100), `bargauge` "Peak backlog by queue",
  and `table` "Queue status" (OK/Elevated/Backlogged range value mappings, the same shape as the chart YAML). Time
  `now-30m`, refresh `30s`. Grafana gridPos (24 cols) × 1.5 = the YAML's x/w (36 cols); h is the same.
- `content/dashboards/pharmacy-ops-overview.yml` gains a header comment naming its Grafana source. YAML comments
  pass through `lightdash upload`; the Tiles are unchanged. `docs/eng-1799/demo.md` gains a paragraph under
  Pharmacy Ops overview. **Deviation recorded there:** `stat`/`bargauge` became built-in big number and horizontal
  bar, not the mapping doc's `stat-sparkline`/`bar-gauge` registry entries, so the demo needs no chart registry.
- **Trap:** the spec matches every panel title (lowercased) to a Tile title of Pharmacy Ops, Service health or
  Platform DB. Rename a Tile, and you must rename the panel too.
- Tested as a user: fresh up.sh, then in Chromium (throwaway script in the run's tmp/) I signed in through /login and
  opened Browse → dashboards → Pharmacy Ops overview. All four fixture panels show as Tiles with data: big number
  19, the line with a red dashed line at 100, bars fill/pack/ship, and the table with Status OK. No tile or page
  errors. Stack down afterwards.
- Checks: `run.sh --stack grafana-fixture.spec.ts` passes (1 test). Regression: `--stack
  dashboard-pharmacy-ops.spec.ts` passes (2 tests). Typecheck is clean. `docs.spec.ts` fails as it did before this
  change (no "prerequisites" heading yet, which is demo-docs' job).
- 2026-11-09T09:26:56Z supervisor: demo-grafana-fixture passed the gate in round 1

### demo-portal-script (2026-11-09, run 20261109-013019, round 1)

- The importer already exists: `packages/cli/src/handlers/importPortalScripts.ts` (ldq line). Nothing changed in
  packages/.
- New `demo/eng-1799/seed/portal-scripts.json` is a synthetic export with one script, **"Open fills past target by
  queue"** (id `demo-script-0001`). Its SQL is Platform SQL over `fills`/`queues` with aggregates only: no names, no
  addresses, no single quotes. It also has the extra portal fields (tags, a synthetic example.com `createdBy`,
  timestamps), which the importer leaves out.
- `up.sh`: before the seed, it copies `content/` to `.state/run/content` and runs the CLI from source
  (`import portal-scripts … --path .state/run/content --space platform-saved-sql`) on the pinned Node, with HOME
  `.state/cli-home`, `no-network.mjs` preloaded and output in `seed.log`. Then `seed.ts` gets
  `--content-dir .state/run/content`, so one `lightdash upload` covers dashboards and imported charts. **Trap:**
  `content/` itself must stay free of imported charts. The spec greps up.sh/seed.sh for `import portal-scripts`, so
  the call has to stay in up.sh, not move into seed.ts.
- `docs/eng-1799/demo.md`: new "Portal saved script" subsection and a **Known limits** entry.
- **Known limit (ENG-1799 follow-up; the spec settles it, so this is not a halt):** portal SQL is kept verbatim and reads
  Platform tables directly. Opening the SQL chart itself, or loading it into the SQL box from Investigate's Saved
  SQL, fails with "table 'datafusion.public.fills' not found". It returns rows when run as Platform SQL
  (Investigate → Platform Database, which wraps it in `platform_query`), and that is what the spec does too.
  A fix belongs to the ldq line: a "Platform SQL" marker on saved SQL, or the importer wrapping the SQL. The spec
  requires `saved.sql` to equal the portal text, so a fix can't just rewrite the stored SQL.
- Tested as a user: fresh up.sh, then Chromium via throwaway scripts in the run's tmp/portal-ui/, signed in through
  /login. Spaces → "Platform saved sql" → the chart opens at `/sql-runner/open-fills-past-target-by-queue` and shows
  the DataFusion error above (the known limit). SQL Runner → Investigate → Saved SQL lists the chart. Platform
  Database → pasted the chart's saved SQL, added a Description and ticket ENG-1799, then Run: columns queue /
  target_minutes / open_fills / past_target and 2 queue rows, no errors. The engine audit has 2 `query | success
  | platform` records with that description.
- Checks: `run.sh --stack portal-script.spec.ts` passes (1 test). Regression with --stack: seed-project,
  dashboard-platform-db and grafana-fixture all pass. Typecheck is clean. Stack is down.
- 2026-11-09T09:38:55Z supervisor: demo-portal-script passed the gate in round 1

### demo-alerting-seed (2026-11-09, run 20261109-013019, round 1)

- New `demo/eng-1799/alerting/` (alerting as code, the `--alerting-only` layout): the Alert Rules **Fill queue backlog
  high** (`promql('hrx_fill_queue_backlog{queue="fill"}', __from, __to, '15s')`, last > 100) and **Fill service error
  log rate** (`logql_metric('sum(count_over_time({app="fill-service"} |= "level=error" [1m]))', …, '30s')`, last > 10).
  Both have interval 30s, timeRange 5m, `for` 0s, labels team=pharmacy-ops/service/severity, annotations that render
  `{{ $value }}`, and are `paused: false` and `shadow: false`. Also the Contact Point `incident-io` (incident_io type,
  url `__DEMO_INCIDENT_IO_URL__/webhook`, token `secretRef: demo-incident-io-token`) and a route tree (default →
  incident-io; child team=pharmacy-ops → incident-io with groupWait 1s, groupInterval 15s).
- `stack/seed.ts` step 6: copies `alerting/` to `.state/run/alerting` (new args `--alerting-dir`, `--alerting-out`,
  `--incident-io-url`), fills in the receiver URL, runs `lightdash upload --alerting-only` (the CLI runner is now one
  `runCli()` shared with the content upload), then checks both rules unpaused and not in Shadow Run, the Contact Point
  on the receiver, and the tree routing to it. `up.sh` passes the new args. `stack/lightdash.ts` adds
  `ALERTING_SECRET_DEMO_INCIDENT_IO_TOKEN=demo-incident-io-token-not-real` to lightdash.env (the fake accepts any
  bearer). `docs/eng-1799/demo.md` gets an "Alerting as code" section.
- **Trap:** everything is uploaded as code, so it is **Managed** and read-only (the API returns 403 on PATCH/DELETE).
  Later features that need a rule changed must edit the YAML, not call the API. The spec forbids the strings
  `test-secret-not-real` and `Bearer ` in the Contact Point JSON, so keep the token a secretRef.
- **Follow-up (alerting line's UI, not done here):** the navbar has no Alerting entry. Users (and the scene-03
  walkthrough) open `/projects/<uuid>/alerting/rules` directly. The page heading is "Alerting" with tabs Alert Rules /
  Contact Points / Notification Routes.
- For demo-alert-fires/resolves: already verified once by hand. With the scenario shifted into the incident, both rules were
  `firing` on the first poll (≤10 s), and within ~30 s the receiver had 2 firing notifications with rendered summaries
  ("Fill queue backlog is 173 (threshold 100)", "fill-service logged 23 errors in the last minute (threshold 10)"),
  so the secretRef resolves. Resolve was not tried.
- Tested as a user: fresh up.sh (seed.log: "Uploaded 1 contact points, 1 notification route trees and 2 alert rules …
  4 created"). In Chromium (throwaway script in the run's tmp/alerting-ui/) I signed in through /login and opened
  Alerting → Alert Rules: both rules Normal, "Managed in git", with their labels. Contact Points shows "incident.io (demo
  receiver)". Notification Routes shows the default route and the team = pharmacy-ops route, both to it. No page
  errors. Scenario reset to baseline, stack down.
- Checks: `run.sh --stack alerting-seed.spec.ts` passes (1 test). Regression with --stack: portal-script and seed-project
  pass. Typecheck clean. No demo process left.
- 2026-11-09T09:52:18Z supervisor: demo-alerting-seed passed the gate in round 1

### demo-alert-fires (2026-11-09, run 20261109-013019, round 1)

- **No code change.** The demo-alerting-seed work (rules interval 30s, `for` 0s, contact point on the fake receiver with
  the token as a secretRef, route groupWait 1s) already makes the rules fire, so this session only verified it.
- Check: `DEMO_INCIDENT_AT=3600 DEMO_RECOVERY_AT=7200 run.sh --stack alert-lifecycle.spec.ts --grep "demo-alert-fires:"`
  passes (1 test, 1.1m) on the first try after `bash ./init.sh`.
- Tested as a user: fresh up.sh with the incident at +3600 s. In Chromium (throwaway script in the run's
  tmp/alert-fires/) I signed in through /login and opened `/projects/<uuid>/alerting/rules`: the backlog rule was Normal
  and the error-log rule had no state yet ("—"). Then POST `/scenario/restart {incidentAfterSeconds: 5, recoveryAfterSeconds: 900}`.
  By the poll at ~32 s after the restart, both rules showed **Firing** in the UI and stayed Firing. The fake incident.io page
  (`<incidentIo.url>/`) listed 2 FIRING notifications, received ~46 s after the restart: "Fill queue backlog is 144
  (threshold 100)" and "fill-service logged 11 errors in the last minute (threshold 10)", with labels and startsAt. No page errors.
- Note for demo-alert-resolves: the error-log rule's value during the incident can sit close to its threshold of 10
  (11 here, 23 in the earlier hand run), so a scene that needs it firing reliably may want a lower threshold. Change the
  YAML in `alerting/`, not the API (the rules are Managed). Stack is down.
- 2026-11-09T10:03:09Z supervisor: demo-alert-fires passed the gate in round 1

### demo-alert-resolves (2026-11-09, run 20261109-013019, round 1)

- **No code change.** The demo-alerting-seed setup (interval 30s, `for` 0s, `disableResolveMessage: false` on the
  incident.io Contact Point, route groupWait 1s / groupInterval 15s) already makes the backlog rule resolve and send a
  resolve notification. This session only verified it.
- Check: `bash ./init.sh`, then `run.sh --stack alert-lifecycle.spec.ts --grep "demo-alert-resolves:"` passed on the
  first try (1 test, 1.3m).
- Tested as a user: fresh up.sh. In Chromium (throwaway script in the run's tmp/alert-resolves/) I signed in through
  /login and opened `/projects/<uuid>/alerting/rules`: the backlog rule showed Normal. Then I sent POST `/scenario/restart
  {incidentAfterSeconds: -120, recoveryAfterSeconds: 35}` (phase "incident"). The rule showed **Firing** from ~32 s
  after the restart until ~90 s, then **Normal**. The fake incident.io page listed 3 notifications: FIRING backlog
  ("Fill queue backlog is 149"), FIRING error-log rate (26 errors), and **RESOLVED** backlog ("Fill queue backlog is
  94 (threshold 100)") with startsAt 10:06:30Z and endsAt 10:07:00Z, received about 74 s after the restart. The firing
  alerts carry Alertmanager's zero endsAt (`0001-01-01T00:00:00Z`). No page errors.
- Timing note: the resolve notification reached the receiver (10:07:21Z) about 13 s before the rules page stopped
  showing Firing. Scenes that wait on both should poll the receiver as well as the UI, not assume one order. With a
  30 s interval and recovery at +35 s, at least one evaluation always lands inside the incident, so the spec's firing
  window is reliable. Stack is down.
- 2026-11-09T10:13:46Z supervisor: demo-alert-resolves passed the gate in round 1

### demo-mcp-server (2026-11-09, run 20261109-013019, round 1)

- **What changed.** `up.sh` now starts telemetry-mcp (`node packages/telemetry-mcp/dist/main.js`, built by
  init.sh's init-mcp.sh) after the seed. It waits for `/healthz` (30 s) and records `mcp: {url}`, `okta: {issuer}` and
  process `telemetry-mcp` in stack.json. A missing dist fails up.sh early with "run bash ./init.sh".
  - `stack/okta.ts` (new): a fake Okta mounted in the telemetry-fakes process on an ephemeral port. Its issuer is
    `http://127.0.0.1:<port>/oauth2/default`, and it serves the JWKS at `/v1/keys` plus discovery. `POST /v1/token
    {email}` returns an RS256 token with aud `api://telemetry-mcp-demo` that is valid for 1 h. The key is generated
    at start, so tokens die with the process. It is in telemetry-fakes.json as `okta: {url, issuer}`.
  - `stack/engine-config.ts`: a second engine `[[users]]` login, `telemetry-mcp` (password env
    `HRX_PG_PASSWORD_TELEMETRY_MCP`). The ready file gets `telemetryMcp: {user, password, sources}`, where `sources`
    is MCP_SOURCES mirroring the six `[[sources]]`, each the default of its kind. **If you add an engine source, add
    it to `MCP_SOURCES` too.**
  - `stack/mcp.ts` (new): picks a free port and writes `.state/mcp/mcp.env` (0600), the server's whole environment.
    That covers the Okta issuer/audience, LIGHTDASH_URL/PROJECT_UUID, and the seed's PAT (`seed.json
    lightdash.apiToken`) as LIGHTDASH_API_TOKEN. The demo user is the org admin, so `/api/v1/org/users` and
    `/org/attributes` work. It also sets the engine pg/HTTP settings, the shared HRX_IDENTITY_SECRET and
    MCP_USER_CACHE_TTL_MS=5000. It sets no ANTHROPIC_API_KEY, so `ask_data` says AI is not configured.
  - docs/eng-1799/demo.md: new section "Telemetry MCP server".
- **Tested as a user** (fresh up.sh, curl as an MCP client): `/healthz` returned 200 `{"status":"ok"}`. POST /mcp
  without a token returned 401 with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
  A garbage token returned 401 `error="invalid_token"`. The metadata names the fake Okta issuer. With a demo-user
  token from the fake Okta, `initialize` worked and `tools/list` returned all 14 tools. `list_sources` returned the
  6 sources with `opsMarts: []`. `platform_query` `select count(*) from queues` returned n = 4 through the
  engine (audited). `query_promql` `hrx_fill_queue_backlog{queue="fill"}` at `now` returned 27 (baseline). A token
  for nobody@example.com got an empty tool list. `alert_state` returned `{"instances": []}` while both rules were
  Normal. That is Lightdash's own answer: `/alerting/state` lists only non-normal instances. After POST
  `/scenario/restart {-60, 600}`, it listed both rules **firing** (backlog 150, with rendered annotations).
- **Checks:** `bash ./init.sh`, then `run.sh --stack mcp-server.spec.ts` passed (1 test). Regression: `--stack`
  engine-healthy, seed-project and engine-boot pass. Demo typecheck is clean. down.sh stops telemetry-mcp (its pid
  is in stack.json and `.state` is on its command line), and no process is left.
- **For demo-mcp-ask:** the metric is `hrx_fill_queue_backlog` (not `fill_queue_backlog`, which returns 0 rows). An
  instant query needs `at` (`"now"` works). A range query needs start, end and step. The MCP response is SSE
  (`event: message` / `data: {...}`), so a client must send `accept: application/json, text/event-stream`.
- 2026-11-09T10:26:58Z supervisor: demo-mcp-server passed the gate in round 1

### demo-stack-lifecycle (2026-11-09, run 20261109-013019, round 1)

- **What was already there.** Earlier features had built up.sh's idempotency (a live stack, meaning every recorded pid
  alive and the scenario clock answering, is kept and reported again) and down.sh (pg_ctl stop, then TERM/KILL on the
  recorded process groups and on anything whose command line mentions `.state`; exits 0 when nothing runs). Run by
  hand in a shell, all four steps already passed.
- **The bug the check found.** Under Playwright, up.sh failed with "seed needs --port". Playwright sets `FORCE_COLOR`,
  which reaches up.sh. With it set, Node's `console.log(<number>)` adds ANSI color codes even when stdout is a pipe, so
  `PLATFORM_PORT=$(platform-db.ts prepare)` captured `\e[33m<port>\e[39m`. Fix: `stack/platform-db.ts` prepare now
  writes the port with `process.stdout.write`, and up.sh rejects a non-numeric PLATFORM_PORT with a clear message.
  Only that capture was affected: the other `$(node ...)` captures print strings, which `console.log` never colors.
  **Trap for later work:** anything up.sh or a walkthrough script captures from Node must use `process.stdout.write`
  (or print a string), not `console.log` of a number or object.
- **Tested as a user.** down.sh with nothing running exited 0. up.sh took about 33 s; all 6 processes in stack.json
  were alive and all 17 ports open, all ephemeral. A second up.sh printed "already running; nothing changed", with the
  same pids and the same `Lightdash: http://127.0.0.1:<port>` line. down.sh took about 1.4 s: every pid gone, every
  port closed, and `pgrep -lf .state` was empty. A second down.sh exited 0.
- **Checks:** `bash ./init.sh`, then `run.sh lifecycle.spec.ts` passed (1 test, about 49 s). Regression:
  `run.sh --stack platform-db.spec.ts` passed. Demo typecheck is clean. No process is left.
- 2026-11-09T10:37:25Z supervisor: demo-stack-lifecycle passed the gate in round 1

### demo-mcp-ask (2026-11-09, run 20261109-013019, round 1)

- **What changed.** New `demo/eng-1799/ask/client.ts` (library: `ask(question, stack?)` returns
  `{question, tool, arguments, query, result: {columns, rows}, answer}`) and `ask/main.ts` (CLI: `--json`, `--list`,
  human-readable by default). `package.json` `ask` is now `node --import tsx ask/main.ts`. No model: the question is
  matched against a scripted intent list. "...fill queue backlog right now?" runs `query_promql`
  `hrx_fill_queue_backlog{queue="fill"}` with `at: "now"`. "...fill queue backlog ... over the last 15 minutes?" runs
  the same expression as a range query (now-15m..now, step 1m). An unknown question exits 1 and prints the list. The
  client signs in at the fake Okta (`stack.json okta.issuer`, `demoUser.email`), sends `initialize`,
  `notifications/initialized` and `tools/list` (it fails if the tool is missing), then `tools/call`. It reads the SSE
  replies and turns the tool's object rows into arrays in column order. It uses plain `fetch` and adds no dependency,
  so the lockfile is unchanged. docs/eng-1799/demo.md has a new subsection, "Asking a question (scripted MCP client)".
- **Tested as a user** (fresh up.sh): after scenario restart {-120, 900}, `pnpm -F eng-1799-demo ask --json "What is
  the fill queue backlog right now?"` gave tool query_promql, the PromQL, 1 row with value 166 and the answer "166 jobs
  right now, above the alert threshold of 100". The human-readable form showed the same. After restart {900, 1200}
  (baseline), the value was 21 and the answer said "below the threshold". The 15-minute range question answered
  18..46, latest 21. "what's the weather" exited 1 with the list.
- **Checks:** `bash ./init.sh`, then `run.sh --stack mcp-ask.spec.ts` passed (1 test). `run.sh package.spec.ts` passed.
  Demo typecheck is clean. No `.state` process is left. `docs.spec.ts` fails on headings (prerequisites, one command,
  ...), and it fails the same way without this change: it belongs to the later demo-docs feature.
- **For demo-scene-06-ai-question:** import `ask` from `demo/eng-1799/ask/client` (CommonJS, no extension) and write
  its return value as out/scenes/06-ai-question/answer.json. To script more questions, add entries to `INTENTS` in
  client.ts. Order matters: the range intent is checked before the "right now" intent.
- 2026-11-09T10:47:21Z supervisor: demo-mcp-ask passed the gate in round 1

### demo-scene-01-sign-in (2026-11-09, run 20261109-013019, round 1)

- **What changed.** New `demo/eng-1799/walkthrough/`:
  - `run.sh [scene-id ...]` runs each scene in its own Playwright process against the running stack. With no ids it
    runs every `NN-*.spec.ts` present, in name order. It stops at the first failure (exit 1), and a bad or missing
    id exits 2. Each scene's Playwright starts in its own process group: `set -m` is on only around the spawn, so
    bash prints no job notices. On TERM, INT or HUP, or after `DEMO_SCENE_TIMEOUT` seconds (default 900, via a
    watchdog subshell), the whole group gets TERM and then KILL after 5 s. After a normal exit the group is reaped
    too. `.bin/playwright` is called directly, without pnpm.
  - `playwright.config.ts` runs one worker at 1920x1080 with built-in video off. Its outputDir is the repo's
    `tmp/demo-walkthrough/` (not `.state/`, which down.sh reaps).
  - `lib/scene.ts` holds the shared fixtures. **Every later scene should import `test`/`expect` from here.** The
    `context` fixture records a 1920x1080 video and saves it as `out/scenes/<id>/video.webm` on teardown, even when
    the scene fails. The `scene` fixture takes the id from the spec file name, clears `out/scenes/<id>/` at the
    start, and gives `scene.keyMoment(page)` → `key-moment.png`. The `stack` fixture reads `.state/stack.json`.
    Steps: `signIn` (the real /login form: email → Continue → password → Sign in), `openDashboardFromList`, `tile`
    (`.react-grid-item` by exact title), `beat` (a short hold for viewers, never a wait for state), and
    `QUERY_ERROR_TEXT`.
  - `01-sign-in.spec.ts` (16 `expect`s) signs in and opens Pharmacy Ops overview from the dashboards list. It sets
    the Dashboard Time Range from Last 30 minutes to Last 1 hour (URL `from=now-1h`) and the range's **Refresh**
    select from 30s to 10s (URL `refresh=10s`). It then turns on **"Auto-refresh while viewing"** at 5m (menu
    "Auto-refresh options": the chosen item is disabled, and the header shows "Every 5m"). Decision: "turn
    auto-refresh on" maps to that stock menu, which defaults to Off. The Refresh select was already 30s from the
    seed, so the scene changes both.
  - `package.json` `walkthrough` is now `bash walkthrough/run.sh`. docs/eng-1799/demo.md has a new section,
    "Walkthrough scenes (recorded)", describing the runner and scene 01.
- **Selector traps.** The Time Range presets in the popover are buttons named "Last …" too. The header trigger is
  `button[aria-haspopup="dialog"]` filtered by text. The Refresh select is `getByRole('combobox', {name: 'Refresh'})`.
- **Tested as a user.** I brought the stack up with up.sh and ran `run.sh 01-sign-in`: it passed in about 17 s. The
  video is 1920x1080 and about 17 s long. I looked at the frames (login → home → dashboard). key-moment.png shows
  the dashboard over 09:55–10:50, with "Last 1 hour", "10s" and "Every 5m" in the header and the toast "Your
  dashboard will refresh every 5m". The stat is in black (baseline). TERM sent to run.sh at 7 s, with 4 chromium
  processes alive: exit 143 and 0 chromium afterwards. `DEMO_SCENE_TIMEOUT=6`: "ran longer than 6s", exit 1, 0
  chromium. A bad id exits 2.
- **Checks:** `bash ./init.sh`, then `run.sh --stack scene-01-sign-in.spec.ts` passed (1 test, about 51 s with
  up/down). `run.sh package.spec.ts` passed. Demo typecheck is clean. No `.state` process or chromium is left.
- 2026-11-09T11:01:21Z supervisor: demo-scene-01-sign-in passed the gate in round 1

### demo-scene-02-incident (2026-11-09, run 20261109-013019, round 1)

- **What changed.**
  - `demo/eng-1799/walkthrough/lib/scene.ts` has new shared helpers. `getScenario(stack)` does a GET on the scenario
    clock. `waitForPhase(stack, 'incident' | 'recovered', maxWaitMs)` polls `/scenario` every 500 ms until the phase
    is reached. If the phase is more than maxWaitMs away, it fails at once with a message that says to restart the
    clock. `refreshDashboard(page)` clicks the header's "Refresh dashboard" button. **Scenes 03 and 08 should use
    `waitForPhase`.** The walkthrough never restarts the clock itself.
  - `demo/eng-1799/walkthrough/02-incident.spec.ts` (24 `expect`s, scene timeout 240 s). It signs in and opens Pharmacy
    Ops overview. If the phase is baseline and the incident is more than 8 s away, it asserts the baseline: the line
    is under the threshold, and the stat is below 100 and not red. If not, it records a `baseline` annotation and
    skips that check. It then waits on the clock for `incident`. After that it refreshes every ~5 s for up to 90 s,
    until the line crosses the threshold and the stat is red and at or over 100. It also asserts Queue status
    "Backlogged", no query errors, and that the phase is still incident. It moves the mouse off the refresh button
    (so the "Last refreshed at" tooltip is gone), then takes the key moment.
  - docs/eng-1799/demo.md: a bullet for 02-incident under "Walkthrough scenes (recorded)".
- **How "crossed" is detected.** The time series Tile is ECharts drawn as **SVG** (not canvas). The series is the
  solid path with a hex stroke (#5470c6) and `M x y L x y …` data. The threshold is the path with stroke `#F2495C`
  and `stroke-dasharray="4,2"`. The line is crossed when the smallest series y is less than the threshold y (SVG y
  points down). The stat's big number is the leaf `P` (`_bigNumberText_…`). In the incident its computed color is
  rgb(224,47,68); in the baseline it is near-black.
- **Tested as a user.** I ran up.sh, restarted the clock with `{20, 900}` and ran `run.sh 02-incident`: it passed in
  about 57 s. The video is 1920x1080 and 57 s long. The frame at 14 s shows the baseline (stat 46 in black, line
  ~20–48 under the dashed line, all OK). key-moment.png shows the line jumping over the dashed threshold, stat 105→142
  in red and fill "Backlogged". When the clock was read after the run, the phase was incident.
- **Checks:** `bash ./init.sh`, then `acceptance/run.sh --stack scene-02-incident.spec.ts` passed (1.6 min test,
  about 2 min with up/down). `run.sh --stack scene-01-sign-in.spec.ts` still passes. The demo typecheck is clean. No
  chromium or `.state` process is left.
- 2026-11-09T11:16:45Z supervisor: demo-scene-02-incident passed the gate in round 1

### demo-scene-03-alert-fires (2026-11-09, run 20261109-013019, round 1)

- **What changed.**
  - New `demo/eng-1799/walkthrough/03-alert-fires.spec.ts` (18 `expect`s, scene timeout 300 s). It signs in and goes
    to `/projects/<uuid>/alerting/rules` by URL, because no nav link leads there. It asserts the Alert Rules tab is
    selected and the "Fill queue backlog high" row shows "Managed in git" and team=pharmacy-ops. In the baseline it
    asserts the row is not Firing. If the scene starts in the incident, it records a `baseline` annotation and skips
    that check. It waits for `incident` with `waitForPhase`. Then it reloads the list every ~3 s, for up to 120 s,
    until the state cell reads "Firing". The list doesn't poll: the rules query has no refetch interval. It then sets
    the State filter (`getByRole('combobox', {name: 'State'})`) to Firing. It polls the receiver's `/api/received` for
    a firing notification for the rule and opens the fake incident.io page. It asserts the rule's row has
    `td.status` "firing" in rgb(200,30,30), the summary `Fill queue backlog is N (threshold 100)` and the labels.
    Key moment: the incident.io page.
  - `walkthrough/lib/scene.ts`: `WalkthroughStack` has a new `incidentIo: {url}` field. It is type-only and already
    in stack.json.
  - docs/eng-1799/demo.md: a bullet for 03-alert-fires under "Walkthrough scenes (recorded)".
- **Selector notes.** A rule row is `getByRole('row')` filtered by the rule name's Anchor button. The state badge is
  the row's first cell. The fake incident.io page has a meta refresh every 5 s, so use auto-retrying locators on it.
- **Tested as a user.** I ran up.sh, restarted the clock with `{25, 900}` and ran `run.sh 03-alert-fires`: it
  passed in about 92 s. The video is 1920x1080 and 91 s long. The frame at 12 s shows both rules as Normal. The
  frame at 82 s shows both as Firing with State=Firing. key-moment.png shows two FIRING rows in red: the backlog
  rule with "Fill queue backlog is 166 (threshold 100)", and the error-log rule.
- **Checks:** `bash ./init.sh`, then `acceptance/run.sh --stack scene-03-alert-fires.spec.ts` passed (22 s: the
  check starts the clock in the incident, so the rule is already firing). The demo typecheck is clean.
  `docs.spec.ts` fails with or without this change ("a heading about prerequisites"). It belongs to the later
  demo-docs feature. No chromium or `.state` process is left.
- 2026-11-09T11:27:43Z supervisor: demo-scene-03-alert-fires passed the gate in round 1

### demo-scene-04-service-health (2026-11-09, run 20261109-013019, round 1)

- **What changed.**
  - New `demo/eng-1799/walkthrough/04-service-health.spec.ts` (25 `expect`s, scene timeout 300 s). It waits on the
    scenario clock for `incident` (`waitForPhase`, max 120 s away), signs in and opens Service health from the
    dashboards list. In the `Fill service logs` Tile it reads the "N of N lines" count, types `level=error` into the
    "Filter lines" box and asserts the count drops (still > 0), every drawn `log-stream-row` has
    `data-level="error"`, and a line mentions shipping-label-api. In the `Slow trace waterfall` Tile it finds the
    `trace-span-row` with service shipping-label-api and the `Show details of POST /v1/labels` button (depth > 0),
    hovers its bar, clicks it, and asserts the drawer (`role=dialog` holding `trace-span-drawer`) names the span and
    service, shows a Duration of >= 2 s and lists the attributes. Key moment: drawer open beside the filtered logs.
  - docs/eng-1799/demo.md: a bullet for 04-service-health under "Walkthrough scenes (recorded)".
- **Selector notes.** The log filter only matches the line text (not labels), so filter on `level=error`, which every
  error line carries. The log stream is virtualised: `rows.evaluateAll` sees only the rendered rows (enough to show
  the filter). Both Tiles sit side by side below the heatmap; at 1920x1080 they are in view together after scrolling.
  The drawer's Duration row is a Group (label + value); `formatDurationMs` writes `4.86 s` / `32 ms`.
- **Tested as a user.** up.sh, scenario restarted with `{-150, 900}`, `run.sh 04-service-health`: passed in about
  17 s. The video is 1920x1080 and 15.5 s long. The frame at 9 s shows "level=error" in the filter, "104 of 500
  lines", all red error rows ("create shipping label failed … downstream=shipping-label-api"), and the waterfall with
  5 spans (shipping-label-api `POST /v1/labels` 4.86 s, orange). key-moment.png shows the drawer: Service
  shipping-label-api, Duration 4.86 s, trace id de30…0001, attributes.
- **Checks:** `bash ./init.sh`, then `acceptance/run.sh --stack scene-04-service-health.spec.ts` passed (17.7 s test).
  The demo typecheck is clean. No chromium or `.state` process is left.
- 2026-11-09T11:37:20Z supervisor: demo-scene-04-service-health passed the gate in round 1
