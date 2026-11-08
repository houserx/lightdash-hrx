# Build line `mcp`: telemetry MCP server (`packages/telemetry-mcp`)

ENG-1799. Build `@lightdash/telemetry-mcp` per `docs/eng-1799/CONTRACTS.md` §7. Read `CONTEXT.md` (glossary),
`docs/adr/0001`–`0004` and `docs/eng-1799/CONTRACTS.md` first. Use glossary terms in code, tool descriptions
and docs; never use an `_Avoid_` term (e.g. "datasource", "dry run", "prod db").

The feature list (supervisor-owned) is ordered foundations first; take features strictly in order.

## How to run things

| What | Command (repo root) |
|---|---|
| Install + build (runs before every check) | `bash ./init.sh` |
| One acceptance check | `pnpm --fail-if-no-match -F @lightdash/telemetry-mcp exec vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/<file>.test.ts` |
| All acceptance tests | `pnpm -F @lightdash/telemetry-mcp exec vitest run --config tests/acceptance/vitest.config.ts` |
| Unit tests (yours) | `pnpm -F @lightdash/telemetry-mcp test` |
| Run the server locally | `node packages/telemetry-mcp/dist/main.js` with the env below (nothing real to point at; tests use fakes) |

- `init.sh` runs `pnpm install --frozen-lockfile`, then builds the package if `packages/telemetry-mcp/package.json`
  exists. The build is skipped when nothing under `src/`, `package.json`, `tsconfig*.json` or the lockfile is newer than
  `dist/.init-build-stamp`. It never starts a server (line rule).
- **Why `--fail-if-no-match`:** plain `pnpm -F <missing pkg> exec …` exits 0, so a check without it would pass on a tree
  where the package doesn't exist. Every check carries the flag.
- **Why `--config tests/acceptance/vitest.config.ts`:** checks run with a config in the protected folder (include
  pattern, 30 s timeouts, `passWithNoTests: false`). Your own `vitest.config.ts` only affects unit tests.

## Rules (from the goal; they hold for every session)

- Acceptance tests live in `packages/telemetry-mcp/tests/acceptance/**`. That folder is **protected**: never edit
  it, including `helpers/`. If a test seems wrong, stop and say so in your result; don't work around it.
- **Dependencies:** keep them small (the skeleton test allows at most 8 runtime deps). Pin exact versions
  (`savePrefix: ''`). **Whoever adds a dependency runs `pnpm install` and leaves an updated `pnpm-lock.yaml` in the
  same feature**, so `pnpm install --frozen-lockfile` passes afterwards. Use versions already in the lockfile when you
  can, since `minimumReleaseAge` blocks new releases:
  - `@modelcontextprotocol/sdk@1.31.0` (the workspace patch applies automatically)
  - `pg@8.13.1`, `@types/pg@8.11.10`, `jose@6.1.3`, `zod@4.6.6`
  - `vitest@4.1.11`, `@types/node@24.13.2`, `typescript` (the root has 7.0.2)
- Never import from `packages/backend` or any `ee/` folder, and never change `packages/backend/src/ee/**`.
- No network, credentials, Docker or fixed ports. Write the Dockerfile; never build it.
- No PHI and no secrets in fixtures, logs or output. Fake secret values look like `test-secret-not-real`.
- **Relative imports only in `src/`** (no tsconfig path aliases): acceptance tests import `src/index.ts` through
  their own vitest config.

## Public API pinned by the acceptance tests

The harness is `tests/acceptance/helpers/harness.ts`. Read it, and `engine.ts`, `okta.ts`, `lightdash.ts`, `llm.ts`
and `platform.ts` next to it, before starting a feature: they define exactly what the fakes speak.

### `src/index.ts` must export

```ts
loadConfig(env: Record<string, string | undefined>): Config
  // Throws an Error whose message names EVERY missing/invalid variable and never contains secret values.
startServer({ config, deps }: { config: Config; deps?: Partial<Deps> }): Promise<{ url: string; close(): Promise<void> }>
  // Listens on MCP_HOST:MCP_PORT (port 0 allowed); url = "http://127.0.0.1:<port>" (no path).
  // Startup must not contact Okta, Lightdash or the engine (dist/main.js is started with dummy URLs).
mintIdentityToken(input: {
  secret: string; sub: string; email: string; org: string; project: string;
  attrs: { telemetry_restricted: boolean; platform_read: boolean; platform_write: boolean; platform_explain: boolean };
  audit: { description: string | null; ticket: string | null } | null;
  nowSeconds?: number;   // default: floor(deps clock / 1000)
  nonce?: string;        // default: 16 random bytes, base64url
}): string
class InMemoryAskMemoryStore implements AskMemoryStore   // no-arg constructor
```

`Deps` (all optional):
- `llm: LlmClient`, Anthropic Messages shape: `createMessage(params) => Promise<{ content: (text | tool_use blocks)[];
  usage: { input_tokens; output_tokens }; stop_reason? }>`. `params` has `model`, `max_tokens`, `system`, `messages`,
  `tools`, `tool_choice`. Without `deps.llm`, build a real client from `ANTHROPIC_API_KEY`. With neither, the AI
  features say "not configured". `@anthropic-ai/sdk` isn't in the lockfile, and `fetch` against the Messages API
  is enough.
- `askMemoryStore: AskMemoryStore`, with the portal's `dynamo/askMemory.ts` functions as methods: `upsertNote(input)`,
  `listNotes(database, { includeHidden? })`, `getNote(id)`, `touchNotes(ids)`, `voteNote(id, voterId, helpful)`
  (returns the note, or `null` for a repeat voter or a missing note), `deleteNote(id)`. It keeps the DynamoDB item
  shape (`MemoryNote`), `noteId()` and `shouldHide()` exactly. The default when not injected is your choice;
  in-memory is fine.
- `now: () => number` (epoch ms). Drives **everything** time-based: JWT exp/nbf checks, caches, identity-token
  `iat`, and the resolution of `now-1h`.
- `log: (line: string) => void`. When given, every log line goes here instead of stdout.

`dist/main.js`: reads `process.env`, then `loadConfig`, then `startServer`. On invalid config it prints the error to
stderr and exits non-zero.

### HTTP surface

- `GET /healthz` returns 200 `{"status":"ok"}`, no auth.
- `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` return
  `{ resource: "<MCP_PUBLIC_URL>/mcp", authorization_servers: [OKTA_ISSUER], bearer_methods_supported: ["header"], … }`.
- `/mcp` is the streamable HTTP endpoint. A missing or invalid token gets 401 with
  `WWW-Authenticate: Bearer resource_metadata="<MCP_PUBLIC_URL>/.well-known/oauth-protected-resource[/mcp]"`, plus
  `error="invalid_token"` when a token was sent but is bad.
- JWT validation: RS256 only; `iss` = `OKTA_ISSUER`; `aud` = `OKTA_AUDIENCE` (string or array); `exp` required;
  `nbf` honoured. Cache the JWKS. On an unknown `kid`, refetch, at most once per second (jose:
  `createRemoteJWKSet(url, { cooldownDuration: 1000 })` fits). The rotation test waits 1.1 s before the new kid.
- The server's MCP `serverInfo.name` is `telemetry-mcp`.
- **An unknown user gets an empty `tools/list`, not an error.** The SDK's `McpServer` only installs a `tools/list`
  handler once a tool is registered. For an unmapped user, still declare the tools capability and answer `[]`
  (e.g. via the low-level `server.setRequestHandler`). A throwaway prototype hit `-32601 Method not found` here.
- Per-request auth: every HTTP request to `/mcp` is authenticated and mapped (with caching). The harness's clients
  are stateless-friendly. Stateless mode (`sessionIdGenerator: undefined`, a fresh server per request) is the simplest.

### Env vars (names pinned by tests)

Required: `MCP_PUBLIC_URL`, `OKTA_ISSUER`, `OKTA_AUDIENCE`, `LIGHTDASH_URL`, `LIGHTDASH_API_TOKEN`,
`LIGHTDASH_PROJECT_UUID`, `ENGINE_PG_HOST`, `ENGINE_PG_USER`, `ENGINE_PG_PASSWORD`, `ENGINE_HTTP_URL`,
`HRX_IDENTITY_SECRET`.

Optional, with these defaults:

| Var | Default |
|---|---|
| `MCP_HOST` | `0.0.0.0` |
| `MCP_PORT` | `8080` |
| `OKTA_JWKS_URI` | `${OKTA_ISSUER}/v1/keys` |
| `ENGINE_PG_PORT` | `5433` |
| `ENGINE_PG_DATABASE` | `operations` |
| `MCP_SOURCES` | `[]`: JSON list of `{name, kind, default?, restricted?}`; `kind` is one of the §1.4 kinds; anything else is invalid |
| `MCP_PLATFORM_SOURCE` | `platform` |
| `MCP_STATEMENT_TIMEOUT_MS` | `30000` |
| `MCP_MAX_ROWS` | `1000` (must be positive) |
| `MCP_MAX_OUTPUT_BYTES` | `200000` |
| `MCP_USER_CACHE_TTL_MS` | `60000` |
| `MCP_ASK_MAX_STEPS` | `60` |
| `ANTHROPIC_API_KEY` | none (optional) |
| `LOG_LEVEL` | `info` |

Further `MCP_ASK_*` knobs mirroring the portal's `AI_ASK_*` are fine.

### Identity tokens (§3), exact bytes

- Payload keys in this order: `v, iss, sub, email, org, project, agent, sys, attrs{telemetry_restricted,
  platform_read, platform_write, platform_explain}, audit{description, ticket, source, resource_uuid}, iat, exp,
  nonce`. Use `JSON.stringify` with no spaces.
- `iss: "telemetry-mcp"`, `agent: true`, `sys: false`, `audit.source: "mcp"`, `audit.resource_uuid: null`. The audit
  object is always present: `null` input gives `{description: null, ticket: null, …}`. **Lifetime 60 s.**
- Encoding: `base64url(payload).base64url(HMAC-SHA256(secret, base64url(payload)))`, no padding.
  `identity-token.test.ts` holds the expected strings.

### Engine client (pg-wire)

- Use a **new `pg.Client` per tool call**: connect, then
  `SET hrx.identity = '<token>'` (the token charset is base64url plus `.`, so quoting is safe) and
  `SET statement_timeout = <MCP_STATEMENT_TIMEOUT_MS>`, then the query **with bind parameters** (extended protocol),
  then `end()`. Use `SET` exactly; the fake engine records `SET`s, not `set_config()`.
- Only §1.1 table functions and `information_schema` are used, never `pg_*`.
  - `promql($1,$2,$3,$4[, $5 source])`, `promql_instant`, `logql` (+ `limit`, `direction`), `logql_metric` (when `step`
    is given), `cloudwatch($1::json…)`, `cloudwatch_logs`, `traceql` (+ `limit`), `trace`.
  - `platform_query($1)`, `platform_explain($1)`, `platform_tables()`, `platform_columns($1,$2)`.
  - `list_sources` reads `information_schema.tables` for catalog `ops_marts`.
  - Pass the optional `source` argument only when the caller gives one. It must name an `MCP_SOURCES` entry of the
    tool's kind.
- SQLSTATE mapping:
  - `42501` gives an error matching /access denied|permission/ that includes the engine message.
  - `54000` gives /too large|max_rows/ plus advice to narrow the query.
  - `58000` gives /audit/, and no rows are returned.
  - Anything else is still an `isError` result.
  - Error text never includes tokens, secrets or passwords.
- Row cap: at most `MCP_MAX_ROWS` rows, with `truncated: true` when more existed. Output cap: the
  `structuredContent` JSON **and** the text content each stay ≤ `MCP_MAX_OUTPUT_BYTES` (drop rows, set `truncated`).

### Tool results

- Return errors as `isError: true` results with a text message. Input-schema violations may be JSON-RPC errors; the
  harness accepts both.
- Query tools return `structuredContent` `{ columns: string[], rows: object[], rowCount, truncated }`, where
  `rowCount` is the number of rows returned. They also return a text content (JSON is fine).
- `list_sources`: `{ sources: [{name, kind, default, restricted}], opsMarts: ["<catalog>.<schema>.<table>"] }`.
- `alert_state` / `alert_history`: `{ results: <Lightdash results> }`.
  - Arguments `rule_uuid` (a uuid), `from`, `to` (times) and `limit` (positive) are sent as `ruleUuid`, `from`
    (ISO), `to` (ISO) and `limit`.
  - Call `GET /api/v2/projects/{LIGHTDASH_PROJECT_UUID}/alerting/state|history` with
    `Authorization: ApiKey <LIGHTDASH_API_TOKEN>`.
- `platform_schema`: `{tables:[{table_schema,table_name}]}` or `{columns:[{column_name,data_type,is_nullable}]}`.
  - `table_schema` defaults to `public`.
  - `description` is optional; without one, use a generated non-empty description.
- `platform_query`: requires `sql` and `description` (non-blank); `ticket` is optional and Linear-shaped
  (`/^[A-Z][A-Z0-9]*-\d+$/`). The audit block carries the description and ticket.
- `platform_explain`: `{sql, description?, advise?=true}`, with no `analyze` argument. It returns
  `{ plan, advice: PlanAdvice | null, adviceError?: string }`. A failing model never fails the tool.
- `ask_data`: `{question (1..1000 chars), history?: [{question, answer}]}`, returning the portal's `AskResult`
  (`askId, question, database, model, answer, queries, memory, rowsSharedWithModel, usage`).
  - `database` = `MCP_PLATFORM_SOURCE`.
  - The catalog comes **only** from `platform_tables()` and `platform_columns()`.
  - `run_sql` goes through `platform_query($1)` with the portal's `auditDescription` (it contains the question)
    as `audit.description`.
- `write_preview`: `{statement, description, ticket?}`, with **no mode argument**.
  - It requires attr `platform_write`; otherwise it errors naming `platform_write` before any HTTP call.
  - It POSTs `ENGINE_HTTP_URL/v1/write` with `Authorization: Bearer <identity token>` and body
    `{statement, mode:"preview", confirmation_token, description, ticket|null}`.
  - It returns the engine body `{audit_id, rows_affected, preview, returning}`. A reply with `preview !== true` or a
    non-2xx status is an error.
- Tool annotations: every tool except `write_preview` and `ask_data` has `readOnlyHint: true`. Every input property
  has a description, and tool descriptions are more than 20 characters. Across all descriptions, use the phrases
  Platform Database, Audited Query, Preview and Telemetry Source.
- The complete tool list is exactly the 14 tools in `tool-catalog.test.ts`.

### User mapping

- Use the `email` claim, or an email-shaped `sub` if there is no email claim. Match case-insensitively and exactly,
  because the fake's search is a substring match and a decoy is listed first.
- Call `GET /api/v1/org/users?searchQuery=<email>&includeGroups=<n>`. Without `includeGroups` the fake returns no
  groups. Only `isActive` users count.
- Read `GET /api/v1/org/attributes`. An attribute resolves to the user's direct value if present, else any
  `"true"` value from one of the user's groups, else `attributeDefault`. Only the exact string `"true"` is true.
- Identity fields: `sub` = Lightdash `userUuid`, `email` = Lightdash email, `org` = `organizationUuid`, `project` =
  `LIGHTDASH_PROJECT_UUID`.
- Cache per user for `MCP_USER_CACHE_TTL_MS`, using `deps.now`.

### Logs

- One JSON object per line, with string `level` and `msg`. Tool-call lines carry `tool: <name>`.
- Never log row values, SQL text or tool arguments, Okta or identity tokens, or any secret.

### Ported portal code (`refs/db-query-portal@aea73de/api/src/services/…`, read-only)

Unit-test basenames are pinned. Each must exist exactly once under `src/**`:

| Test file | Minimum passing |
|---|---|
| `plan-advisor.service.test.ts` | 4 |
| `answer-verification.test.ts` | 7 |
| `ask-memory.service.test.ts` | 8 |
| `ask-memory-store.test.ts` (the portal's `dynamo/askMemory.test.ts`, against the in-memory store) | 6 |
| `example-queries.service.test.ts` | 5 |
| `data-assistant.service.test.ts` | 28 |

`ask-domain-notes.ts` sits in the same folder as the data assistant. Port with vitest (not jest), and swap the
portal's module mocks for the injected interfaces (LLM, memory store, engine).

Keep the portal's prompts, limits and parsing as they are, except where noted here. Example queries come from the
engine's `GET /v1/audit` (§1.3), not DynamoDB:
- send the caller's identity token as `Authorization: Bearer <token>`;
- items have the portal `Execution` shape;
- `nextCursor` paginates.

## Architecture (suggested; nothing is built yet)

```
packages/telemetry-mcp/
  package.json  tsconfig.json  vitest.config.ts  Dockerfile  README.md
  src/
    index.ts            public exports (above)
    main.ts             env → loadConfig → startServer
    config.ts           validation (zod)
    log.ts              JSON line logger with a sink
    http/server.ts      node:http: /healthz, /.well-known/*, /mcp
    auth/okta.ts        jose remote JWKS + jwtVerify; challenge builder
    auth/userMapping.ts Lightdash REST client + TTL cache
    identity.ts         mintIdentityToken
    engine/client.ts    pg per call, SETs, row/size caps, SQLSTATE mapping
    engine/http.ts      /v1/write, /v1/audit
    tools/*.ts          one file per tool (zod input schemas)
    ask/                ported portal services + interfaces (LlmClient, AskMemoryStore, InMemoryAskMemoryStore)
docs/eng-1799/telemetry-mcp.md
```

## Contract assumptions (for the integration line to reconcile)

1. **Lightdash user lookup.** We use `GET /api/v1/org/users?searchQuery=&includeGroups=` and
   `GET /api/v1/org/attributes` with a service-account PAT (`Authorization: ApiKey …`). Group values count only for
   members, and only `"true"` is true.
2. **Alerting API shape** (the alerting line owns it). It is `GET /api/v2/projects/{uuid}/alerting/state|history`
   returning the standard `{status:"ok", results}` envelope. Optional query params are `ruleUuid`, `from`, `to`,
   `limit`. MCP passes `results` through untouched. It is called with the service account (alert state isn't PHI).
3. **Identity token lifetime** for MCP is 60 s (contract max 300), one token per call. The `audit` block is always
   present (nulls when not audited).
4. **Write Mode confirmation token for MCP Previews.** §4.2 only defines Lightdash-issued tokens ("HMAC over
   sha256(statement), user, project, exp ≤ 120 s, nonce"). The MCP server mints its own under `HRX_IDENTITY_SECRET`
   in the §3 envelope style:
   `base64url(json{v:1, stmt_sha256, sub, project, exp, nonce}).base64url(HMAC-SHA256)`.
   The engine must accept it for `mode: "preview"`, or the integration line swaps in Lightdash's issuer. The tests
   only require a non-empty string.
5. **Sources list.** The engine exposes no "list sources" call, so `MCP_SOURCES` mirrors the non-secret part of the
   engine config. Ops Marts come from `information_schema.tables` (catalog `ops_marts`).
6. **Audited catalog reads.** `platform_schema` sends a generated description when the caller gives none.
   `platform_explain` likewise; the engine requires a description for every Audited Query (§1.2).
7. **ask_data catalog and examples.** The portal read `pg_catalog`/DynamoDB directly. MCP uses
   `platform_tables()`/`platform_columns()` and the engine audit browser `GET /v1/audit`, which needs
   `platform_read`. Comments, foreign keys and row estimates are unavailable through the contract, so join-path and
   row-count hints degrade gracefully.
8. **Time arguments** accept ISO-8601 or `now`/`now-<n><s|m|h|d|w>`, resolved to absolute ISO before the SQL is
   built.

## Status

- 2026-11-08: init session. Wrote 53 acceptance tests (one per feature) and their helpers, `init.sh`, and this file.
  No package code exists yet.
- The harness was checked against a throwaway prototype (since deleted): the fake Okta, Lightdash and engine work
  with `pg@8.13.1`, `jose@6.1.3` and the SDK 1.31.0 client.
- 2026-11-08T15:02:43Z supervisor: initialized: 53 features, run 20261108-093244
- 2026-11-08T15:44:20Z supervisor: initialized: 53 features, run 20261108-104127
