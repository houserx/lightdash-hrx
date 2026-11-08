# @lightdash/telemetry-mcp

An MCP server (ENG-1799) that lets HouseRx engineers and their agents query the Telemetry Sources, the Alert Rules
of the Lightdash Operations Project and the Platform Database. Every query goes through the Federation Engine as
the caller, so the engine applies that person's grants and writes the audit record for Audited Queries.

How to attach the server to a Lightdash agent or to Claude Code, and how the auth flow works, is in
[docs/eng-1799/telemetry-mcp.md](../../docs/eng-1799/telemetry-mcp.md). Terms follow the glossary in
[CONTEXT.md](../../CONTEXT.md).

## What it does

- Serves stateless streamable HTTP MCP on `POST /mcp`. Each request carries an Okta access token as a bearer
  token. A request without a valid token gets `401` with a `WWW-Authenticate` challenge that points to the
  protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`.
- Checks the token's signature against the Okta JWKS and its issuer, audience and expiry, then maps the token's
  email to an active Lightdash user and reads that user's attributes (`telemetry_restricted`, `platform_read`,
  `platform_explain`, `platform_write`). A caller with no Lightdash user sees no tools.
- Runs each tool against the Federation Engine as the caller, using a short-lived signed `hrx.identity` token.
  Restricted Telemetry is readable only by callers with the `telemetry_restricted` attribute.
- Caps every result by row count and by size, and marks a cut result with `truncated: true`.
- Answers `GET /healthz` with `200` for health checks.
- Writes structured JSON logs to stdout.

## Tools

| Tool                    | What it does                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `list_sources`          | Lists the Telemetry Sources (name, kind, default for its kind, Restricted Telemetry or not) and the Ops Marts.   |
| `query_promql`          | Runs a PromQL range or instant query on a Prometheus Telemetry Source; returns the Time series long shape.       |
| `query_logql`           | Runs a LogQL log query (one row per line) or LogQL metric query (Time series) on a Loki Telemetry Source.        |
| `query_cloudwatch`      | Runs one CloudWatch MetricDataQuery (stat or math expression) on a CloudWatch Telemetry Source.                  |
| `query_cloudwatch_logs` | Runs a CloudWatch Logs Insights query over log groups of a CloudWatch Logs Telemetry Source.                     |
| `search_traces`         | Finds traces with a TraceQL query on a Tempo Telemetry Source; one summary row per trace.                        |
| `get_trace`             | Returns every span of one trace from a Tempo Telemetry Source.                                                   |
| `alert_state`           | Returns the current state of the Alert Rules in the Operations Project, from Lightdash alerting.                 |
| `alert_history`         | Returns past state transitions of the Alert Rules, filtered by rule and time range.                              |
| `platform_schema`       | Lists Platform Database tables, or the columns of one table. An Audited Query; needs `platform_read`.             |
| `platform_query`        | Runs one read-only SQL query on the Platform Database. An Audited Query; needs `platform_read`.                  |
| `platform_explain`      | Returns the estimate-only plan (never ANALYZE) of one statement, with AI plan advice when an LLM is configured. An Audited Query; needs `platform_read` or `platform_explain`. |
| `ask_data`              | Answers a natural-language question about the Platform Database with read-only Audited Queries, or abstains. Needs `ANTHROPIC_API_KEY`. Keeps a shared team memory. |
| `write_preview`         | Runs one INSERT, UPDATE or DELETE on the Platform Database as a Preview only: the engine rolls it back. Needs `platform_write`. |

Time arguments take an ISO-8601 time such as `2026-11-08T10:00:00Z`, `now`, or `now-<duration>` such as
`now-1h`. Each Telemetry Source tool
takes an optional `source`; without it the default Telemetry Source of that kind is used.

Nothing here can commit a Write Mode statement: there is no commit tool, `write_preview` has no mode argument, and
the server only ever asks the engine for a Preview.

## Configuration

All settings come from env. On start the server reports every missing or malformed variable at once, by name,
and never prints a value.

| Variable                   | Required | Default                   | Meaning                                                                                                  |
| -------------------------- | -------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `MCP_PUBLIC_URL`           | yes      |                           | Public base URL of this server; the MCP resource is `${MCP_PUBLIC_URL}/mcp`.                             |
| `MCP_HOST`                 | no       | `0.0.0.0`                 | Interface to listen on.                                                                                  |
| `MCP_PORT`                 | no       | `8080`                    | Port to listen on (`0` picks a free port).                                                               |
| `OKTA_ISSUER`              | yes      |                           | Okta issuer URL; must equal the token's `iss` claim exactly.                                             |
| `OKTA_AUDIENCE`            | yes      |                           | Expected `aud` claim of the Okta access token.                                                           |
| `OKTA_JWKS_URI`            | no       | `${OKTA_ISSUER}/v1/keys`  | Okta JWKS URL used to check token signatures.                                                            |
| `LIGHTDASH_URL`            | yes      |                           | Lightdash base URL, for user mapping, user attributes and Lightdash alerting.                            |
| `LIGHTDASH_API_TOKEN`      | yes      |                           | Secret. Lightdash service-account API token.                                                             |
| `LIGHTDASH_PROJECT_UUID`   | yes      |                           | UUID of the Lightdash Operations Project.                                                                |
| `ENGINE_PG_HOST`           | yes      |                           | Federation Engine Postgres-wire host.                                                                    |
| `ENGINE_PG_PORT`           | no       | `5433`                    | Federation Engine Postgres-wire port.                                                                    |
| `ENGINE_PG_USER`           | yes      |                           | Federation Engine user for this server.                                                                  |
| `ENGINE_PG_PASSWORD`       | yes      |                           | Secret. Password for `ENGINE_PG_USER`.                                                                   |
| `ENGINE_PG_DATABASE`       | no       | `operations`              | Federation Engine database name.                                                                         |
| `ENGINE_HTTP_URL`          | yes      |                           | Federation Engine HTTP base URL (audit browser and `POST /v1/write` for Previews).                       |
| `HRX_IDENTITY_SECRET`      | yes      |                           | Secret. Shared key used to sign `hrx.identity` tokens for the Federation Engine.                         |
| `MCP_SOURCES`              | no       | `[]`                      | JSON list of `{name, kind, default?, restricted?}`, mirroring the engine's Telemetry Sources. `kind` is one of `prometheus`, `loki`, `cloudwatch`, `cloudwatch_logs`, `tempo`, `platform_postgres`, `bigquery`. |
| `MCP_PLATFORM_SOURCE`      | no       | `platform`                | Name of the Platform Database in the Federation Engine.                                                  |
| `MCP_STATEMENT_TIMEOUT_MS` | no       | `30000`                   | Per-query time limit in milliseconds.                                                                    |
| `MCP_MAX_ROWS`             | no       | `1000`                    | Most rows a tool returns before it sets `truncated`.                                                     |
| `MCP_MAX_OUTPUT_BYTES`     | no       | `200000`                  | Largest tool result in bytes before it sets `truncated`.                                                 |
| `MCP_USER_CACHE_TTL_MS`    | no       | `60000`                   | How long a mapped Lightdash user and its attributes are cached (`0` turns the cache off).                |
| `MCP_ASK_MAX_STEPS`        | no       | `60`                      | Step budget for one `ask_data` question.                                                                 |
| `ANTHROPIC_API_KEY`        | no       |                           | Secret. Turns on the AI features (`ask_data`, plan advice in `platform_explain`). Without it `ask_data` fails clearly and `platform_explain` still returns the plan. |
| `LOG_LEVEL`                | no       | `info`                    | One of `debug`, `info`, `warn`, `error`.                                                                 |

## Build, run and test

From the repo root:

```sh
pnpm install --frozen-lockfile
pnpm -F @lightdash/telemetry-mcp build        # tsc into dist/
pnpm -F @lightdash/telemetry-mcp typecheck
pnpm -F @lightdash/telemetry-mcp start        # node dist/main.js; needs the env above
```

Tests use vitest. Run one file at a time:

```sh
# a unit test next to the code in src/
pnpm -F @lightdash/telemetry-mcp exec vitest run src/config.test.ts

# an acceptance test (starts fake Okta, Lightdash and Federation Engine servers on free ports)
pnpm -F @lightdash/telemetry-mcp exec vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/tool-catalog.test.ts
```

`pnpm -F @lightdash/telemetry-mcp test` runs every unit test. Acceptance tests load the server from
`src/index.ts` (`loadConfig` and `startServer`) and stop every server they start.

The container image builds from the repo root with `docker build -f packages/telemetry-mcp/Dockerfile .`. It
runs `dist/main.js` as a non-root user on port 8080, with a `/healthz` health check.

The package imports nothing from `packages/backend`.
