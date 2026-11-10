# ENG-1799 contract assumptions register

The parallel lines (engine, ldq, mcp, alerting, viz) built against `docs/eng-1799/CONTRACTS.md` only.
Where the contract was silent, each line took the narrowest compatible reading and recorded it under
"Contract assumptions" in its progress file (`PROGRESS-<line>.md`). This register lists every one of
them, plus the assumptions that were written only into a line's session log, and gives the integration
line's decision for each.

- **Numbered** ids (`engine-A1`, `ldq-1`, `mcp-1`, `alerting-1`, `viz-1`) follow the numbered list in
  that line's progress file.
- **Session-log** ids (`<line>-log-<n>`) are assumptions written into a line's feature log rather than
  its numbered list. The Source column names the feature entry. `integration-log-<n>` rows are
  assumptions the integration line itself made (see `PROGRESS.md`, session log).

Decisions:

- **Kept**: the reading stands as written. The integration checks run against it.
- **Changed**: the reading was wrong or conflicted with another line. The named `int-fix-*` feature
  changed the code; its acceptance check (`e2e/eng-1799/acceptance/<id>.test.ts`) pins the result.
- **Superseded**: a later decision replaced the reading without an integration code change. The row
  says which.

Cross-line conflicts (findings 1–9 in `PROGRESS.md`) were decided once, with the change on the losing
side:

| Conflict | Winner | Changed side | Fix |
| --- | --- | --- | --- |
| Write Mode confirmation token encoding | engine (engine-A6) | ldq-3, mcp-4 | int-fix-write-confirmation-token, int-fix-mcp-write-preview |
| `cloudwatch()` input shape | both shapes accepted | engine-A19 | int-fix-cloudwatch-query-shape |
| Reserved parameters in SQL | Lightdash quoting | alerting-log-1 | int-fix-alert-sql-parameters |
| Durations of a week or more | ldq (`7d`) | alerting-log-2 | int-fix-alert-time-params-agree |
| Identity on Lightdash's query path | ldq-2 provider, wired | ldq-2, ldq-log-8 | int-fix-query-path-identity |
| Alert evaluator identity | alerting-1 seam, wired | alerting-1, alerting-log-5 | int-fix-alert-evaluator-identity |
| MCP alert tools vs the alerting API | both meet in the middle | mcp-2, alerting-5 | int-fix-mcp-real-lightdash |
| Attribute truthiness | ldq (any value `"true"`) | mcp-log-1 | int-fix-attr-truthiness |

CONTRACTS.md amendments for the Changed rows belong to `int-contracts-amended`.

## engine (`PROGRESS-engine.md`, "Contract assumptions")

| ID | Line | Assumption | Decision | Source / evidence |
| --- | --- | --- | --- | --- |
| engine-A1 | engine | Cleartext, MD5 or SCRAM-SHA-256 login; a wrong user or password gets 28P01. | Kept: Lightdash's pg client and the MCP log in unchanged. | int-client-connect |
| engine-A2 | engine | Default TimeZone UTC, per-session `SET timezone`, unknown SETs and transaction statements accepted. | Kept: Lightdash's session setup runs unchanged. | int-client-connect, int-lightdash-boot |
| engine-A3 | engine | int4 is OID 23, zone-less timestamps are UTC, timestamptz prints like Postgres. | Kept: no client needed a different encoding. | int-client-metric-functions |
| engine-A4 | engine | A `$n::type` cast fixes that parameter's type; client-declared OIDs are honoured. | Kept: extended by integration-log-2 (bind parameters as table-function arguments). | int-mcp-telemetry-tools |
| engine-A5 | engine | `SET hrx.identity` always succeeds; token validity rules (v, exp, iat, lifetime, signature); 42501 names the missing claim; audited queries need a description; sys counts as agent false. | Kept: every Lightdash and MCP token passes. A blank email is refused, see integration-log-3. | int-identity-* checks |
| engine-A6 | engine | Confirmation token is b64url(payload).b64url(HMAC) with payload v, typ write_confirmation, statement_sha256, sub, project, iat, exp, nonce; exp minus iat at most 120 s; spent before execution. | Kept: the engine's encoding is canonical; Lightdash (ldq-3) and the MCP (mcp-4) changed to it. | int-write-preview, int-write-commit-once |
| engine-A7 | engine | `POST /v1/write` error body and status codes (400/401/403/409/422/500/503), returning at most 100 rows, body description and ticket audited. | Kept: Lightdash passes engine 4xx through unchanged (ldq-4). | int-write-commit-once, int-write-agent-commit-refused |
| engine-A8 | engine | `POST /v1/write/confirmations/verify` (test mode only) answers valid without spending the token. | Kept: used by the token checks only. | int-fix-write-confirmation-token |
| engine-A9 | engine | Guard rejections are 42501 with the portal's message; read mode for platform_query and platform_explain, write mode for /v1/write; rejected statements are not audited. | Kept: no client relies on another code. | int-client-platform-functions |
| engine-A10 | engine | Audit content: sql as received, database = source, one record per executed statement, action assertion for sys, ai_ask for agent or iss telemetry-mcp, query otherwise. | Kept: alert evaluation is audited as assertion and MCP calls as ai_ask. | int-fix-alert-evaluator-identity, int-mcp-platform-tools |
| engine-A11 | engine | Fail closed: a failed DynamoDB or S3 put fails the query with 58000 and no rows. | Kept: stricter than the portal, as §6 asks. | int-client-limits-and-errors |
| engine-A12 | engine | S3 key executions/createdAt/id.json, pretty JSON in portal key order, COMPLIANCE object lock. | Kept: matches the portal's layout. | int-write-audit-integrity |
| engine-A13 | engine | Integrity hash is HMAC under the env var named by integrity_key_env, else the portal's sha256 fallback. | Kept: hash matches the portal's algorithm. | int-write-audit-integrity |
| engine-A14 | engine | `GET /v1/audit` precedence ticket, user, month; pages of 25 newest first; portal cursors; no-parameter browse follows the portal's last 30 days. | Kept: the no-parameter browse was implemented as written (int-mcp-ask-data, integration-log-4). | int-audit-browser, int-mcp-ask-data |
| engine-A15 | engine | A Loki selector is open only when provably disjoint from every restricted selector; anything else touches it. | Kept: fails closed through the MCP too. | int-mcp-restricted-hidden |
| engine-A16 | engine | Restricted log groups are comma-separated, trimmed and compared exactly. | Kept: no line reads them differently. | PROGRESS-engine.md |
| engine-A17 | engine | PromQL result shapes: series name with sorted labels, scalar and string shapes, NaN and Inf kept. | Kept: Lightdash and the MCP render them as is. | int-client-metric-functions |
| engine-A18 | engine | Tempo span_count, lowercase hex ids, status values, flat attributes, unknown trace gives zero rows, default limit 20. | Kept: the viz trace waterfall reads these columns. | int-client-log-trace-functions, int-viz-engine-results |
| engine-A19 | engine | cloudwatch() reads only Grafana's stored target model (namespace, metricName, dimensions, statistic, period). | Changed: the engine also reads the AWS MetricDataQuery shape that Investigate and the MCP send (int-fix-cloudwatch-query-shape). | int-fix-cloudwatch-query-shape |
| engine-A20 | engine | Logs Insights: timestamp from @timestamp, message from @message, fields without @ptr; StopQuery on timeout. | Kept: the log stream renders these columns. | int-client-log-trace-functions |
| engine-A21 | engine | Ops Marts exposed as ops_marts.dataset.table with a fixed BigQuery type map; login only, not audited; token cached. | Kept: the MCP's list_sources reads them from information_schema. | int-mcp-telemetry-tools |
| engine-A22 | engine | Time arguments accept ISO-8601 with offsets, timestamptz or naive UTC; step must be positive; invalid arguments fail before any source request. | Kept: Lightdash's reserved parameters and the MCP's resolved times both fit. | int-time-params-engine |
| engine-A23 | engine | max_rows counts the rows one table-function call produces, regardless of SQL on top. | Kept: promql windowing stops at max_rows (integration-log-1). | int-client-limits-and-errors |
| engine-A24 | engine | Prometheus metric names federation_engine_queries_total, query_duration_seconds, query_errors_total, audit_write_failures_total. | Kept: no consumer in this program depends on others. | PROGRESS-engine.md |
| engine-A25 | engine | Config extensions as listed in the engine's config table. | Kept: the e2e harness renders exactly that config. | int-harness-engine |
| engine-A26 | engine | Logs are one JSON object per line and never hold result values, tokens, emails, descriptions or secrets. | Kept: no line asked for more. | PROGRESS-engine.md |
| engine-A27 | engine | `/healthz` lists each source with its health; 200 when all reachable, else 503. | Kept: the harness waits on it. | int-harness-engine |
| engine-A28 | engine | SIGTERM stops accepting, drains in-flight queries and exits 0. | Kept: the harness stops the engine this way. | int-harness-engine |
| engine-A29 | engine | An agent holding platform_read may run platform_query, audited as ai_ask; agents may Preview but never commit. | Kept: the MCP has no commit tool. | int-write-agent-commit-refused, int-mcp-platform-tools |
| engine-A30 | engine | platform_tables lists user schemas only; platform_columns ordinal order; platform_explain needs platform_read or platform_explain plus a description and goes through the read guard. | Kept: the MCP and the schema browser use them as is. | int-client-platform-functions |

## ldq (`PROGRESS-ldq.md`, "Contract assumptions")

| ID | Line | Assumption | Decision | Source / evidence |
| --- | --- | --- | --- | --- |
| ldq-1 | ldq | Identity token: audit always present with nulls, sys defaults false, lifetime 300 s, an attribute is true when any value is exactly "true". | Kept: the MCP adopted this truthiness (mcp-log-1). | int-identity-backend-token, int-fix-attr-truthiness |
| ldq-2 | ldq | The token reaches the client through `getIdentityToken({agent})`; without a provider a federation client sends no SET hrx.identity. | Changed: the provider is now wired for every federation client and may return null, which sends RESET hrx.identity (int-fix-query-path-identity). | int-fix-query-path-identity |
| ldq-3 | ldq | Confirmation token payload v, statement_sha256, sub, project, exp, nonce (no typ, no iat), exp at most 120 s ahead. | Changed: Lightdash now adds typ write_confirmation and iat, the engine's encoding (int-fix-write-confirmation-token). | int-fix-write-confirmation-token |
| ldq-4 | ldq | The engine write request sends ticket null when none is given; engine 4xx statuses go to the browser unchanged. | Kept: 409 and 403 reach the caller as is. | int-write-commit-once |
| ldq-5 | ldq | `__from`/`__to` are Date#toISOString() with milliseconds; `__range` uses compound units largest first. | Kept: alerting now uses the same formatter. | int-time-params-engine, int-fix-alert-time-params-agree |
| ldq-6 | ldq | Restricted Telemetry is enforced only by the engine; Investigate asks for a description when the engine requires one; schema browser calls send a description. | Kept: the MCP takes the same stance (mcp-log-3). | int-identity-agent-restricted |
| ldq-7 | ldq | Explain-only scope applies to the Platform Database only; Explain also needs a description. | Kept: matches engine-A30. | int-client-platform-functions |
| ldq-8 | ldq | CloudWatch metric queries use AWS's MetricDataQuery JSON shape with default Id m1. | Kept: the engine now reads this shape (engine-A19). | int-fix-cloudwatch-query-shape |
| ldq-9 | ldq | The audit browser passes the engine's Execution items through unchanged. | Kept: pages through the real engine store. | int-audit-browser |
| ldq-10 | ldq | The portal saved-scripts export is a JSON array of SavedScript. | Kept: no other line reads it. | PROGRESS-ldq.md |
| ldq-11 | ldq | Investigate's Save as chart saves to the first space the user can create charts in, as a TABLE SQL chart. | Kept: the spec names no space picker. | int-lightdash-sql-chart |
| ldq-12 | ldq | The audit browser's identity token uses audit source investigate with no description or ticket. | Kept: listing the store is not an Audited Query; only platform_read is needed. | int-audit-browser |

### ldq session log

| ID | Line | Assumption | Decision | Source / evidence |
| --- | --- | --- | --- | --- |
| ldq-log-1 | ldq | Write confirmation payload keys follow the acceptance test, with no iat; Lightdash keeps no nonce record (single use is the engine's job). | Changed: iat and typ added (int-fix-write-confirmation-token); single use stays in the engine. | ldq-write-confirmation-route |
| ldq-log-2 | ldq | An empty audit description is not rejected at mint time; only Audited Queries need one and the engine refuses them. | Kept: tile and alert tokens rely on it. | ldq-identity-token-audit-block |
| ldq-log-3 | ldq | formatPrometheusDuration uses d/h/m/s only, no weeks or years (now-7d gives 7d); past 1d, __interval rounds up to whole days. | Kept: alerting adopted it (int-fix-alert-time-params-agree). | ldq-time-interval-parameter |
| ldq-log-4 | ldq | Absolute time inputs must be full date-times with an explicit offset; offset-less or impossible dates are refused. | Kept: no caller sends anything else. | ldq-time-absolute-range |
| ldq-log-5 | ldq | The dbt refusal on federation connections applies only where a dbt target is built, so MANIFEST and DBT_CLOUD_IDE projects are not refused. | Kept: left for the owners to tighten if wanted. | ldq-federation-project-types |
| ldq-log-6 | ldq | Schema browser catalog reads carry fixed audit descriptions and no ticket; the user is not asked for one. | Kept: the engine audits them as written. | ldq-platform-schema-browser |
| ldq-log-7 | ldq | An explicit agentSession false inside an agent context gives agent false (the explicit flag wins). | Kept: WarehouseClientFactory passes its computed flag. | ldq-identity-token-agent |
| ldq-log-8 | ldq | A federation client created without getIdentityToken sends no identity; nothing in the backend wires the provider yet. | Changed: the query path now builds a scoped provider for every federation client (int-fix-query-path-identity). | ldq-federation-identity-set |

## mcp (`PROGRESS-mcp.md`, "Contract assumptions")

| ID | Line | Assumption | Decision | Source / evidence |
| --- | --- | --- | --- | --- |
| mcp-1 | mcp | User lookup through `/api/v1/org/users` and `/api/v1/org/attributes` with a service-account PAT (ApiKey); group values count only for members. | Kept: proven against the real Lightdash API. | int-fix-mcp-real-lightdash |
| mcp-2 | mcp | Alerting API state and history under `/api/v2/projects/{uuid}/alerting` with optional ruleUuid, from, to, limit; results passed through. | Changed: the MCP now sends rule, since, until and limit, which the alerting API reads (int-fix-mcp-real-lightdash). | int-fix-mcp-real-lightdash |
| mcp-3 | mcp | MCP identity tokens live 60 s, one per call; audit block always present. | Kept: within the 300 s contract maximum. | int-mcp-telemetry-tools |
| mcp-4 | mcp | The MCP mints its own Preview confirmation token with stmt_sha256 and no typ or iat. | Changed: it now mints the engine's encoding with typ, statement_sha256 and iat (int-fix-mcp-write-preview). | int-fix-mcp-write-preview |
| mcp-5 | mcp | MCP_SOURCES mirrors the non-secret engine config; Ops Marts come from information_schema.tables. | Kept: the harness sets MCP_SOURCES from the rendered engine config. | int-mcp-oauth-gate, int-mcp-telemetry-tools |
| mcp-6 | mcp | platform_schema and platform_explain send a generated description when the caller gives none. | Kept: the engine audits them. | int-mcp-platform-tools |
| mcp-7 | mcp | ask_data reads the catalog through platform_tables/platform_columns and examples through `GET /v1/audit`; join and row-count hints degrade. | Kept: works end to end. | int-mcp-ask-data |
| mcp-8 | mcp | Time arguments accept ISO-8601 or now and now-N units, resolved to absolute ISO before SQL is built. | Kept: the engine accepts the resolved values (engine-A22). | int-mcp-telemetry-tools |
| mcp-9 | mcp | Example-query paging sends no filters and follows nextCursor from the engine's default listing, at most 5 pages, skipping records older than 90 days. | Kept: the engine's no-parameter browse now exists (integration-log-4). | int-mcp-ask-data |
| mcp-10 | mcp | ask_data: the engine writes the audit record; 58000 fails the ask; catalog failures are 502; no comments, FKs or row estimates through §1.1. | Kept: records are platform_query-wrapped and unwrapped for examples. | int-mcp-ask-data |

### mcp session log

| ID | Line | Assumption | Decision | Source / evidence |
| --- | --- | --- | --- | --- |
| mcp-log-1 | mcp | An attribute is true only when the resolved value set is exactly {"true"} (least privilege). | Changed: true when any value is exactly "true", ldq's reading (int-fix-attr-truthiness). | mcp-user-attributes |
| mcp-log-2 | mcp | alert_history limit is 1..1000 and a missing limit is left to the Lightdash default. | Kept: matches the alerting API's limit range (alerting-log-3). | mcp-tool-alert-history |
| mcp-log-3 | mcp | The MCP adds no local block for restricted sources; the engine is the single gate and the MCP sends agent true. | Kept: Restricted Telemetry is never readable through MCP. | mcp-restricted-telemetry |
| mcp-log-4 | mcp | The MCP never sets resource_uuid, and attr flags are coerced with strict equality to true. | Kept: no tile or rule stands behind an MCP call. | mcp-identity-token |
| mcp-log-5 | mcp | Linear tickets are checked for shape only; whether the issue exists is left to the integration line or the engine. | Kept: no Linear credential exists in this program. | mcp-tool-platform-query |
| mcp-log-6 | mcp | Structured log field names are the MCP's own; the user field is the Okta sub, not the email. | Kept: no ops requirement asks for the email. | mcp-structured-logs |
| mcp-log-7 | mcp | logql limit and direction are positional; gaps are filled with the contract defaults 1000 and backward. | Kept: limit is cast to int for the engine (int-mcp-telemetry-tools). | mcp-tool-query-logql |

## alerting (`PROGRESS-alerting.md`, "Contract assumptions")

| ID | Line | Assumption | Decision | Source / evidence |
| --- | --- | --- | --- | --- |
| alerting-1 | alerting | Evaluator identity seam: an AlertRuleQueryContext goes to getWarehouseClient and the federation client is expected to mint system:alert-evaluator from it. | Changed: the context is now used to mint the system identity, attrs from ALERTING_EVALUATOR_ATTRS (int-fix-alert-evaluator-identity). | int-fix-alert-evaluator-identity |
| alerting-2 | alerting | Alert Rules run in any project the user can manage; SQL passes through unchanged apart from reserved parameters. | Kept: rules run on the Operations Project in the checks. | int-alert-promql-evaluates |
| alerting-3 | alerting | secretRef names resolve through secrets.resolve; production adapter reads ALERTING_SECRET_NAME in upper snake case. | Kept: the incident.io bearer comes from it. | int-alert-incident-io-lifecycle |
| alerting-4 | alerting | Heartbeat config from ALERTING_HEARTBEAT_URL and ALERTING_HEARTBEAT_METHOD (GET or POST, default POST). | Kept: the heartbeat URL is beaten every cycle. | int-alert-incident-io-lifecycle |
| alerting-5 | alerting | The alerting HTTP API is a plain express router; the MCP consumes state and history with the shapes as built. | Changed: state takes rule, history takes until, so the MCP's filters work (int-fix-mcp-real-lightdash). | int-fix-mcp-real-lightdash |
| alerting-6 | alerting | Grafana's $values.ref in ported annotations maps to $value (one query, one reducer per rule). | Kept: annotation templating uses the numeric $value. | alert-annotation-templates |
| alerting-7 | alerting | ADR 0003 routing bugs (team=Support, unlabelled team=engineering, slack-sec) are fixed in the as-code tree during migration. | Superseded: alerting-log-4, the later port left them unfixed pending the owners' decision on target channels. | alert-grafana-port-examples |
| alerting-8 | alerting | An Alert Rule's space is optional as code; a missing spaceSlug means no space. | Kept: needed for UI rules with no space. | alert-as-code-download |

### alerting session log

| ID | Line | Assumption | Decision | Source / evidence |
| --- | --- | --- | --- | --- |
| alerting-log-1 | alerting | Reserved parameter values are inserted verbatim and the SQL supplies the quotes (examples quote the references). | Changed: values are now written as SQL literals, as Lightdash does; quoted legacy references still work (int-fix-alert-sql-parameters). | alert-eval-query-identity |
| alerting-log-2 | alerting | `__range` uses alerting's own duration formatter, so 7 days formats as 1w. | Changed: alerting re-exports ldq's formatter, so 7 days is 7d (int-fix-alert-time-params-agree). | alert-durations, alert-eval-query-identity |
| alerting-log-3 | alerting | alert_history takes limit (default 100, max 1000) and since must be a full date-time. | Changed: history also takes until, at or before (int-fix-mcp-real-lightdash). | alert-ai-history-api |
| alerting-log-4 | alerting | ADR 0003's routing-bug fixes are not applied in the ported tree; unmatched labels keep today's routes. | Kept: target channels are a human decision; listed as a follow-up for the owners. | alert-grafana-port-examples |
| alerting-log-5 | alerting | The evaluator queries with the project's shared credentials as a person-less actor; the context is not passed to the factory yet. | Changed: queries now run inside a system identity scope (int-fix-alert-evaluator-identity). | alert-worker-wiring |
| alerting-log-6 | alerting | Test rule preview runs as system:alert-evaluator with the body's description and a fresh random uuid as resource_uuid. | Kept: the preview goes through the same identity scope as evaluation. | alert-rule-preview |
| alerting-log-7 | alerting | The incident.io body is exactly the generic Alertmanager webhook v4 payload, URL taken as is. | Kept: a fake incident.io received v4 firing and resolved payloads. | int-alert-incident-io-lifecycle |
| alerting-log-8 | alerting | A cycle is one scheduler tick; non-2xx heartbeat answers are recorded but not retried. | Kept: the lifecycle check drives cycles this way. | alert-cycle-heartbeat |

## viz (`PROGRESS-viz.md`, "Contract assumptions")

| ID | Line | Assumption | Decision | Source / evidence |
| --- | --- | --- | --- | --- |
| viz-1 | viz | Log stream and trace waterfall are native chart types; no ee file breaks once ChartAsCodeConfig includes them. | Kept: measured by the viz line; no ee change. | PROGRESS-viz.md (measurement) |
| viz-2 | viz | With no level column, the level comes from label level, then detected_level, then unknown. | Kept: a severity label is deliberately not read. | int-viz-engine-results |
| viz-3 | viz | labels and attributes arrive as objects or JSON text; start and timestamp as Date or ISO strings. | Kept: the engine's json columns render. | int-viz-engine-results |
| viz-4 | viz | When results hold several traces, the first in row order is shown, with a Trace picker. | Kept: no line sends several traces by design. | int-viz-engine-results |
| viz-5 | viz | The log stream's CSV export is client-side over loaded lines; full exports keep the backend CSV path. | Kept: no other line depends on it. | PROGRESS-viz.md |
| viz-6 | viz | Registry thresholds and valueMappings take Grafana's JSON shapes as text; index-next.json lists the same charts. | Kept: lets the importer copy them. | PROGRESS-viz.md |
| viz-7 | viz | Grafana's auto-scaled bytes and Bps map to the bytes_iec and bytes_si families only; listed as a gap. | Kept: documented in grafana-panel-mapping.md. | docs/eng-1799/grafana-panel-mapping.md |

## integration (`PROGRESS.md`, session log)

| ID | Line | Assumption | Decision | Source / evidence |
| --- | --- | --- | --- | --- |
| integration-log-1 | integration | promql() splits a range longer than 11,000 steps into aligned windows and merges them, stopping at max_rows. | Kept: one row per sample as §1.1 promises; logql_metric does not split yet. | int-client-streaming |
| integration-log-2 | integration | A `$n` inside a table function's arguments is bound as a literal at Bind; `json` casts plan as text marked JSON. | Kept: the MCP's bind-parameter rule and the engine's planning both hold. | int-mcp-telemetry-tools |
| integration-log-3 | integration | The alert evaluator's token email is the subject system:alert-evaluator, since the engine refuses a blank email. | Kept: no address is invented; for the §4.3 amendment. | int-fix-alert-evaluator-identity |
| integration-log-4 | integration | The engine's no-parameter audit browse covers the last 30 days from the request, walking month partitions. | Kept: no from or to parameters. | int-mcp-ask-data |
| integration-log-5 | integration | The MCP alert tools also send ruleUuid, from and to, which Lightdash ignores, because the MCP line's protected check pins them. | Kept: drop them once that check may change. | int-fix-mcp-real-lightdash |
