# ENG-1799 interface contracts

These are the seams between the parts of ENG-1799 that are built in parallel. Each part is built by its own factory line, on its own branch:

| Part | Where |
|---|---|
| Federation Engine | `federation-engine/` |
| Lightdash query and access changes | `packages/{common,backend,frontend,warehouses}` |
| Lightdash alerting | `packages/{common,backend,frontend,cli}` |
| Telemetry MCP server | `packages/telemetry-mcp/` |
| Tiles and importers | `packages/{common,frontend,cli}` |

Read this file together with `CONTEXT.md` (the glossary) and `docs/adr/0001`–`0004` (the decisions).

**When a contract is not enough.** Each part builds against this file, not against another part's code. If a contract doesn't answer something you need, choose the narrowest reading that stays compatible. Record it in your line's progress file under "Contract assumptions", so the integration line can reconcile it.

Authority: Joseph Fahnestock confirmed the design on 2026-11-08. The controls engineer (Claude) fixed these contracts on 2026-11-08 under Joseph's standing instruction to implement the full scope unattended.

## 1. Federation Engine: SQL over the Postgres wire protocol

- **Protocol.** Postgres wire protocol v3, with both the simple and the extended query protocol. Extended means Parse, Bind, Execute with `max_rows` portal fetches, and Describe. Default port `5433`.
- **Login.** User and password come from the engine config (one credential per Lightdash project connection). TLS is optional, and is terminated by the engine when a certificate is configured.
- **`version()`** returns `PostgreSQL 16.0 (hrx-federation-engine <crate version>)`. Lightdash parses `PostgreSQL (\d+)\.`.
- **Session `SET`s.**
  - Accepted: `SET statement_timeout = <ms>`, `SET timezone TO '<tz>'`, `SET lightdash.agent = 'true'`, and `SET hrx.identity = '<identity token>'` (§3).
  - Unknown `SET`s are accepted and ignored.
  - `SELECT current_setting('TIMEZONE')` works.
- **Catalog.** DataFusion's `information_schema.tables` and `information_schema.columns` are exposed. Nothing else from `pg_catalog` is guaranteed. Lightdash's client therefore never queries `pg_*` (§4.1).
- **Types.** Correct built-in OIDs for every column:

  | Type | OID |
  |---|---|
  | `timestamptz` | 1184 |
  | `float8` | 701 |
  | `int8` | 20 |
  | `text` | 25 |
  | `bool` | 16 |
  | `json` | 114 |

  Label maps and attribute maps are sent as `json` text.
- **Cancellation.** Honour `statement_timeout`. A cancel request, or the client disconnecting, stops the in-flight work against the source.

### 1.1 Table functions: the only way telemetry is read

Every time argument is `timestamptz` or an ISO-8601 string. `step` and `period` are Prometheus duration strings (`30s`, `5m`, `1h`). `source` names an entry in the engine config. Its default comes from the config's `default_source` for that kind.

| Function | Returns (columns, in order) |
|---|---|
| `promql(query, start, end, step[, source])` | `timestamp timestamptz, value float8, labels json, series text` |
| `promql_instant(query, at[, source])` | same as `promql` |
| `logql(query, start, end[, limit int = 1000, direction text = 'backward', source])` | `timestamp timestamptz, line text, labels json, stream text` |
| `logql_metric(query, start, end, step[, source])` | same as `promql` |
| `cloudwatch(metric_data_query json, start, end[, source])` | same as `promql`. `metric_data_query` is the CloudWatch `MetricDataQuery` shape that Grafana's CloudWatch datasource stores (metric stat or expression); `series` is the query label. |
| `cloudwatch_logs(log_groups text, query text, start, end[, source])` | `timestamp timestamptz, message text, fields json`. `log_groups` is comma-separated; `query` is Logs Insights. |
| `traceql(query, start, end[, limit int = 20, source])` | `trace_id text, root_service text, root_name text, start timestamptz, duration_ms float8, span_count int8` |
| `trace(trace_id[, source])` | `trace_id text, span_id text, parent_span_id text, service text, name text, start timestamptz, duration_ms float8, status text, attributes json` |
| `platform_query(sql)` | Whatever columns the Platform Database returns for `sql`. The schema is found by a describe-only round trip at plan time. The read-only role and the guard (§5) apply. |
| `platform_explain(sql)` | `plan json`. Estimate-only `EXPLAIN (FORMAT JSON)`, never `ANALYZE`. |
| `platform_tables()` | `table_schema text, table_name text` |
| `platform_columns(table_schema, table_name)` | `column_name text, data_type text, is_nullable bool` |

Scalar helpers:
- `label(labels json, key text) -> text`: one label's value, or NULL.
- `series_name(labels json) -> text`: canonical `{k="v",...}`, with keys sorted.

**`cloudwatch()` query shapes (amended 2026-11-09, int-fix-cloudwatch-query-shape).** "The `MetricDataQuery` shape that Grafana's CloudWatch datasource stores" was read two ways. The engine accepts both shapes:

- **Grafana's stored target** (camelCase keys). Builder mode (`metricEditorMode = 0`, no `expression`) becomes a `MetricStat` from `namespace`, `metricName`, `dimensions`, `statistic` and `period`. Code mode (`metricEditorMode = 1`, or a non-empty `expression`) sends the `expression` whole as the `Expression`, with the `period`. A non-empty `label` is the `series` of every row. Metrics Insights targets (`metricQueryType = 1`) are refused with `0A000`.
- **The AWS `MetricDataQuery`** (PascalCase keys), which Investigate's CloudWatch form and the MCP `query_cloudwatch` tool send. An object with any of `Id`, `MetricStat` or `Expression` is read as this shape: `MetricStat{Metric{Namespace, MetricName, Dimensions: [{Name, Value}]}, Period, Stat, Unit?}`, or `Expression` with an optional `Period`, plus `Label`. Having both or neither of `MetricStat` and `Expression`, a `MetricStat` without `Period`, or `ReturnData: false` fails with `22023`. `AccountId` fails with `0A000`.

The two shapes of one metric reach CloudWatch as the same `MetricStat`.

BigQuery Ops Marts appear as ordinary tables in the catalog `ops_marts`, one per allowlisted table in the config (`ops_marts.<dataset>.<table>`). Nothing outside the allowlist is visible.

Results are capped by `max_rows` in the source config (default 100000). Hitting the cap is an error, not silent truncation: SQLSTATE `54000`, "result exceeds max_rows".

### 1.2 Access enforcement (in the engine, never only in the UI)

| What is read | Needs | Notes |
|---|---|---|
| Ordinary telemetry (sources without `restricted`) | a valid login | |
| Restricted Telemetry: a source with `restricted = true`, or a `logql`/`cloudwatch_logs` query that touches a stream selector or log group listed in the source's `restricted_selectors`/`restricted_log_groups` | a valid identity token with `attrs.telemetry_restricted = true` and `agent = false` | Audited Query (§6) |
| `platform_query`, `platform_tables`, `platform_columns` | `attrs.platform_read = true` | Audited Query (§6) |
| `platform_explain` | `attrs.platform_read` or `attrs.platform_explain` | Audited Query (§6) |
| Ops Marts | a valid login | |

- **Failures** return SQLSTATE `42501` with a message naming the missing claim. A missing or invalid token counts as no claims.
- **Audited Queries** also need `audit.description`, a non-empty string. Without it they fail with SQLSTATE `42501` and "audited query requires a description".
- **The system identity** (`sys = true`) counts as `agent = false`. It needs the same attrs as a person: the alert evaluator's system identity is configured with the attrs its rules need.

### 1.3 HTTP side port (default `8088`)

Every request carries `Authorization: Bearer <identity token>` (§3).

| Method and path | Purpose |
|---|---|
| `GET /healthz` | 200 when every configured source is reachable. Otherwise 503, with the body listing unhealthy sources. No auth. |
| `GET /metrics` | Prometheus exposition: query counts, latency histograms per source, errors, audit write failures. No auth. |
| `POST /v1/write` | Write Mode (§5). |
| `GET /v1/audit?ticket=&user=&month=YYYY-MM&cursor=` | Audit browser (§6). Needs `attrs.platform_read`. Returns `{items: Execution[], nextCursor}`. |
| `POST /v1/write/confirmations/verify` | Test-only endpoint, disabled unless `test_mode = true`. |

### 1.4 Config (`federation-engine.toml`)

```toml
listen_pg = "0.0.0.0:5433"
listen_http = "0.0.0.0:8088"
identity_secret_env = "HRX_IDENTITY_SECRET"   # HMAC key shared with Lightdash and the MCP server
max_rows = 100000

[[users]]                                      # pg-wire logins
name = "lightdash-operations"
password_env = "HRX_PG_PASSWORD_OPERATIONS"

[[sources]]
name = "prometheus-production"
kind = "prometheus"                            # prometheus | loki | cloudwatch | cloudwatch_logs | tempo | platform_postgres | bigquery
url = "https://prometheus.houserx.io"
default = true
restricted = false

[[sources]]
name = "loki-production"
kind = "loki"
url = "https://loki.houserx.io"
restricted_selectors = ['{namespace="platform"}']

[[sources]]
name = "cloudwatch-production"
kind = "cloudwatch"
region = "us-east-2"
role_arn = "arn:aws:iam::032656505151:role/..."   # assumed via the pod's IRSA identity

[[sources]]
name = "platform"
kind = "platform_postgres"
read_url_env = "HRX_PLATFORM_READ_URL"
write_url_env = "HRX_PLATFORM_WRITE_URL"       # unset means Write Mode is off

[[sources]]
name = "ops-marts"
kind = "bigquery"
project = "hrx-prod-de-dataplatform"
allow = ["ops_marts.fills_hourly", "ops_marts.queue_depth"]

[audit]
dynamodb_table = "db-query-portal-executions"
s3_bucket = "db-query-portal-audit"
integrity_key_env = "AUDIT_INTEGRITY_KEY"
```

## 2. Dashboard Time Range parameters

The Dashboard Time Range and Investigate resolve to absolute values **before** a query is compiled or its cache key is computed. These reserved Lightdash parameters carry them:

| Parameter | Value |
|---|---|
| `ld.parameters.__from` | ISO-8601 UTC timestamp |
| `ld.parameters.__to` | ISO-8601 UTC timestamp |
| `ld.parameters.__interval` | Prometheus duration string: (to − from) / max data points (default 1000), rounded up to a nice step (1s, 5s, 15s, 30s, 1m, 5m, 15m, 30m, 1h, 3h, 6h, 12h, 1d), floor 15s |
| `ld.parameters.__range` | duration string for (to − from) |

**Quoting in SQL (amended 2026-11-09, int-fix-alert-sql-parameters).** SQL references the parameters bare, as in `${ld.parameters.__from}` (or `${lightdash.parameters.__from}`, with no whitespace inside the braces). The substitution writes each value as a single-quoted SQL string literal, with any `'` doubled. Alert Rule queries follow Lightdash's convention and get exactly the SQL Lightdash would compile, so a query saved from Investigate works as an Alert Rule query. For compatibility, the alert evaluator also accepts a legacy reference that is already in quotes (`'${ld.parameters.__from}'`): the reference and its quotes become one literal. Lightdash would write invalid SQL for that form, so alerting and Lightdash differ only on SQL that Lightdash cannot run. `__range` and `__interval` come from one formatter in both, so 7 days is `7d` (int-fix-alert-time-params-agree).

Relative ranges (`now-6h`) are resolved to absolute timestamps rounded down to the dashboard's refresh interval, or to 10s when there is none. Cache keys therefore change exactly when the data should.

## 3. Identity token (Lightdash → engine, MCP → engine)

`<base64url(payload_json)>.<base64url(HMAC-SHA256(secret, base64url(payload_json)))>`

Encoding uses base64url without padding. The engine rejects a token whose `exp` has passed, whose `iat` is more than 60 s in the future, whose `v` isn't 1, or whose signature doesn't match.

```json
{"v": 1, "iss": "lightdash" | "telemetry-mcp", "sub": "<lightdash user uuid or system:alert-evaluator>",
 "email": "a@houserx.com", "org": "<org uuid>", "project": "<project uuid>",
 "agent": false, "sys": false,
 "attrs": {"telemetry_restricted": false, "platform_read": false, "platform_write": false, "platform_explain": false},
 "audit": {"description": "why", "ticket": "ENG-123", "source": "investigate|tile|alert_rule|mcp|write_mode",
           "resource_uuid": "<tile/rule uuid or null>"},
 "iat": 1767225600, "exp": 1767225900, "nonce": "<16 random bytes, base64url>"}
```

- **Lifetime:** at most 300 s (`exp − iat`).
- **On the pg path:** Lightdash sends `SET hrx.identity = '<token>'` immediately before each query on the connection that runs it.
- **Where `attrs` come from:** Lightdash user attributes with the same names, managed through groups. The value `"true"` is true; anything else is false.

**Amended 2026-11-09 (int-fix-attr-truthiness, int-fix-query-path-identity).**
- **Several values.** A user can hold several values for one attribute, directly and through groups. The claim is true when any of them is exactly `"true"`. `"TRUE"`, `" true"` and `"yes"` are false. Lightdash and the MCP server derive the same claims from the same values.
- **No identity.** When a federation-flavour query runs with no identity in scope, Lightdash sends `RESET hrx.identity` instead of the `SET`. The engine keeps the setting for the life of a pooled connection, so a query with no identity must not inherit the previous user's identity.

## 4. Lightdash

### 4.1 Warehouse type: a flavour of Postgres (amended 2026-11-08)

The Federation Engine is **not** a new `WarehouseTypes` member. It is the Postgres warehouse type with a flavour.

- **Why.** Adding `WarehouseTypes.FEDERATION` makes two files under `packages/backend/src/ee/` fail typecheck: `ai/prompts/systemV2RunSql.ts` has a `Record<WarehouseTypes, string>`, and `AiWritebackService/skills.ts` has an `assertUnreachable`. Q14 forbids changing `ee/`. The flavour approach also removes about 137 type switches from the fork's rebase surface. The controls engineer decided this on 2026-11-08, from the ldq init session's measurement.
- **Credentials.** `CreatePostgresCredentials` gains three optional fields:
  - `flavor?: 'postgres' | 'federation'` (absent means `'postgres'`);
  - `identitySigningSecret?: string`, which is sensitive and stripped like `password` everywhere credentials are returned;
  - `httpBaseUrl?: string`, the engine's §1.3 base URL.

  When `flavor === 'federation'`, the defaults are port 5433 and `dbname` `operations`.
- **Client.** `warehouseClientFromCredentials` returns `FederationWarehouseClient` (extends `PostgresWarehouseClient`) when `flavor === 'federation'`. The SQL builder, the dialect and every `WarehouseTypes` switch stay Postgres's.
- **`FederationWarehouseClient`:**
  - `getAllTables`, `getFields` and `getCatalog` use `information_schema` only;
  - it sends the `SET hrx.identity` described in §3;
  - `version()` gating that queries `pg_matviews` is turned off.
- **"Federation project".** Wherever this document or the ADRs say a "federation project" or "the federation warehouse type", read it as a project whose warehouse credentials have `flavor: 'federation'`.
- **Connection form.** The Postgres connection form gains a "Federation Engine" flavour switch that shows the extra fields.
- **Project types.** It works with the `none` and native-git (`semanticLayer: 'lightdash'`) project types. dbt with a federation-flavour connection fails with a clear "dbt is not supported for the Federation Engine" error at the point where the dbt target is built.

### 4.2 Write Mode and Preview (never through `AsyncQueryService`)

- **Routes.**
  - `POST /api/v2/projects/{projectUuid}/write/confirmations` takes `{statement}` and returns `{confirmationToken, expiresAt}`. The token is an HMAC over (sha256(statement), user uuid, project uuid, exp ≤ 120 s, nonce) under the identity secret. Its encoding is fixed in the note below.
  - `POST /api/v2/projects/{projectUuid}/write` takes `{statement, mode: "preview"|"commit", confirmationToken, description, ticket?}`. It forwards to the engine's `POST /v1/write` with a fresh identity token and returns the engine's result.
- **Who may call.** It requires the user attribute `platform_write`. A request from an AI agent context (`agent = true`) may only use `mode = "preview"`. The engine enforces this too.
- **Engine `POST /v1/write`:**
  - Request: `{statement, mode, confirmation_token, description, ticket}`.
  - Response: `{audit_id, rows_affected, preview: bool, returning: [...] | null}`.
  - Steps:
    1. Run the guard (§5).
    2. Verify the confirmation token: single use, bound to statement, user, project and expiry. Reject a reused token with 409.
    3. Run the statement on the write pool. Preview runs `BEGIN; <stmt>; ROLLBACK` and returns at most 100 `RETURNING` rows.
    4. Write the audit record (§6).

**Confirmation token encoding (amended 2026-11-09, int-fix-write-confirmation-token, int-fix-mcp-write-preview).** Lightdash, the MCP server and the engine each read the HMAC list above differently. All three now use the engine's encoding. The token uses the §3 envelope (`<base64url(payload_json)>.<base64url(HMAC-SHA256(identity secret, base64url(payload_json)))>`, no padding), with this payload:

```json
{"v": 1, "typ": "write_confirmation", "statement_sha256": "<hex sha256 of the statement>",
 "sub": "<user uuid>", "project": "<project uuid>", "iat": 1767225600, "exp": 1767225720,
 "nonce": "<random, base64url>"}
```

- `typ` is always `write_confirmation`, so an identity token is never accepted as a confirmation.
- `iat` is the mint time in unix seconds. The engine refuses an `iat` more than 60 s in the future, and `exp − iat` is at most 120 s.
- The key is `statement_sha256` (lower-case hex of the statement as sent), not `stmt_sha256`. `nonce` must be non-empty.
- Single use is enforced only by the engine, which spends a token (by its signature) before the statement runs. Lightdash and the MCP server keep no record of used tokens.
- The MCP `write_preview` tool mints the same token for the mapped user and only ever sends `mode = "preview"`.

### 4.3 Alert Rules (alerting line), for the integration contract only

- **Identity.** The evaluator queries the engine as `sub = "system:alert-evaluator"`, `sys = true`. Its `audit.description` is the rule's saved description and `audit.source` is `alert_rule`.
- **States** per series: `normal | pending | firing | resolved | nodata | error`.
- **incident.io payload.** Alertmanager webhook v4: `status`, `alerts[].labels`, `annotations`, `startsAt`, `endsAt`, `fingerprint`.
- **Heartbeat.** A `GET` or `POST` to the configured heartbeat URL after every completed evaluation cycle.

**Evaluator identity and attrs (amended 2026-11-09, int-fix-alert-evaluator-identity).** §1.2 says the system identity "is configured with the attrs its rules need", but not where. This is now settled:

- **Attrs.** The env var `ALERTING_EVALUATOR_ATTRS` on the Lightdash backend lists the claims, separated by commas, for example `ALERTING_EVALUATOR_ATTRS=telemetry_restricted,platform_read`. Each name must be one of `telemetry_restricted`, `platform_read`, `platform_write` and `platform_explain`. Listed claims are true and the others are false. Unset or empty means no claims. An unknown name stops the alerting module from starting.
- **Token.** Every rule query, both evaluation and the "Test rule" preview, runs with a minted identity token: `iss = "lightdash"`, `sub = "system:alert-evaluator"`, `sys = true`, `agent = false`, and the attrs above. In the `audit` block, `description` is the rule's saved description, `source` is `alert_rule` and `resource_uuid` is the rule uuid. The engine audits these queries with `action = assertion`.
- **Email.** §3 names no email for the system identity, and the engine refuses a blank one. The token's `email` is therefore the subject, `system:alert-evaluator`. This value also becomes the audit's `executedByEmail`, so no address is invented.

## 5. Write guard (a port of db-query-portal `api/src/services/query-guard.ts`)

The guard runs in the engine. Its rules are identical to the portal's:

1. Single statement only.
2. The leading keyword is allowed for the mode:
   - read: `SELECT`, `WITH`, `EXPLAIN`, `SHOW`;
   - write: read's keywords plus `INSERT`, `UPDATE`, `DELETE`.
3. DDL and admin keywords are always blocked.
4. Data-modifying CTEs are blocked in read mode.
5. A per-connection `statement_timeout` and a row cap apply.

Port the portal's tests case for case. The source of truth is `refs/db-query-portal@aea73de` in the factory project, a read-only snapshot.

## 6. Audit records (same store and format as db-query-portal)

- **What is audited.** Every Audited Query (Platform Database, Restricted Telemetry, `platform_explain`) and every Write Mode request.
- **Where.** One DynamoDB `executions` item, plus one S3 Object Lock object, with exactly the fields and `computeIntegrityHash` canonicalisation of portal `api/src/dynamo/executions.ts` and `api/src/services/audit.service.ts`.
- **Field mapping:**

  | Field | Value |
  |---|---|
  | `executedBySub` | the identity `sub` |
  | `executedByEmail` | the identity `email` |
  | `database` | the source name |
  | `action` | `query`, `assertion` (alert rule), `ai_ask` (agent or MCP), or `export` |
  | `mode` | `read` or `write` |
- **When the write fails.** If the audit write fails, the query result is not returned. The error is SQLSTATE `58000`, "audit write failed". Unaudited reads of PHI are worse than failed reads.

## 7. Telemetry MCP server (`packages/telemetry-mcp`)

- **Transport.** Streamable HTTP. It is an OAuth 2.1 resource server for Okta: it validates the access token against Okta JWKS, `aud` = the configured audience.
- **Identity.** It maps the Okta `sub`/email to a Lightdash user and that user's attributes through the Lightdash API, using a service account. It then mints §3 tokens with `iss = "telemetry-mcp"` and `agent = true`. Restricted Telemetry is therefore never readable through MCP.
- **Tools:**
  - `list_sources`
  - `query_promql`, `query_logql`, `query_cloudwatch`, `query_cloudwatch_logs`
  - `search_traces`, `get_trace`
  - `alert_state`, `alert_history` (Lightdash API; see the note below)
  - `platform_query` (needs `description`), `platform_schema`
  - `platform_explain` with plan advice (a port of the portal's plan-advisor)
  - `ask_data` (a port of the portal's data assistant and its memory)
  - `write_preview` (Preview only; there is no commit tool)

**Alert tools and the alerting API (amended 2026-11-09, int-fix-mcp-real-lightdash).** The MCP alert tools read `GET /api/v2/projects/{projectUuid}/alerting/state?rule=` and `GET /api/v2/projects/{projectUuid}/alerting/history?rule=&since=&until=&limit=`. `rule` is a rule uuid. `since` and `until` are ISO-8601 date-times, and `until` means at or before. `limit` defaults to 100, with a maximum of 1000. The MCP also sends `ruleUuid`, `from` and `to`, which Lightdash ignores, because the MCP line's protected acceptance check pins them. Drop them once that check may change.
