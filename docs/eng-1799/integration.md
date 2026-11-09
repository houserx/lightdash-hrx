# ENG-1799 integration: the e2e suite

The parallel lines (engine, ldq, mcp, alerting, viz) each built against `docs/eng-1799/CONTRACTS.md`
alone. The integration line puts them together and proves they work as one system. Its proof is the e2e
suite in `e2e/eng-1799/`. Each check starts the real Federation Engine binary, and also the real
Lightdash backend, alerting module or telemetry MCP server when it needs them. Only the outside systems
are fakes, and every value they hold is synthetic.

## Running the e2e suite

Run everything from the repo root.

```bash
bash ./init.sh                                                        # once per tree change; starts no server
bash e2e/eng-1799/acceptance/run.sh int-harness-engine.test.ts         # one check
bash e2e/eng-1799/acceptance/run.sh int-audit-browser.test.ts -t 'by ticket'   # one test in a check
bash e2e/eng-1799/run-all.sh                                           # the whole suite, one file at a time
bash e2e/eng-1799/run-all.sh int-write-                                # only the checks whose id starts with a prefix
```

- `bash ./init.sh` reaps what killed checks left under `tmp/e2e/` (engine processes and Postgres
  clusters older than 30 minutes). It installs the Node packages (`pnpm install --frozen-lockfile`) and
  builds the TypeScript packages the checks import (through `scripts/eng-1799/init-ldq.sh` and
  `init-mcp.sh`). Then it builds the engine binary into `tmp/cargo-target` (`CARGO_BUILD_JOBS=2`, no
  debug info). A warm run takes a few seconds. A cold run takes about 15 minutes, almost all of it the
  first `cargo build`. It also checks that `/opt/homebrew/bin/{initdb,pg_ctl,postgres}` exist.
- `e2e/eng-1799/acceptance/run.sh <file>` (protected) runs one acceptance file. It does an
  incremental `cargo build` (a no-op when nothing changed) and exports `E2E_ENGINE_BINARY`,
  `E2E_REPO_ROOT` and `TZ=UTC`. Then it runs vitest under `acceptance/vitest.config.ts`, which uses
  one file, one fork and 150 s per test. It exits 0 only when every test in the file passes. This is
  the gate the supervisor runs for each feature.
- `e2e/eng-1799/run-all.sh [prefix]` runs every `acceptance/*.test.ts` in name order, each through
  `acceptance/run.sh`, so no two checks ever share a server. It keeps going after a failure. At the
  end it prints how many passed and failed, lists each failed id, and exits non-zero if any failed.

Ground rules for the suite:

- **No Docker**, no network beyond 127.0.0.1, no fixed ports, no credentials. Every fake listens on an
  ephemeral port. Secret-shaped values look like `test-…-not-real`.
- Each check starts what it needs and stops it in `afterAll` (`track()` + `disposeAll` from
  `acceptance/support.ts`). Scratch dirs live under `tmp/e2e/<dir>/`, with the engine config at
  `<dir>/federation-engine.toml` and any Postgres cluster at `<dir>/pgdata`. That layout is what lets
  `init.sh` reap the leftovers of a killed run. `/tmp` is not used.
- Run one file at a time. Vitest is capped at 2 workers and cargo at 2 jobs, because the machine is
  shared.
- The Lightdash checks boot the real backend. The first boot builds a migrated template cluster under
  `tmp/lightdash-template/` (a few seconds more). Later boots clone it.

## Harness

`e2e/eng-1799/harness/` (`index.ts` re-exports everything) is the code the protected tests call. The
full API is the "Harness API" table in `PROGRESS.md`.

| Piece | File | What it is |
| --- | --- | --- |
| `startEngine` | `engine.ts` | The real engine binary with a generated config and a cleared environment. Its sources are wired to whichever fakes the check passes, and it always writes to an audit store. |
| `startFakePrometheus` | `prometheus.ts` | `query_range` / `query` over fixed synthetic series. The series and a delay can be changed at run time. |
| `startFakeLoki` | `loki.ts` | Log streams and metric series. |
| `startFakeTempo` | `tempo.ts` | Search and OTLP JSON traces. |
| `startFakeCloudWatch` | `cloudwatch.ts`, `cbor.ts` | GetMetricData over Smithy RPC v2 CBOR, the protocol the AWS SDK speaks, with a small CBOR codec. |
| `startFakeCloudWatchLogs` | `cloudwatchLogs.ts` | Logs Insights StartQuery / GetQueryResults. |
| `startFakeBigQuery` | `bigquery.ts` | `tables.get`, `jobs.query`, `jobs.getQueryResults` for the Ops Marts. |
| `startFakeAuditStore` | `auditStore.ts` | DynamoDB PutItem / Query over the portal GSIs and S3 PutObject. `setFailing(true)` makes every put fail. |
| `startPlatformDatabase` | `platform.ts` | A throwaway Postgres cluster with `engine_read` / `engine_write` roles and synthetic `widgets`. |
| `startRecorder` | `recorder.ts` | An HTTP receiver that answers 200 to everything (incident.io, webhooks, heartbeat). |
| `startFakeOkta` | `okta.ts` | A local OAuth issuer and JWKS that mints RS256 access tokens. |
| `startFakeLightdashApi` | `lightdashApi.ts` | The few Lightdash API endpoints the MCP-only checks need. |
| `startTelemetryMcp` | `telemetryMcp.ts` | The real MCP server, run in-process against the engine. |
| `startLightdash` | `lightdash.ts`, `lightdashServer.ts`, `lightdashDatabase.ts`, `s3.ts` | The real Lightdash backend in a child process. It has migrations, a seeded org, an admin with a PAT, a federation-flavour Operations Project and a fake S3 for results. It also offers `setUserAttributes`, `runAlertingCycle` and `createSqlChart`. |

`startLightdash` is a **full boot** (`mode: 'full-boot'`): `new App(...).start()` with no ee arguments.
The service-layer fallback that the harness spec allows was never needed. The scheduler worker is off.
`runAlertingCycle()` runs by hand what the worker would run once: the `alertingTick` task, every
`alertRuleEvaluate` job it enqueued, then the notification flush.

## What each check proves

There is one acceptance file per feature, `e2e/eng-1799/acceptance/<id>.test.ts`, listed here in
feature order. Kinds: **harness** (a fake or the engine harness works), **functional** (lines working
together end to end), **fix** (a cross-line conflict that was found and settled; see the next section),
and **docs**.

| # | Check | Kind | What it proves |
| --- | --- | --- | --- |
| 1 | `int-harness-engine` | harness | The harness runs the real Federation Engine binary from `tmp/cargo-target` on ephemeral ports, logs in over pg-wire and stops it without leftovers. |
| 2 | `int-harness-fake-prometheus` | harness | A fake Prometheus serves fixed synthetic series that the real engine's `promql()` and `promql_instant()` return. |
| 3 | `int-harness-platform-database` | harness | A throwaway Postgres in `tmp/` plays the Platform Database with engine read/write roles and synthetic widgets, and stops with the check. |
| 4 | `int-harness-audit-store` | harness | The fake DynamoDB + S3 audit store captures every Audited Query and can be made to fail, which the engine turns into 58000. |
| 5 | `int-harness-fake-loki` | harness | A fake Loki serves synthetic log streams and metric series to the engine's `logql()` and `logql_metric()`. |
| 6 | `int-harness-fake-tempo` | harness | A fake Tempo serves a synthetic trace to the engine's `traceql()` and `trace()`. |
| 7 | `int-harness-fake-cloudwatch` | harness | A fake CloudWatch speaking the SDK's GetMetricData protocol serves datapoints to the engine's `cloudwatch()`, with fake signed credentials only. |
| 8 | `int-harness-fake-cloudwatch-logs` | harness | A fake CloudWatch Logs Insights serves synthetic results to the engine's `cloudwatch_logs()`. |
| 9 | `int-harness-fake-bigquery` | harness | A fake BigQuery API serves synthetic Ops Mart tables that appear in the engine's `information_schema` and can be read. The check skips `table_schema = 'information_schema'`: the engine lists DataFusion's own views under every catalog, as Postgres does (amended 2026-11-09). |
| 10 | `int-client-connect` | functional | Lightdash's `FederationWarehouseClient` (federation flavour) connects to, tests and queries the real engine. |
| 11 | `int-client-catalog` | functional | The Lightdash catalog lists the engine's Ops Marts and their fields through `information_schema` only. The federation client maps the engine's Arrow type names (see "Open checks"). |
| 12 | `int-client-metric-functions` | functional | `promql()`, `promql_instant()`, `logql_metric()` and `cloudwatch()` work through the Lightdash client with `label()` and `series_name()`. |
| 13 | `int-client-log-trace-functions` | functional | `logql()`, `cloudwatch_logs()`, `traceql()` and `trace()` work through the Lightdash client, passing optional arguments. |
| 14 | `int-client-streaming` | functional | A 30000-row `promql()` result streams to Lightdash through cursors in several batches, every row once and in order. |
| 15 | `int-identity-backend-token` | functional | Identity tokens minted by the Lightdash backend are accepted by the engine, and the audit record carries their subject, email, description and ticket. |
| 16 | `int-identity-refused-tokens` | functional | Tampered, expired, wrongly signed and future-dated backend tokens are refused for Audited Queries, but ordinary telemetry still works. |
| 17 | `int-identity-claims-scope` | functional | The engine restricts a valid token to its claims, and a system identity is audited as an assertion. |
| 18 | `int-identity-agent-restricted` | functional | Restricted Telemetry is hidden from `agent = true`, while people with `telemetry_restricted` can read it, audited. |
| 19 | `int-client-platform-functions` | functional | With `FederationIdentityService`'s token provider, Lightdash's client runs `platform_query`/`tables`/`columns`/`explain` as the user, audited with the description. |
| 20 | `int-client-limits-and-errors` | functional | `statement_timeout`, `max_rows` (54000), access (42501) and audit (58000) failures reach Lightdash as `WarehouseQueryError`s, without leaking tokens. |
| 21 | `int-fix-cloudwatch-query-shape` | fix | Grafana CloudWatch targets, Investigate's CloudWatch form and the MCP's MetricDataQuery JSON all query CloudWatch through `cloudwatch()`. |
| 22 | `int-time-params-engine` | functional | Reserved time parameters resolved by the backend reach the engine as absolute, rounded values with the §2 `__interval` step. |
| 23 | `int-time-cache-key` | functional | The same relative range within a refresh bucket compiles to the same SQL and cache key, and asks the engine for the same window. |
| 24 | `int-fix-alert-time-params-agree` | fix | The alert evaluator's reserved time parameters equal ldq's for the same window (including durations of a week or more), and the engine accepts them. |
| 25 | `int-fix-alert-sql-parameters` | fix | Investigate/SQL Runner SQL with bare reserved parameters is a valid Alert Rule query: alerting substitutes exactly like Lightdash, and the examples follow suit. |
| 26 | `int-fix-write-confirmation-token` | fix | Write Mode confirmation tokens issued by the Lightdash backend are accepted by the engine, bound to statement, user and project. |
| 27 | `int-write-preview` | functional | A Write Mode Preview from Lightdash returns the `RETURNING` rows and rolls back. |
| 28 | `int-write-commit-once` | functional | A Write Mode commit from Lightdash applies once; a reused confirmation token gets 409. |
| 29 | `int-write-agent-commit-refused` | functional | An AI agent may Preview but never commit, in Lightdash and in the engine. |
| 30 | `int-write-audit-integrity` | functional | A Write Mode commit writes a portal-format audit item whose integrity hash matches the portal's algorithm, and an S3 body in portal key order. |
| 31 | `int-audit-browser` | functional | The Lightdash audit browser pages through the engine's audit store by ticket, user and month; without `platform_read` it is refused. |
| 32 | `int-fix-attr-truthiness` | fix | Lightdash and the MCP server derive the same claims from the same user attribute values. |
| 33 | `int-mcp-oauth-gate` | functional | The telemetry MCP server against the real engine is gated by a local OAuth JWKS and lists its 14 tools to mapped users. |
| 34 | `int-mcp-telemetry-tools` | functional | Every MCP telemetry tool answers from the real engine and the fake Telemetry Sources. |
| 35 | `int-mcp-platform-tools` | functional | MCP `platform_schema`, `platform_query` (audited as `ai_ask` with the caller's description) and `platform_explain` work against the real engine. |
| 36 | `int-mcp-restricted-hidden` | functional | Restricted Telemetry is never readable through MCP, even for users holding `telemetry_restricted`. |
| 37 | `int-fix-mcp-write-preview` | fix | The MCP `write_preview` tool's confirmation token is accepted by the engine; the Preview rolls back and there is no commit path. |
| 38 | `int-mcp-ask-data` | functional | `ask_data` answers from the Platform Database through audited engine queries, using example queries from the engine's audit browser. |
| 39 | `int-viz-engine-results` | functional | The Log stream and Trace waterfall chart types render real engine results from `logql()`, `cloudwatch_logs()` and `trace()`. |
| 40 | `int-lightdash-boot` | functional | The Lightdash backend boots locally (migrations on a throwaway Postgres) with a federation-flavour Operations Project on the real engine. |
| 41 | `int-fix-query-path-identity` | fix | SQL Runner queries through the async query path send the Lightdash user's identity token, so Audited Queries run and are audited as that user. |
| 42 | `int-lightdash-sql-chart` | functional | A saved SQL chart and a time-ranged SQL Runner query run through Lightdash's async query path against the engine. |
| 43 | `int-alert-promql-evaluates` | functional | An Alert Rule using `promql()` is evaluated by one scheduler cycle through the real engine, and the alerting state API shows it firing. |
| 44 | `int-fix-alert-evaluator-identity` | fix | The alert evaluator queries as `system:alert-evaluator` with the attrs from `ALERTING_EVALUATOR_ATTRS` and the rule description, audited as an assertion. |
| 45 | `int-alert-incident-io-lifecycle` | functional | Driving the fake Prometheus through firing and resolving sends Alertmanager v4 payloads to a fake incident.io and beats the heartbeat URL. |
| 46 | `int-alert-engine-down` | functional | With the engine down, an Alert Rule goes to error with a `DatasourceError` instance, history and notification. |
| 47 | `int-fix-mcp-real-lightdash` | fix | The MCP server maps users and reads alert state and history from the real Lightdash API, with rule filters honoured. |
| 48 | `int-assumptions-register` | docs | `contract-assumptions.md` lists every line's contract assumptions with a decision, and names the fix for each change. |
| 49 | `int-contracts-amended` | docs | `CONTRACTS.md` carries dated amendments for the readings the integration line settled. |
| 50 | `int-docs-integration` | docs | This document explains how to run the suite and what each check proves, and it links the reconciled assumptions. `run-all.sh` runs every check. |

### Open checks

Their sessions halted two checks on 2026-11-09. The whole-suite run that day (`run-all.sh`) gave
48 passed and 2 failed. Both have since been settled:

- `int-harness-fake-bigquery` (settled 2026-11-09, check amended): the engine's DataFusion lists its own
  `information_schema` views under every catalog, so `information_schema.tables WHERE table_catalog =
  'ops_marts'` gives 7 views plus the 2 Ops Mart tables. The decision was to keep that behaviour, which
  matches Postgres listing `information_schema` in `information_schema.tables`. The check now filters
  out `table_schema = 'information_schema'`, and it passes with no engine change.
- `int-client-catalog` (settled 2026-11-09, client fix): the engine's `information_schema.columns.data_type`
  is DataFusion's Arrow type name (`Timestamp(µs, "UTC")`, `Utf8`, `Int64`, `Float64`), which the Postgres
  type map read as `string`. CONTRACTS §1.1 names DataFusion's `information_schema` as the catalog, so the
  engine stays as it is. `FederationWarehouseClient` maps Arrow names (`mapFederationFieldType`; anything
  else falls back to the Postgres map) through the `mapCatalogFieldType` hook that `getFields` and
  `getCatalog` now call. Engine columns get no timestamp domain, so their catalogs have no
  `__lightdashTimestampDomains` sidecar.

## Reconciled assumptions

Where `CONTRACTS.md` was silent, each line recorded the narrowest compatible reading as a "Contract
assumption" in its `PROGRESS-<line>.md`. The integration line checked every one of them against the
other lines. The register is **[contract-assumptions.md](contract-assumptions.md)**. It has one row per
assumption, marked Kept, Changed or Superseded, with its evidence, and a summary table of the
cross-line conflicts with the winning side of each.

The conflicts that changed code, each pinned by its `int-fix-*` check above:

| Conflict | Settled as | Check |
| --- | --- | --- |
| Write Mode confirmation token encoding | The engine's encoding (`typ`, `statement_sha256`, `iat`, …). Lightdash and the MCP mint it. | `int-fix-write-confirmation-token`, `int-fix-mcp-write-preview` |
| `cloudwatch()` input shape | The engine accepts Grafana's stored target and the AWS MetricDataQuery. | `int-fix-cloudwatch-query-shape` |
| Reserved parameters in SQL | Lightdash's quoting. Alerting substitutes the same way, and the examples use bare parameters. | `int-fix-alert-sql-parameters` |
| Durations of a week or more | ldq's day-based formatter (`7d`), shared with alerting. | `int-fix-alert-time-params-agree` |
| Identity on Lightdash's query path | The federation client gets the user's token provider on the async query path. | `int-fix-query-path-identity` |
| Alert evaluator identity | `system:alert-evaluator`, attrs from `ALERTING_EVALUATOR_ATTRS`, audited as an assertion. | `int-fix-alert-evaluator-identity` |
| MCP alert tools vs the alerting API | The MCP maps its filters to `rule`/`since`, and `/state` accepts `?rule=`. | `int-fix-mcp-real-lightdash` |
| Attribute truthiness | True when any value is exactly `"true"` (ldq's reading). | `int-fix-attr-truthiness` |

The settled readings are written into `CONTRACTS.md` as dated amendments ("amended 2026-11-09").
