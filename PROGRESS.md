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
| `startFakeBigQuery({ tables })` | See `OPS_MART_TABLES` in `fixtures.ts`. Serves what the engine's Ops Marts client calls (`tables.get`, `jobs.query`/`getQueryResults` or `tabledata.list`). |
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
