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
9. **Example-query paging** (recorded first under mcp-example-queries-port; promoted here 2026-11-09 by the
   integration line's int-assumptions-register). §1.3 has no `from`/`to`/`pageSize`/`excludeScheduler`, so the
   example-queries service sends no filters to `GET /v1/audit` and follows `nextCursor` from the engine's default
   listing, at most 5 pages as in the portal. Records older than the 90-day lookback are skipped; records without a
   readable `createdAt` are kept.
10. **Engine-side Ask audit and catalog** (recorded first under mcp-data-assistant-port; promoted here 2026-11-09 by
    int-assumptions-register). (a) The engine writes ask_data's audit records; statements rejected locally never reach
    it. (b) SQLSTATE 58000 from any engine read fails the whole ask (`AskError` 500, no rows). (c) A catalog read
    failure is 502 with the engine's error text. (d) Through §1.1 there are no comments, row estimates, enums,
    constraints, indexes or FKs, so the catalog and join-path hints degrade.

## Status

- 2026-11-08: init session. Wrote 53 acceptance tests (one per feature) and their helpers, `init.sh`, and this file.
  No package code exists yet.
- The harness was checked against a throwaway prototype (since deleted): the fake Okta, Lightdash and engine work
  with `pg@8.13.1`, `jose@6.1.3` and the SDK 1.31.0 client.
- 2026-11-08T15:02:43Z supervisor: initialized: 53 features, run 20261108-093244
- 2026-11-08T15:44:20Z supervisor: initialized: 53 features, run 20261108-104127

### mcp-package-skeleton (2026-11-08)

- Added `packages/telemetry-mcp`: `package.json` (`@lightdash/telemetry-mcp`, `"type": "module"`, deps
  `@modelcontextprotocol/sdk@1.31.0` + `pg@8.13.1`; dev `@types/node`, `@types/pg`, `typescript@7.0.2`, `vitest`),
  `tsconfig.json` (standalone, `NodeNext`, strict, `src` → `dist`, excludes `src/**/*.test.ts`), unit
  `vitest.config.ts` (`src/**/*.test.ts`), `.gitignore` (dist). `pnpm-lock.yaml` has the new importer.
- `src/config.ts`: **skeleton `loadConfig`** that only reads `MCP_HOST` (default `0.0.0.0`) and `MCP_PORT` (default
  `8080`, 0 allowed). `Config` is `{host, port}` for now. The `mcp-config-validation` session extends it with every
  required variable (zod is in the lockfile but not yet a dependency: add it then, ≤ 8 deps total).
- `src/http/server.ts`: `startServer({config})` on `node:http`; `GET|HEAD /healthz` → 200 `{"status":"ok"}`, other
  paths 404. Returns `{url: "http://127.0.0.1:<port>", close()}` (`close` drops keep-alive connections). Later
  features add `deps`, `/.well-known/*` and `/mcp` here.
- `src/main.ts`: env → `loadConfig` → `startServer`; config error → stderr + exit 1; SIGTERM/SIGINT close cleanly.
- `src/index.ts` exports `loadConfig`, `startServer` and their types. Source uses `.js` relative import suffixes
  (NodeNext); vitest resolves them to `.ts`, so acceptance tests can import `src/index.ts` directly.
- Tested as a user: `bash ./init.sh`, `pnpm install --frozen-lockfile`, started `dist/main.js` with the dummy env,
  `GET /healthz` → 200 `application/json` `{"status":"ok"}`, unknown path → 404, SIGTERM → exit 0; `MCP_PORT=x` →
  stderr message, exit 1. Unit tests (`pnpm -F @lightdash/telemetry-mcp test`) and the skeleton check pass.
- Trap: macOS has no `timeout`; drive the server from a small node script (spawn, fetch, kill) in `../tmp`.
- 2026-11-08T15:46:17Z supervisor: mcp-package-skeleton passed the gate in round 1

### mcp-config-validation (2026-11-08)

- `src/config.ts`: full `loadConfig(env)`. It collects **every** problem, then throws `ConfigError` (`.problems:
  string[]`; message `Invalid configuration (N problems):` plus one `  - <VAR> …` line each). Messages name the
  variable and the rule, **never a value** (not even non-secret ones). Blank or whitespace-only counts as missing.
- `Config` shape (later features read this): `host, port, publicUrl` (trailing `/` stripped), `okta{issuer (verbatim,
  must equal iss), audience, jwksUri}` (default `${issuer}/v1/keys`), `lightdash{url, apiToken, projectUuid}`,
  `engine{pgHost, pgPort, pgUser, pgPassword, pgDatabase, httpUrl}`, `identitySecret`, `sources: SourceConfig[]`
  (`{name, kind, default, restricted}`, flags default `false`), `platformSource, statementTimeoutMs, maxRows,
  maxOutputBytes, userCacheTtlMs, askMaxSteps, anthropicApiKey (undefined when unset), logLevel`.
- Rules: URLs must be absolute http(s) with no userinfo (http allowed: the fakes use `http://127.0.0.1`);
  `LIGHTDASH_PROJECT_UUID` must be a UUID; `MCP_PORT` 0–65535, `ENGINE_PG_PORT` 1–65535; `MCP_MAX_ROWS`,
  `MCP_STATEMENT_TIMEOUT_MS`, `MCP_MAX_OUTPUT_BYTES`, `MCP_ASK_MAX_STEPS` ≥ 1, `MCP_USER_CACHE_TTL_MS` ≥ 0;
  `LOG_LEVEL` in debug|info|warn|error; `MCP_SOURCES` a JSON list, kinds from `SOURCE_KINDS` (§1.4), unique names,
  boolean flags; extra keys in an entry are ignored. `MCP_PLATFORM_SOURCE` is **not** cross-checked against
  `MCP_SOURCES` (default list is empty).
- Decision: hand-written validation, **no zod dependency yet** (keeps messages fully under our control so no value is
  echoed). Add `zod@4.6.6` when tool input schemas need it.
- `src/index.ts` also exports `ConfigError`, `SOURCE_KINDS`, `LOG_LEVELS` and the config types. Unit tests:
  `src/config.test.ts`; `src/http/server.test.ts` now builds a full env inline (don't import between test files:
  vitest would re-register the other file's suites).
- Tested as a user: from a node script against `dist/index.js`, empty env → all 11 required names; bad port /
  `not a url` issuer / `{not json` sources / `-5` rows → 4 lines naming each, no secret value in the message;
  `env -i node dist/main.js` → the 11-line message on stderr, exit 1; full env → `/healthz` 200, SIGTERM exit 0.
  `config-validation` and `package-skeleton` acceptance checks pass, plus unit tests and typecheck.
- 2026-11-08T15:48:54Z supervisor: mcp-config-validation passed the gate in round 1

### mcp-identity-token (2026-11-08)

- `src/identity/token.ts`: `mintIdentityToken({secret, sub, email, org, project, attrs, audit?, nowSeconds?, nonce?})`
  → `<b64url(payload)>.<b64url(HMAC-SHA256(secret, b64url(payload)))>`, unpadded. The payload is built as a literal in
  CONTRACTS §3 key order (attrs too, whatever order the caller passes), so tokens are byte-for-byte reproducible.
  Fixed by the MCP server: `v 1`, `iss "telemetry-mcp"`, `agent true`, `sys false`, `audit.source "mcp"`,
  `audit.resource_uuid null`, `exp = iat + 60`. `audit: null`/omitted → description and ticket `null`. Default clock
  is `Date.now()`, default nonce 16 random bytes. The secret comes from `config.identitySecret` (callers pass it).
- `src/index.ts` exports `mintIdentityToken`, `IDENTITY_TOKEN_ISSUER`, `IDENTITY_TOKEN_LIFETIME_SECONDS` and the
  input types. Unit tests: `src/identity/token.test.ts`.
- Contract assumption: the MCP never sets `resource_uuid` (no tile/rule behind an MCP call) and attr flags are coerced
  with `=== true`.
- Tested as a user: from a node script against `dist/index.js`, the fixed acceptance inputs gave both expected
  signatures (with and without audit); two unpinned mints → different 16-byte nonces, 60 s lifetime,
  iss telemetry-mcp, agent true, sys false. `identity-token`, `config-validation`, `package-skeleton` acceptance
  checks, unit tests and typecheck pass.
- 2026-11-08T15:50:38Z supervisor: mcp-identity-token passed the gate in round 1

### mcp-protected-resource-metadata (2026-11-08)

- `src/http/protectedResource.ts`: `protectedResourceMetadata(config)` → RFC 9728 document `{resource:
  "${publicUrl}/mcp", authorization_servers: [okta.issuer], bearer_methods_supported: ["header"], resource_name}`;
  `MCP_PATH = '/mcp'` and `PROTECTED_RESOURCE_METADATA_PATHS` (bare and `/mcp`-suffixed well-known paths). All exported
  from `src/index.ts`.
- `src/http/server.ts`: `handle` now takes `config`; both metadata paths answer GET/HEAD with 200 JSON, no auth, no
  Lightdash call; other methods 405 with `Allow: GET, HEAD` (shared `allowGetOnly` helper with `/healthz`).
- Next session (Okta auth on `/mcp`): the 401 `WWW-Authenticate` header should point `resource_metadata` at
  `${publicUrl}/.well-known/oauth-protected-resource/mcp`; reuse `MCP_PATH`. No `scopes_supported` published (spec
  names none).
- Note: prettier isn't installed in this checkout (`pnpm exec prettier` not found); formatting kept by hand.
- Tested as a user: started `dist/main.js` with a full env (public URL with trailing `/`), fetched both well-known
  paths → identical 200 `application/json` documents with resource `https://telemetry-mcp.example.test/mcp`, the
  issuer, `["header"]`; `/…/other` → 404; POST → 405; SIGTERM exit 0. Acceptance checks protected-resource-metadata,
  package-skeleton, config-validation, identity-token pass; unit tests and typecheck pass.
- 2026-11-08T15:52:10Z supervisor: mcp-protected-resource-metadata passed the gate in round 1

### mcp-unauthorized-challenge (2026-11-08)

- `src/http/bearerChallenge.ts`: `extractBearer(headers)` → `missing` (no header, or any non-Bearer scheme) |
  `malformed` (Bearer with an empty or non-compact-JWS token) | `token`; `resourceMetadataUrl(config)` →
  `${publicUrl}/.well-known/oauth-protected-resource/mcp`; `bearerChallenge(config, err?)` builds the
  `WWW-Authenticate` value (`Bearer [error="invalid_token", error_description="…", ]resource_metadata="…"`). Nothing
  from the request is ever put in the challenge or body. All exported from `src/index.ts`.
- `src/http/server.ts`: `/mcp` (any method) now goes through `handleMcp`, which answers 401 + challenge before
  anything else: no error code for missing/non-Bearer credentials (RFC 6750 §3.1), `invalid_token` for malformed.
  JSON bodies `{error:"unauthorized"}` / `{error:"invalid_token", error_description}`.
- **Fail closed, for the next session:** a JWT-shaped token currently also gets 401 `invalid_token` ("could not be
  verified"), because Okta verification doesn't exist yet. `mcp-okta-claims-validation` must replace that last
  branch of `handleMcp` with real JWKS verification (and then hand off to the MCP transport); keep
  `sendUnauthorized(config, res, {error:'invalid_token', …})` for every verification failure.
- Unit tests: `src/http/bearerChallenge.test.ts`, new cases in `src/http/server.test.ts`.
- Tested as a user: started `dist/main.js` with Lightdash/engine pointed at counting TCP listeners; POST initialize with
  no auth → 401 `Bearer resource_metadata="https://telemetry-mcp.example.test/.well-known/oauth-protected-resource/mcp"`;
  `Bearer not-a-jwt` → 401 with `error="invalid_token"`; Basic → 401 no error code; GET /mcp → 401; metadata still
  200; SIGTERM exit 0; Lightdash and engine contacted 0 times. Acceptance unauthorized-challenge passes, and the four
  earlier acceptance checks, unit tests and typecheck pass too.
- 2026-11-08T15:54:14Z supervisor: mcp-unauthorized-challenge passed the gate in round 1

### mcp-okta-claims-validation (2026-11-08)

- Added runtime dep `jose@6.1.3` (already in the lockfile; `pnpm-lock.yaml` updated, 4 runtime deps now).
- `src/auth/okta.ts`: `createOktaVerifier(config.okta)` → `{ verify(token) }` using jose `createRemoteJWKSet(jwksUri,
  { cooldownDuration: JWKS_COOLDOWN_MS = 1000 })` + `jwtVerify` with `algorithms: ['RS256']`, exact `issuer`,
  `audience` (string or array), `requiredClaims: ['exp']`, `clockTolerance: 30 s` (`CLOCK_TOLERANCE_SECONDS`; the spec
  names no skew, 30 s is my choice). Failures throw `AccessTokenError` whose `description` is a fixed sentence (expired /
  not valid yet / no expiry / wrong issuer / wrong audience / bad algorithm / "could not be verified"), never token
  content. Uses the real clock, not `deps.now` (a fake clock must not relax token expiry). JWKS is fetched lazily on the
  first token, never at startup.
- `src/http/server.ts`: `startServer` builds one verifier per server (so the JWKS cache is shared); `handleMcp` is now
  async and sends 401 `invalid_token` + challenge for every verification failure, including an unreachable JWKS (fail
  closed). On success it hands off to `serveMcpRequest`.
- `src/mcp/server.ts`: **minimal** handoff so initialize succeeds: stateless `StreamableHTTPServerTransport`
  (`sessionIdGenerator: undefined`) + a fresh `McpServer({ name: 'telemetry-mcp' })` per request, no tools, closed on
  `res` close. `serveMcpRequest(verified, req, res)` receives the verified claims but doesn't use them yet.
  `mcp-streamable-http-transport` owns the rest (tools capability, ping, tools/list — remember the note above that an
  `McpServer` with no tools answers tools/list with -32601; user mapping should hang off `verified.claims`).
- Rotation (`mcp-okta-jwks-rotation`): jose's remote set already caches and refetches on an unknown kid with a 1 s
  cooldown; I did not run that acceptance test — the next session should verify fetch counts there.
- Unit tests: `src/auth/okta.test.ts` (local JWKS server; every rejection case, caching, unreachable JWKS); renamed the
  old "fails closed until Okta verification exists" case in `src/http/server.test.ts` (an undecodable `aaa.bbb.ccc` is
  rejected before any JWKS fetch).
- Tested as a user: started `dist/main.js` against a local JWKS server; 0 JWKS fetches at startup; POST initialize with a
  valid RS256 token → 200 with serverInfo `telemetry-mcp`; wrong iss, wrong aud, expired, future nbf, no exp, foreign
  key, alg none, HS256, tampered payload → 401 each with `error="invalid_token"` and `resource_metadata`; 1 JWKS fetch
  in total; SIGTERM exit 0. Acceptance okta-claims-validation (10/10) plus the five earlier acceptance checks, unit tests
  (31) and typecheck pass.
- 2026-11-08T16:00:15Z supervisor: mcp-okta-claims-validation passed the gate in round 1

### mcp-okta-jwks-rotation (2026-11-08)

- No behaviour change was needed: the jose remote key set built in `mcp-okta-claims-validation` (one per server, so it is
  shared by all requests) already caches the JWKS, refetches once on an unknown `kid`, and rate-limits those refetches
  to one per `JWKS_COOLDOWN_MS` (1 s). Concurrent lookups share one in-flight fetch. The acceptance test passed as
  soon as `init` ran.
- `src/auth/okta.ts`: the module doc and the `JWKS_COOLDOWN_MS` comment now state the rotation and rate-limit contract
  (and jose's default 10-minute cache max age), so nobody "simplifies" the verifier into one per request or raises the
  cooldown above the 1 s that the acceptance test relies on.
- `src/auth/okta.test.ts`: new `JWKS rotation` unit test using a local JWKS server that rotates. It checks 1 fetch for
  repeated tokens, exactly 1 refetch for the new kid, then cached, and 10 parallel bogus kids → all rejected with 1 fetch.
- Tested as a user: ran `dist/main.js` against a local rotating JWKS server, with Lightdash/engine pointed at a counting
  listener. Results: 0 fetches at startup. 5 initialize calls → 200 each with 1 fetch. After rotating to a new key and
  waiting 1.1 s, a new-key token → 200 at 2 fetches, and again 200 with still 2 fetches. A token from the retired key →
  401. 8 sequential plus 10 parallel bogus-kid tokens → 401 each with `invalid_token`, 0 extra fetches. SIGTERM exit 0,
  0 Lightdash/engine contacts. The 7 acceptance files so far (34 tests), unit tests (32) and typecheck all pass.
- Trap: a token signed by the retired key is refused as soon as Okta drops that key from the JWKS. Okta keeps old keys
  published for a while during rotation, so in-flight tokens normally still verify.
- 2026-11-08T16:02:17Z supervisor: mcp-okta-jwks-rotation passed the gate in round 1

### mcp-streamable-http-transport (2026-11-08)

- The acceptance test needs `tools/list` to return **at least one tool**, and an `McpServer` with no tools answers
  -32601. So this feature registers the first real tool, a **partial `list_sources`**. Decision: it returns only the
  configured Telemetry Sources (`{ sources: [{name, kind, default, restricted}] }` from `MCP_SOURCES`). It does not
  contact the engine and has no `opsMarts` key yet. **`mcp-tool-list-sources` must add `opsMarts`** (an
  `information_schema.tables` query for catalog `ops_marts`, through the engine session) and the text/structured
  output to match. Don't return a fake empty `opsMarts`.
- `src/tools/listSources.ts`: `registerListSources(server, config)` (description in glossary terms,
  `readOnlyHint: true`, no input arguments, so the SDK emits `{type:"object"}`), plus a pure `listSources(config)`.
  Pattern for later tools: one file per tool under `src/tools/`, registered in `createMcpServer`.
- `src/mcp/server.ts`: `createMcpServer(config)` builds the per-request server and registers the tools.
  `serveMcpRequest(config, auth, req, res)` now takes the config (`src/http/server.ts` passes it). It is still
  stateless (fresh server and transport per POST), so concurrent clients need no shared state. `auth` is still unused;
  user mapping hangs off it.
- Note: `McpServer` advertises `tools.listChanged: true` once a tool is registered, whatever capabilities you pass in.
  That is harmless in stateless mode. For `mcp-unknown-user-no-tools` (an empty list, not -32601), either register
  nothing and set a `tools/list` handler on `server.server`, or skip the tools.
- Unit tests: `src/mcp/server.test.ts` (InMemoryTransport: serverInfo, tools capability, ping, list_sources listing
  and call). `src/index.ts` exports `createMcpServer`, `MCP_SERVER_VERSION`, `LIST_SOURCES_TOOL`, `listSources`.
- Tested as a user: a node script in `../tmp/transport-ut` started `dist/main.js` against a local JWKS server and
  connected the SDK `StreamableHTTPClientTransport` with an RS256 bearer. 0 JWKS fetches at startup. serverInfo
  `telemetry-mcp`; ping `{}`; tools/list `[list_sources (object schema, readOnlyHint)]`; tools/call returned the two
  configured sources with their flags. Two more clients connected in parallel and saw the same tool names. A POST
  without a token got 401 + challenge. 1 JWKS fetch in total; SIGTERM exit 0. The 8 acceptance files so far
  (37 tests), unit tests (35) and typecheck all pass.
- 2026-11-08T16:05:51Z supervisor: mcp-streamable-http-transport passed the gate in round 1

### mcp-tool-list-sources (2026-11-08)

- `list_sources` now returns `{ sources: [{name, kind, default, restricted}], opsMarts: ["ops_marts.<schema>.<table>"] }`,
  in both the structured and the text (JSON) content. `opsMarts` is sorted and de-duplicated. If the engine call
  fails, the tool returns an `isError` result (`Could not list the Ops Marts: …`), never a partial list without
  `opsMarts`.
- New `src/engine/client.ts`: `createEngineClient(config.engine)` returns an `EngineClient`
  (`query(sql, params) → {columns, rows}`). Every call opens a **new `pg.Client`**, runs one statement with bind
  parameters (extended protocol), then calls `end()` in `finally`. It has a 10 s connect timeout and swallows idle
  `error` events. Failures throw `EngineError` (`.code` = SQLSTATE when the engine sent one). Driver-level failures
  with no SQLSTATE get the fixed message "could not reach the Federation Engine", so host, user and password never
  reach the client.
  - **`mcp-engine-session` adds the two SETs here** (`SET hrx.identity = '<token>'`, `SET statement_timeout = …`) on
    the same client, before the query. The token needs the mapped user, so for now it can't be minted.
  - `mcp-engine-error-mapping` maps `EngineError.code`.
  - CONTRACTS §2 says Ops Marts need only "a valid login", so running the catalog query without an identity is not a
    hole in the meantime.
- SQL: `SELECT table_catalog, table_schema, table_name FROM information_schema.tables WHERE table_catalog = $1 AND
  table_schema <> 'information_schema' ORDER BY …`, with `$1 = 'ops_marts'`.
  - Decision: DataFusion lists its own `information_schema` views under every catalog, and those are not Ops Marts,
    so they are excluded in the SQL and again client-side (rows from other catalogs are dropped too).
  - **Never write `pg_` anywhere in this SQL**, not even in a `NOT IN ('pg_catalog')`: the acceptance test rejects
    `/\bpg_/i`.
- `createMcpServer(config, deps?)` takes `Partial<McpServerDeps>` (`{ engine }`). The default is the real engine
  client. Unit tests inject a fake `EngineClient`. Later tools should take the engine from here too. `index.ts`
  exports `createEngineClient`, `EngineError`, `EngineClient`, `EngineResult`, `McpServerDeps`, `OPS_MARTS_CATALOG`
  and `listOpsMarts`.
  - `listSources(config, engine)` is now async.
- Unit tests in `src/mcp/server.test.ts`:
  - `list_sources` with a fake engine: the result shape, the SQL (`information_schema`, no `pg_`), the parameter
    `['ops_marts']`, and filtering out other catalogs and `information_schema`.
  - The engine-failure path returns `isError` with no structured content.
- Tested as a user: `../tmp/list-sources-ut/run.mts` (run it with `node_modules/.bin/tsx run.mts <pkg dir> [down]`; it
  must be `.mts` for top-level await). It starts `dist/main.js` against the acceptance fake engine (imported
  read-only) and a local JWKS server, then connects the SDK streamable-HTTP client with an RS256 bearer.
  - 0 engine connections at startup.
  - `tools/list` shows `list_sources` with `{type:"object"}` and `readOnlyHint`.
  - The call returned all 3 configured sources with their flags, and `opsMarts` `[ops_marts.ops.fills_hourly,
    ops_marts.ops.queue_depth]` (the `information_schema` row was dropped).
  - The engine saw one extended-protocol query with param `ops_marts` and no `pg_`. The connection was closed
    afterwards: 0 open, 1 in total.
  - With the engine port unreachable, the call returned `isError` "could not reach the Federation Engine".
  - SIGTERM exits 0.
  - The 9 acceptance files so far (40 tests), unit tests (36) and typecheck all pass.
- 2026-11-08T16:09:56Z supervisor: mcp-tool-list-sources passed the gate in round 1

### mcp-engine-session (2026-11-08)

- **Every engine query now runs as the caller.** `createEngineClient(config.engine, session)` takes an
  `EngineSession` (`{ identityToken(audit), statementTimeoutMs }`). For each `query(sql, params, { audit? })` it:
  1. mints the token,
  2. opens a new `pg.Client`,
  3. sends `SET hrx.identity = '<token>'` and `SET statement_timeout = <MCP_STATEMENT_TIMEOUT_MS>` (simple protocol,
     same connection),
  4. runs the query with bind parameters,
  5. calls `end()` in `finally`.
  - `sessionStatements()` builds the two SETs and refuses a token that isn't `base64url.base64url` (quote-safe).
  - The token is minted **before** connecting, so a user who can't be identified never opens a connection. The
    error is `EngineError(<fixed sentence>, code undefined)`.
  - Audited tools (platform_query/explain/schema, ask_data) pass `{ audit: { description, ticket } }` as the third
    argument of `query`.
- New `src/engine/session.ts`: `createIdentitySession(config, users, claims, now)`.
  - It maps the Okta claims to the Lightdash user **lazily, on the first query of the HTTP request**, memoised for
    that request. So `initialize`, `ping` and `tools/list` make no Lightdash call (verified: 0 lookups after
    connect).
  - It then mints a fresh §3 token per query (60 s lifetime, `iat` from `deps.now`, new nonce).
- **Ordering trap, decided:** this feature's check asserts `sub` = Lightdash userUuid, plus attrs that come from a
  direct user value *and* a group value. The token can't be minted without user mapping and attributes, so
  `src/auth/userMapping.ts` came along now, following PROGRESS "User mapping" exactly:
  - `createLightdashUserResolver(config.lightdash)` looks the user up with `GET /api/v1/org/users?searchQuery=<email>&includeGroups=1000`
    and `GET /api/v1/org/attributes`, authenticating with `ApiKey <LIGHTDASH_API_TOKEN>`.
  - It matches the `email` claim, or an email-shaped `sub`, case-insensitively and exactly, against active users only.
  - `resolveAttrs` takes the direct value, else a group `"true"`, else the default. Only `"true"` is true.
  - As a side effect, `user-mapping.test.ts` and `user-attributes.test.ts` already pass. The sessions for
    `mcp-user-mapping` and `mcp-user-attributes` should verify that and harden edge cases (pagination, error
    texts) rather than rewrite it.
  - **Still not built (left to their features):**
    - The TTL cache (`mcp-user-mapping-cache`): every HTTP request with a tool call does 2 Lightdash calls today.
    - The empty `tools/list` for unknown users (`mcp-unknown-user-no-tools`). For now an unmapped, inactive or
      email-less user gets the tools listed, but every engine-backed call returns `isError` ("Your Okta user has no
      active Lightdash user with the same email"), and no engine connection is opened.
    - When that feature lands, resolve the user eagerly in `serveMcpRequest`. `createIdentitySession` could then take
      the `MappedUser` instead of the resolver.
- Plumbing:
  - `startServer({ config, deps })` now honours `deps.now` (`ServerDeps`). `deps.log` is still ignored
    (`mcp-structured-logs`).
  - `serveMcpRequest(config, context, auth, req, res)` builds the session and the engine per request.
  - `createMcpServer(config, { engine })` now **requires** `engine`. Unit tests inject a fake, as before.
  - New exports: `sessionStatements`, `createIdentitySession`, `createLightdashUserResolver`, `UserMappingError`,
    `emailFromClaims`, `resolveAttrs`, the constants `LIGHTDASH_GROUPS_PER_USER` and `LIGHTDASH_TIMEOUT_MS`, and the
    types `EngineSession`, `EngineQueryOptions`, `MappedUser`, `UserResolver`, `McpRequestContext`, `ServerDeps`.
- Unit tests: `src/engine/session.test.ts` covers the SET order and token/timeout guards, the per-query fresh nonce
  with a single resolve, the audit pass-through, `emailFromClaims` and `resolveAttrs`.
- Tested as a user: `../tmp/engine-session-ut/run.mts`. Run it from the repo root with
  `node_modules/.bin/tsx <that file> packages/telemetry-mcp` (absolute paths). It starts `dist/main.js` against the
  acceptance fake engine and fake Lightdash (imported read-only) and a local JWKS, then connects the SDK
  streamable-HTTP client with an RS256 bearer and `MCP_STATEMENT_TIMEOUT_MS=12345`.
  - After initialize: 0 engine connections, 0 Lightdash lookups.
  - Two `list_sources` calls each succeeded on their own connection (ids 1, 2). Each connection ran
    `SET hrx.identity`, then `SET statement_timeout = 12345`, then the catalog query.
  - Login was `lightdash-operations`/`operations`.
  - Each token verified under the secret with the mapped sub/email/org/project, attrs `platform_read` (direct) and
    `platform_explain` (group), `agent true`, a 60 s lifetime, and different nonces.
  - Afterwards: 0 open connections, 2 in total.
  - An unmapped email got `isError` with no new engine connection.
  - SIGTERM exits 0.
  - Results: the check passes (3/3), the 9 previously passing acceptance files plus engine-session, user-mapping and
    user-attributes pass (12 files, 49 tests), unit tests pass (41), and typecheck is clean.
- 2026-11-08T16:14:31Z supervisor: mcp-engine-session passed the gate in round 1

## mcp-user-mapping (2026-11-08)

- Checked and hardened, not rewritten: `src/auth/userMapping.ts` came in with `mcp-engine-session`, and the check
  (`user-mapping.test.ts`, 3/3) already passed on a clean tree. Production code is unchanged.
- Pagination checked: Lightdash's `GET /api/v1/org/users` paginates only when both `pageSize` and `page` are given
  (`packages/backend/src/controllers/organizationController.ts`). The resolver sends neither, so it gets every match
  for the search in one response.
- New `src/auth/userMapping.test.ts` (6 unit tests, stubbed `fetch` with a substring search like the real one). It covers:
  - a decoy listed first whose email contains the claim;
  - an email-shaped `sub` in different case, returning Lightdash's spelling of the email;
  - `ApiKey <token>` on both calls, plus the `searchQuery`/`includeGroups` params;
  - inactive exact matches and substring-only matches rejected;
  - no Lightdash call when the token has no email;
  - the HTTP-error and network-error texts.
- Tested as a user: `../tmp/user-mapping-ut/run.mts`. Run it from the repo root with
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs real `dist/main.js` with the SDK
  streamable-HTTP client against the fake Lightdash and fake engine. Fake Lightdash users, in order: decoys
  `x.analyst@…` and `analyst@example.test.decoy`, then the target.
  - An `email` claim gave an identity token with the target's uuid, email, org and project, `platform_read`
    (direct) and `platform_explain` (group).
  - `sub=Analyst@Example.TEST` with no email claim gave the same user.
  - A substring-only email got `isError` ("no active Lightdash user…") and opened no engine connection.
  - A non-email `sub` got `isError` ("no email…").
  - All 5 Lightdash requests carried `ApiKey <service token>`.
  - SIGTERM exits 0.
- Results: the check passes 3/3, unit tests pass (47), typecheck is clean, and 13 acceptance files pass. Every
  other failing file belongs to an unbuilt feature.
- Still open, unchanged: the TTL cache (`mcp-user-mapping-cache`) and the empty tool list for unknown users
  (`mcp-unknown-user-no-tools`).
- 2026-11-08T16:19:54Z supervisor: mcp-user-mapping passed the gate in round 1

## mcp-user-attributes (2026-11-08)

- The check (`user-attributes.test.ts`, 3/3) already passed on a clean tree with the `resolveAttrs` that came in with
  `mcp-engine-session`. I compared it with Lightdash's own resolution
  (`packages/backend/src/models/UserAttributesModel.ts`, `getAttributeValuesForOrgMember`) and found two gaps, now fixed
  in `src/auth/userMapping.ts`:
  - Lightdash resolves a value **set**: the user's direct values together with the values of all their groups, and it
    uses the defaults only when that set is empty. The old code let a direct value shadow groups, and fell back to the
    default when a group had a non-"true" value. So a group set to `"false"` over a default of `"true"` gave true;
    Lightdash gives false. That is now false.
  - The API sends canonical `values` / `attributeDefaults` arrays plus the deprecated `value` / `attributeDefault`
    fields. Only the deprecated ones were read. Both are read now, with the same precedence as `getUserAttributeValues`
    and `getAttributeDefaultValues` in `packages/common/src/types/userAttributes.ts`.
- **Contract assumption (CONTRACTS §3, "the value `"true"` is true; anything else is false"):** an attr is true only
  when the resolved set is exactly `{"true"}`. A conflicting set such as direct `"false"` plus group `"true"`, or
  `["true","x"]`, is false. This is the least-privilege reading. The same `"true"` from several sources is still one
  value. The integration line should confirm it.
- New `src/auth/resolveAttrs.test.ts` (4 unit tests) covers:
  - `values` arrays and the legacy fields;
  - defaults used only when nothing is assigned;
  - groups the user is not in being ignored;
  - case and whitespace variants being false;
  - conflicting sets being false;
  - malformed entries.

  I also retitled the `resolveAttrs` test in `src/engine/session.test.ts`; its assertions are unchanged.
- Tested as a user: `../tmp/user-attributes-ut/run.mts`. Run it from the repo root with
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs real `dist/main.js` with the SDK
  streamable-HTTP client and calls `list_sources`, then verifies the identity token the fake engine got.
  - ops (platform_read via a group, platform_explain direct, platform_write `"yes"`, telemetry_restricted by default)
    got `{telemetry_restricted true, platform_read true, platform_write false, platform_explain true}`.
  - plain (no values) got only the default: `telemetry_restricted true`, the rest false.
  - optout (group `"false"` over default `"true"`) got all four false.
  - Lightdash was read at `/api/v1/org/users` and `/api/v1/org/attributes`. SIGTERM exits 0.
- Results: the check passes 3/3, unit tests pass (51), typecheck is clean, and the same 13 acceptance files pass as
  before the change. The 40 failing files belong to unbuilt features.
- 2026-11-08T16:24:23Z supervisor: mcp-user-attributes passed the gate in round 1

## mcp-unknown-user-no-tools (2026-11-08)

- `src/mcp/server.ts`, `serveMcpRequest`: the POST body is now read before the transport sees it (new
  `src/mcp/requestBody.ts`, 4 MiB like the SDK, 413 over that) and handed over as `parsedBody`, which the SDK
  supports. If the body has a `tools/list` or `tools/call` request, the Okta claims are mapped to the Lightdash
  user first, once per request: the gate and the engine session share one memoised resolver. If the mapping fails,
  the request goes to `createNoToolsServer(reason)`. That server has the same name and the tools capability, its
  `tools/list` returns `[]`, and every `tools/call` returns `isError` with "No tools are available: <fixed
  UserMappingError sentence>". This happens before any engine connection. The cases covered are no email, no
  active user with that email (unknown or deactivated), and Lightdash unreachable or non-2xx. Lightdash being
  down fails closed too. Errors that are not a `UserMappingError` get a generic sentence.
- `initialize`, `ping` and notifications still cost no Lightdash call. A body that is not JSON is passed to the
  transport as raw text, and the transport answers 400 -32700. The 406 and 415 checks still run in the transport
  as before.
- Decision: I chose to read the body in advance rather than wrap McpServer's tools handlers. Wrapping them would
  need SDK private fields (`_requestHandlers`, `_registeredTools`). The cost is that each tools/list now does a
  Lightdash lookup (2 requests), until `mcp-user-mapping-cache` adds the TTL cache. That feature should cache
  inside `createLightdashUserResolver`, or wrap `context.users`; the gate picks it up either way.
- Unit tests: `src/mcp/requestBody.test.ts` (new) and a no-tools-server case in `src/mcp/server.test.ts`. 58 unit
  tests pass and typecheck is clean.
- Tested as a user: `../tmp/unknown-user-ut/run.mts`. Run it from the repo root with
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It starts real `dist/main.js` with the SDK
  streamable-HTTP client, the fake Lightdash and the fake engine.
  - The unknown email, the deactivated user and the opaque sub with no email each got: ping ok, `tools: []`, and
    `list_sources` `isError` with the reason. The engine connection count stayed at 0.
  - initialize plus ping made 0 Lightdash requests.
  - The known user then got `["list_sources"]`, a successful call, and 1 engine connection. SIGTERM exits 0.
- Results: the check passes 5/5. 14 acceptance files pass: the earlier 13 plus this one. The 39 failing files
  belong to unbuilt features.
- 2026-11-08T16:31:32Z supervisor: mcp-unknown-user-no-tools passed the gate in round 1

## mcp-user-mapping-cache (2026-11-08)

- New `src/auth/userCache.ts`, `createCachedUserResolver(inner, ttlMs, now)`, wraps the Lightdash resolver in
  `startServer` (`src/http/server.ts`) using `config.userCacheTtlMs` (`MCP_USER_CACHE_TTL_MS`, default 60000) and the
  server clock `deps.now`. It is exported from `src/index.ts`. `createLightdashUserResolver` itself is unchanged; only
  its header comment changed.
- Behaviour:
  - Successful mappings are cached by lower-cased email (`emailFromClaims`) until `now() >= storedAt + ttl`. After that
    the next request looks the user up again (users + attributes), so attribute changes apply within one TTL.
  - Concurrent lookups for one email share one in-flight request.
  - Expired entries are pruned on every insert.
  - Decision: failures (unknown, deactivated, Lightdash down) are not cached. A newly added user works on the next
    request, and an outage is not remembered. The cost: an unknown user costs a Lightdash call per tools request.
  - Claims without an email go straight to the inner resolver, which refuses them. TTL 0 turns the cache off.
  - The per-request `onceResolver` in `src/mcp/server.ts` is still there, unchanged.
- Unit tests: `src/auth/userCache.test.ts` covers TTL boundary, case-insensitive key, per-user separation, concurrent
  sharing, failures not cached, no-email pass-through, and TTL 0. 64 unit tests pass and typecheck is clean.
- Tested as a user: `../tmp/user-cache-ut/run.mts`. Run it from the repo root with
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs real `dist/main.js` with
  `MCP_USER_CACHE_TTL_MS=1500` and a fresh SDK client and token per call.
  - Three `list_sources` calls made 1 Lightdash user lookup, with platform_read true.
  - After the attribute default changed to false, a call within the TTL still showed true, with 1 lookup.
  - After 1.7 s, a call made 2 lookups, and the identity token had platform_read false. SIGTERM exits 0.
- Results: the check passes 2/2. 15 acceptance files pass: the earlier 14 plus this one. The 38 failing files belong
  to unbuilt features.
- 2026-11-08T16:34:44Z supervisor: mcp-user-mapping-cache passed the gate in round 1

## mcp-tool-query-promql (2026-11-08)

- New `src/tools/queryPromql.ts` (`registerQueryPromql`, `buildPromqlQuery`) is registered in `createMcpServer`
  (`src/mcp/server.ts`).
  - A range query sends `SELECT * FROM promql($1, $2, $3, $4[, $5])` with params query, start, end, step[, source].
  - With `at`, it sends `SELECT * FROM promql_instant($1, $2[, $3])`.
  - Every value is a bind parameter. Times are sent as `toISOString()` (UTC, with ms).
- New shared `src/tools/telemetryArgs.ts`, for the later query tools (logql, cloudwatch, traces) to reuse:
  - `ToolInputError`. Refused arguments become an `isError` result before any engine connection.
  - `parseDuration`: the Prometheus grammar `y w d h m s ms`, in order, not zero.
  - `parseInstant` / `parseRange`: strict ISO-8601 that needs `Z` or an offset when a time is given. A date alone is
    UTC midnight. Impossible dates are refused, and so is end before start.
  - `sourceParams`: the source must be an `MCP_SOURCES` entry of the tool's kind. It is passed only when given.
  - `placeholders`, `tableResult`: Date cells become ISO strings, json cells stay parsed objects, `rowCount` =
    rows.length, `truncated: false`.
  - `successResult` / `failureResult`: engine errors give "<what> failed: <engine message> (SQLSTATE x)".
- Decision: `zod@4.6.6` is now a direct dependency for the tool input schemas. It was already in the lockfile as the
  SDK's required peer, and it was added offline, so the lockfile only gains the importer entry. Use
  `import { z } from 'zod'` with `registerTool({ inputSchema: { … } })` in later tools.
- Contract reading: an argument mix (`at` together with start/end/step, or an incomplete range) is refused. A missing
  `query` is a zod violation and surfaces as JSON-RPC -32602, which the harness accepts.
- Left for later features, on purpose:
  - `now`/`now-1h` (mcp-time-inputs: extend `parseInstant`, using `deps.now`, which is not wired into
    `createMcpServer` yet).
  - The row cap and `truncated` (mcp-row-cap: change `tableResult`).
  - The output cap.
  - SQLSTATE wording (mcp-engine-error-mapping: change `failureResult`).
  - Logs.
- Unit tests: `src/tools/queryPromql.test.ts`. 97 unit tests pass and typecheck is clean.
- Tested as a user: `../tmp/promql-ut/run.mts`. Run it from the repo root with `node_modules/.bin/tsx <abs path>
  $PWD/packages/telemetry-mcp`. It runs real `dist/main.js` with an RS256 token, the fake Lightdash and the fake
  engine.
  - tools/list shows `query_promql` with inputs query/start/end/step/at/source and readOnlyHint.
  - The range call: the engine got an extended `promql($1..$4)` with the PromQL, both instants and `1m` as params,
    after SET hrx.identity. The result had columns timestamp,value,labels,series, rowCount 2, truncated false.
  - With source: `$5` = prometheus-production.
  - With `at`: `promql_instant($1, $2)`, rowCount 1.
  - A bad step, a loki source, at mixed with step, and a missing query each gave an error, with no engine query.
    SIGTERM exits 0.
- Results: the check passes 5/5. 16 acceptance files pass: the earlier 15 plus this one. The 37 failing files belong
  to unbuilt features.
- 2026-11-08T16:39:43Z supervisor: mcp-tool-query-promql passed the gate in round 1

## mcp-time-inputs (2026-11-08)

- `src/tools/telemetryArgs.ts`:
  - `parseInstant(argument, value, now)` now accepts `now` and `now-<duration>` (case-insensitive, trimmed) as well as
    the strict ISO-8601 from before. The duration uses the same Prometheus grammar as `step`, and zero is refused.
  - New `durationMs`: y = 365 d, w = 7 d, d, h, m, s, ms.
  - `parseRange(start, end, now)` resolves both ends against the same `now`, so `now-1h`..`now` is exactly one hour
    and end before start is still refused.
  - Anything else (`now+1h`, `now - 1h`, `now-1.5h`, `yesterday-ish`, impossible dates) is a `ToolInputError`. The
    tool returns an `isError` result before any engine connection.
- Wiring: `McpServerDeps` now has a required `now: () => number`. `serveMcpRequest` passes `context.now`, the clock
  the harness injects as `deps.now`. `registerQueryPromql(server, config, engine, now)` reads `now()` once per call.
  `buildPromqlQuery(config, args, now)` takes the epoch ms.
- Later query tools (logql, cloudwatch, traces) should take `now` the same way and call `parseRange`/`parseInstant`
  with it.
- Contract reading: CONTRACTS §2 rounds relative ranges down to the refresh interval, but that rule is for the
  Dashboard Time Range. MCP time arguments get no rounding: the acceptance test expects exactly now - 1h. `now+…` is
  not accepted, which is the narrowest reading.
- Tool input descriptions for start/end/at now mention `now` and `now-<duration>`.
- Unit tests: added to `src/tools/queryPromql.test.ts`. 116 unit tests pass and typecheck is clean.
- Tested as a user: `../tmp/time-inputs-ut/run.mts`. Run it from the repo root with `node_modules/.bin/tsx <abs path>
  $PWD/packages/telemetry-mcp`. It runs real `dist/main.js` on the real wall clock, with an RS256 token, the fake
  Lightdash and the fake engine.
  - `now-1h`/`now` sent ISO params exactly 3600 s apart, inside the call's wall-clock window.
  - `now-2d`/`now-30m` resolved to -172800 s and -1800 s.
  - `at: now-15m` went to `promql_instant`.
  - ISO with an offset still works.
  - `yesterday-ish`, `now`..`now-1h`, `2026-13-45T99:00:00Z` and `now+1h` each gave an error, and the engine got no
    query. SIGTERM exits 0.
- Results: the check passes 3/3. 17 acceptance files pass: the earlier 16 plus this one. The 36 failing files belong
  to unbuilt features.
- 2026-11-08T16:42:50Z supervisor: mcp-time-inputs passed the gate in round 1

## mcp-engine-error-mapping (2026-11-08)

- New `src/engine/errors.ts`:
  - `engineErrorText(err, what)` maps SQLSTATEs to tool error text.
    - `42501`: "Access denied: …" keeps the engine's message, which names the missing claim, and tells the caller to
      ask a Lightdash admin. The other §1.2 `42501`, "audited query requires a description", gets advice about the
      description instead of a claim.
    - `54000`: "Result too large: …" with advice to narrow the query: a shorter range, a coarser step, more specific
      filters or labels, or an aggregation.
    - `58000`: "Audit write failed: …", result withheld, no rows.
    - Any other SQLSTATE: `<what> failed: <message> (SQLSTATE x)`. No SQLSTATE: `<what> failed: <message>`.
  - `redactSecrets(text, secrets)` replaces each given secret (longest first) and every token-shaped string
    (`eyJ…` plus one or two segments, which covers §3 identity tokens and JWTs) with `[redacted]`. It also cuts the
    message at 500 characters.
- `createEngineClient(engine, session, secrets = [])`:
  - It redacts every engine message against the identity token it just sent, `engine.pgPassword` and `secrets`.
  - `serveMcpRequest` passes `identitySecret`, the Lightdash API token and the Anthropic key as `secrets`.
  - The driver's non-SQLSTATE errors still become the fixed "could not reach the Federation Engine".
- `failureResult` (every query tool) and the `list_sources` Ops Marts error both use `engineErrorText`. Error results
  never carry `structuredContent`, so a 58000 can never return rows.
- Later tools: call `failureResult(err, 'The LogQL query')` and so on, and the mapping comes for free. New SQLSTATEs go
  into `engineErrorText`.
- Contract reading: §1.1 (54000), §1.2 (42501) and §6 (58000) fix only the codes and the engine messages. The tool
  wording is mine. The engine's message is shown after redaction, because for 42501 it is the only place that names
  the claim.
- Unit tests: `src/engine/errors.test.ts`. 125 unit tests pass and typecheck is clean.
- Tested as a user: `../tmp/error-mapping-ut/run.mts`. Run it from the repo root with `node_modules/.bin/tsx <abs
  path> $PWD/packages/telemetry-mcp`. It runs real `dist/main.js` with an RS256 token, the fake Lightdash and the fake
  engine.
  - 42501, the audit-description 42501, 54000, 58000 and XX000 each gave the expected `isError` text, with no
    structuredContent.
  - A hostile engine message that echoed the identity token, the pg password, the identity secret and the Lightdash
    token came back with all four `[redacted]`.
  - A normal call returned rows after each error. SIGTERM exits 0.
- Results: the check passes 5/5. 18 acceptance files pass: the earlier 17 plus this one. The 35 failing files belong
  to unbuilt features.
- 2026-11-08T16:48:49Z supervisor: mcp-engine-error-mapping passed the gate in round 1

## mcp-row-cap (2026-11-08)

- New dependency `pg-cursor@2.10.0` with `@types/pg-cursor@2.7.0`, the same versions as `packages/warehouses`. I
  edited `pnpm-lock.yaml` by hand: offline `pnpm add` wrote `version: 2.10.0` without the `(pg@8.13.1)` peer suffix and
  couldn't add the types package. `pnpm install --frozen-lockfile` passes on the result.
- `EngineQueryOptions.maxRows` (in `src/engine/client.ts`):
  - When it is set, the statement runs as a pg-cursor portal and a single Execute fetches `maxRows + 1` rows (§1
    `max_rows` portal fetch). The extra row only decides `truncated`, so the server never pulls a large result in full.
  - The portal is closed and then the connection is ended, as before.
  - Without `maxRows`, the old plain query runs. `list_sources` still uses it, because the Ops Marts list is small.
- `EngineResult` now carries `truncated: boolean`. `tableResult` passes it through, so `rowCount` is the number of rows
  returned and is never more than the cap.
- `query_promql` passes `{ maxRows: config.maxRows }`, and its description tells the agent what `truncated` means.
  **Later query tools must also pass `{ maxRows: config.maxRows }` to `engine.query`.** Without it, their results are
  not capped.
- Contract reading: §1.1's engine `max_rows`, which is 100000 and raises a 54000 error, is a different limit. That is
  the engine's hard cap, and it still maps to "Result too large" (mcp-engine-error-mapping). `MCP_MAX_ROWS` is the
  MCP's own soft cap: it truncates silently and sets the flag. A cap of exactly as many rows as the result has gives
  `truncated: false`.
- Unit tests: `tableResult` passes the flag through. A test mock gained `truncated`. 126 unit tests pass and
  typecheck is clean. Note that tsconfig does not typecheck `*.test.ts`.
- Tested as a user: `../tmp/row-cap-ut/run.mts`. Run it from the repo root with `node_modules/.bin/tsx <abs path>
  $PWD/packages/telemetry-mcp <MCP_MAX_ROWS>`. It runs real `dist/main.js` with an RS256 token, the fake Lightdash and
  the fake engine.
  - With a cap of 50:
    - The 120-row range query gave 50 rows, rowCount 50, truncated true, values 0..49.
    - The 3-row instant query gave 3 rows and truncated false.
  - A cap of 120 gave 120 rows and false.
  - A cap of 1 gave 1 row and true.
  - SIGTERM exits 0.
- Results: the check passes 2/2. 19 acceptance files pass: the earlier 18 plus this one. The 34 failing files belong
  to unbuilt features. `output-size-cap` fails because `query_logql` doesn't exist yet.
- 2026-11-08T16:55:18Z supervisor: mcp-row-cap passed the gate in round 1

## mcp-tool-query-logql (2026-11-08)

- New `src/tools/queryLogql.ts`, registered in `src/mcp/server.ts` and exported from `src/index.ts`
  (`QUERY_LOGQL_TOOL`, `buildLogqlQuery`, `QueryLogqlArgs`).
  - Without `step`, it runs `logql(query, start, end[, limit, direction, source])`. With `step`, it runs
    `logql_metric(query, start, end, step[, source])` (§1.1). Every value is a bind parameter, and `limit` is sent as
    its decimal string.
  - It reuses `parseRange`, `parseDuration`, `sourceParams` (kind `loki`), `failureResult(err, 'The LogQL query')` and
    `{ maxRows: config.maxRows }`.
- Contract reading (Contract assumptions):
  - §1.1's `limit` and `direction` are positional. Optional arguments are sent up to the last one the caller gave, and
    any gap is filled with the contract defaults, 1000 and `backward`. For example, a `source` with no limit or
    direction sends `1000, 'backward', source`. Arguments after the last given one are left for the engine to default.
  - `limit` must be an integer from 1 to 2147483647, because it is a Postgres int. `direction` must be `forward` or
    `backward`. The zod schema rejects other values, and the SDK 1.31 returns those as `isError` tool results
    (-32602 text), not as thrown errors. `buildLogqlQuery` checks the same rules again.
  - Combining `limit` or `direction` with `step` is refused, because `logql_metric` takes neither argument.
- Restricted Telemetry is enforced by the engine. The tool does no restricted-selector checks of its own.
  `restricted-telemetry.test.ts` now passes, because the engine fake's 42501 maps through `failureResult`.
- Unit tests are in `src/tools/queryLogql.test.ts`. 143 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/logql-ut/run.mts`. Run it from the repo root as `node_modules/.bin/tsx <abs path>
  $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` with an RS256 token, the fake Lightdash and the fake
  engine, with `MCP_MAX_ROWS=50`.
  - A log query with limit 50 and direction forward ran `logql($1..$5)` with params [query, start, end, '50',
    'forward'] and returned the columns timestamp, line, labels and stream.
  - A query with `now-1h` and a source got the defaults filled in.
  - A query with `step=5m` ran `logql_metric($1..$4)` and returned timestamp, value, labels and series.
  - A bad direction, a limit of -1, 'ten' or 0, step combined with limit, and a prometheus source each gave
    `isError`. None of them sent an engine query. SIGTERM exits 0.
- Results: the check passes 3/3. 21 acceptance files pass. That is the earlier 19, plus this feature's file and
  restricted-telemetry.
  - `output-size-cap` still fails. It needs `MCP_MAX_OUTPUT_BYTES`, which is its own feature.
  - In `sql-injection-safety`, the logql cases pass. Its cloudwatch and traces cases are unbuilt.
- 2026-11-08T17:01:06Z supervisor: mcp-tool-query-logql passed the gate in round 1

## mcp-output-size-cap (2026-11-08)

- New `capTableBytes(table, maxBytes)` in `src/tools/telemetryArgs.ts`, exported from `src/index.ts`.
  `successResult(table, maxBytes)` now requires the cap. `query_promql` and `query_logql` pass
  `config.maxOutputBytes` (`MCP_MAX_OUTPUT_BYTES`, default 200000). The tool descriptions now say "row or size cap".
  - It keeps the longest prefix of rows whose JSON fits. Rows keep the engine order. It sets `rowCount` to the rows
    kept and `truncated: true` whenever any row was dropped. The size is computed in UTF-8 bytes: the empty-rows table
    JSON, plus each row's JSON, plus the commas. Each row is serialised once, so there is no repeated stringify. A table
    that already fits is returned unchanged, keeping the engine's own `truncated` flag.
  - The text content is `JSON.stringify(structuredContent)`, so one size check covers both.
  - Decision: if not even an empty table fits (a tiny cap), the result is `isError` "The result is too large to return
    even without rows (MCP_MAX_OUTPUT_BYTES)". It is not an over-cap success.
- Contract assumption: only the query tools' table results are capped, because §"Row cap / Output cap" names row
  dropping. `list_sources` output is not row-shaped and has no `truncated` field, so it is left as is.
  - Next sessions: new tools that return a `TableResult` must call `successResult(table, config.maxOutputBytes)`.
  - Tools with other shapes (alert_state `{results}`) need their own byte check if their output can grow.
- Unit tests are in the new `src/tools/telemetryArgs.test.ts`. They cover an exact-boundary prefix for every k, UTF-8
  bytes, an oversized middle row, and the no-fit error. 150 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/output-cap-ut/run.mts`. Run it from the repo root as `node_modules/.bin/tsx <abs path>
  $PWD/packages/telemetry-mcp <MCP_MAX_ROWS> <MCP_MAX_OUTPUT_BYTES>`. It runs the real `dist/main.js`, the fake engine
  with 500 log lines of about 370 B each, and the fake Lightdash.
  - Rows 1000, bytes 20000: 47 rows, 19867 B structured and text, rowCount 47, truncated true. The rows are an in-order
    prefix.
  - Rows 1000, bytes 200000: 473 rows, 199587 B.
  - Rows 10, bytes 200000: 10 rows, truncated true, from the row cap.
  - Rows 1000, bytes 300: 0 rows, truncated true.
  - Bytes 1: isError.
  - A 1-row metric query is never truncated. SIGTERM exits 0.
  - Trap: in zsh, `$a` with a space doesn't word-split. Pass the script's args separately.
- Results: the check passes 1/1. 22 acceptance files pass: the earlier 21 plus this one. The 31 failing files belong
  to unbuilt features.
- 2026-11-08T17:11:11Z supervisor: mcp-output-size-cap passed the gate in round 1

## mcp-tool-query-cloudwatch (2026-11-08)

- New `src/tools/queryCloudwatch.ts`. It is registered in `src/mcp/server.ts` after `query_logql`, and
  `src/index.ts` exports `QUERY_CLOUDWATCH_TOOL`, `buildCloudwatchQuery`, `checkMetricDataQuery` and `QueryCloudwatchArgs`.
  - Inputs: `metric_data_query` (zod `record(string, unknown)`), `start`, `end`, and an optional `source` that must name
    a `cloudwatch` kind source.
  - SQL: `SELECT * FROM cloudwatch($1::json, $2, $3[, $4])`. `$1` is `JSON.stringify(metric_data_query)`, which equals
    the input object. Start and end go through `parseRange`. The result goes through
    `successResult(table, config.maxOutputBytes)`, so the row cap and byte cap apply.
  - Validation happens before any engine connection. It gives `ToolInputError`, which surfaces as `isError`.
    - Non-objects (array, string, null) are refused by the SDK's zod check. That is a -32602 "Input validation error"
      result with `isError`, the same path as logql's bad limit.
    - An object needs a non-empty string `Id` and exactly one of `MetricStat` (an object) or `Expression` (a non-empty
      string). That is the CloudWatch API rule. Every other key passes through untouched.
  - Contract assumption: no check on the CloudWatch Id pattern (`^[a-z][a-zA-Z0-9_]*$`), and none on
    Period, Stat or Label. The engine and CloudWatch judge those.
- Unit tests: `src/tools/queryCloudwatch.test.ts`. 165 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/cloudwatch-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` with an RS256 token,
  the fake Lightdash and the fake engine.
  - tools/list shows query_cloudwatch as readOnly.
  - A MetricStat query with a hostile dimension value sent one extended-protocol `cloudwatch($1::json, $2, $3)`. The
    JSON parameter equalled the input, and the SQL had none of the input text. It returned the Time series rows with
    series "queue depth".
  - An expression query with `now-1h`/`now` and a source sent `$4`.
  - These gave `isError` with no engine query: [1,2], a string, null, {Stat}, {Id} alone, an empty Id, a loki source,
    and end before start. SIGTERM exits 0.
- Results: the check passes 3/3. 23 acceptance files pass: the earlier 22 plus this one. `sql-injection-safety` now
  fails only on its cloudwatch_logs and search_traces cases, which are unbuilt features.
- 2026-11-08T17:17:09Z supervisor: mcp-tool-query-cloudwatch passed the gate in round 1

## mcp-tool-query-cloudwatch-logs (2026-11-08)

- New `src/tools/queryCloudwatchLogs.ts`. It is registered in `src/mcp/server.ts` after `query_cloudwatch`, and
  `src/index.ts` exports `QUERY_CLOUDWATCH_LOGS_TOOL`, `buildCloudwatchLogsQuery`, `joinLogGroups` and
  `QueryCloudwatchLogsArgs`.
  - Inputs: `log_groups` (zod `array(string).min(1)`), `query`, `start`, `end`, and an optional `source` that must name a
    `cloudwatch_logs` kind source.
  - SQL: `SELECT * FROM cloudwatch_logs($1, $2, $3, $4[, $5])`, following CONTRACTS §1.1. `$1` is the log groups
    comma-joined, exactly as given (no trimming). `$2` is the Insights query. Start and end go through `parseRange`. The
    result goes through `successResult(table, config.maxOutputBytes)`.
  - Refused before any engine connection:
    - An empty list. The SDK zod `min(1)` gives -32602 with `isError`.
    - A non-array.
    - An empty or whitespace-only group, or a group containing a comma. The comma rule exists because the engine
      splits on commas. These are `ToolInputError`.
    - An empty query, a wrong-kind or unknown source, and bad ranges.
  - Contract assumptions:
    - No cap on the number of log groups. CloudWatch allows 50 per query, and the engine and CloudWatch judge that.
    - No log-group name pattern check.
    - Restricted log groups (`restricted_log_groups`) are not handled here. That belongs to the restricted-telemetry
      feature, which must also cover this tool.
- Unit tests: `src/tools/queryCloudwatchLogs.test.ts`. 175 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/cloudwatch-logs-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` with an RS256 token,
  the fake Lightdash and the fake engine.
  - tools/list shows query_cloudwatch_logs as readOnly, with log_groups, query, start and end required.
  - Two groups and a hostile query sent one extended-protocol `cloudwatch_logs($1, $2, $3, $4)`. `$1` was
    `/aws/lambda/orders-worker,/aws/lambda/fills-worker`, and `$2` was the query. The SQL had no input text. It returned
    columns timestamp, message and fields, with fields as a JSON object.
  - `now-1h`/`now` with a source sent `$5`.
  - These gave `isError` with 0 engine queries: [], a comma group, "", a string, a missing log_groups, a blank query, a
    cloudwatch (metrics) source, and end before start. SIGTERM exits 0.
- Results: the check passes 2/2. 24 acceptance files pass: the earlier 23 plus this one. `sql-injection-safety` now
  fails only on its search_traces case. `tool-catalog` still fails until every contract tool exists.
- 2026-11-08T17:21:04Z supervisor: mcp-tool-query-cloudwatch-logs passed the gate in round 1

## mcp-tool-search-traces (2026-11-08)

- New `src/tools/searchTraces.ts`. It is registered in `src/mcp/server.ts` after `query_cloudwatch_logs`, and
  `src/index.ts` exports `SEARCH_TRACES_TOOL`, `TRACEQL_DEFAULT_LIMIT`, `TRACEQL_MAX_LIMIT`, `buildTraceqlQuery` and
  `SearchTracesArgs`.
  - Inputs: `query`, `start`, `end`, an optional `limit` (zod `int().min(1).max(1000)`), and an optional `source` that
    must name a `tempo` kind source.
  - SQL: `SELECT * FROM traceql($1, $2, $3[, $4[, $5]])`, following CONTRACTS §1.1. The limit is sent as the string
    `'10'` and so on. With no limit and no source, it is left to the engine default (20). With a source but no limit,
    the contract default `'20'` fills the positional gap. The result goes through `successResult(table, config.maxOutputBytes)`.
  - Refused before any engine connection: a limit outside 1..1000 or not a whole number (the SDK zod gives -32602 with
    `isError`, and `buildTraceqlQuery` checks again for direct callers), an empty query, a wrong-kind or unknown
    source, and bad ranges.
  - Contract assumptions: §1.1 gives `limit int = 20` but no upper bound. The 1..1000 range comes from the feature steps
    and the acceptance test, and it applies to this tool only. The engine may have its own cap. TraceQL syntax is not
    checked here; the engine and Tempo judge it.
- Unit tests: `src/tools/searchTraces.test.ts`. 187 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/traces-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` with an RS256 token,
  the fake Lightdash and the fake engine, with a `tempo-production` source added to MCP_SOURCES.
  - tools/list shows search_traces as readOnly, with query, start and end required.
  - A hostile TraceQL query with limit 10 sent one extended-protocol `traceql($1, $2, $3, $4)`, with the query as `$1`
    and `'10'` as `$4`. The SQL had no input text. It returned trace_id, root_service, root_name, start, duration_ms and
    span_count.
  - With no limit, it sent `$1..$3`. With only a source, it sent `$5` with `'20'` as `$4`.
  - These gave `isError` with 0 engine queries: limit 1001, 100000, 0, 2.5 and "10", a blank query, a missing query, a
    loki source, an unknown source, and end before start. SIGTERM exits 0.
  - Note: int8 `span_count` comes back as a JSON string ("42"), the same as other int8 columns in earlier tools.
- Results: the check passes 2/2. 26 acceptance files pass: the earlier 24, this one, and `sql-injection-safety`, which
  now passes fully. `tool-catalog` still fails until every contract tool exists. `get_trace` is the next feature.
- 2026-11-08T17:24:21Z supervisor: mcp-tool-search-traces passed the gate in round 1

## mcp-tool-get-trace (2026-11-08)

- New `src/tools/getTrace.ts`. It is registered in `src/mcp/server.ts` after `search_traces`, and `src/index.ts` exports
  `GET_TRACE_TOOL`, `TRACE_ID_PATTERN`, `buildTraceQuery` and `GetTraceArgs`.
  - Inputs: `trace_id` (required) and an optional `source` that must name a `tempo` kind source.
  - SQL: `SELECT * FROM trace($1[, $2])`, following CONTRACTS §1.1. The id is always a bind parameter and is sent as
    given, with no case change. The result goes through `successResult(table, config.maxOutputBytes)`, so the row and
    size caps apply, and the root span's null `parent_span_id` stays null.
  - Refused before any engine connection: a `trace_id` that is not `^[0-9a-fA-F]{16,32}$` (non-hex, injection text,
    40 hex, empty), a missing or non-string id (SDK zod -32602 with `isError`), and a wrong-kind or unknown source.
  - Contract assumptions: §1.1/§7 give no id format. The 16-32 hex rule comes from the acceptance test, which matches
    Tempo's 64-bit and 128-bit ids. Upper-case hex is accepted.
- Unit tests: `src/tools/getTrace.test.ts`. 198 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/get-trace-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` on port 18993 with an
  RS256 token, the fake Lightdash and the fake engine.
  - tools/list shows get_trace as readOnly, with trace_id required.
  - A 32-hex id sent one extended-protocol `trace($1)` with the id only in params. All 3 spans came back, with the root's
    parent_span_id null and the attributes as JSON. A 16-hex id with a source sent `trace($1, $2)`.
  - These gave `isError` with 0 engine queries: `xyz`, `4bf92f35'); --`, a 40-hex id, "", a missing id, a number, a loki
    source and an unknown source. SIGTERM exits 0.
  - Trap: something else was already listening on 127.0.0.1:18987, the port the earlier `traces-ut` script uses (pid
    64110 at the time). The server then failed with EADDRINUSE, and the client hit that listener and got 401
    invalid_token. Pick a free port in user-test scripts.
- Results: the check passes 2/2. 27 acceptance files pass: the earlier 26 plus this one. `tool-catalog` still fails until
  every contract tool exists.
- 2026-11-08T17:28:44Z supervisor: mcp-tool-get-trace passed the gate in round 1

## mcp-sql-injection-safety (2026-11-08)

- No code change was needed. The earlier tool features built this property, and this session checked it and recorded it.
  - Audit: every telemetry tool builds `SELECT * FROM <fn>($1..$n)` from `placeholders()` or fixed `$n` text, with
    every user value in `params`. This covers promql, promql_instant, logql, logql_metric, `cloudwatch($1::json, ...)`,
    cloudwatch_logs, traceql and trace. No user text is ever placed in the SQL.
  - Every tool takes `source` through `sourceParams(config, kind, source)` in `src/tools/telemetryArgs.ts`. Unknown
    names and wrong-kind names throw `ToolInputError` before any engine connection.
  - The only interpolated literal is `SET hrx.identity = '<token>'` in `src/engine/client.ts`, because SET takes no
    bind parameters. Before interpolation the token must match `IDENTITY_TOKEN_SHAPE` (base64url `.` base64url). The
    server mints the token, so a user value never reaches it. Keep that guard if the token format changes.
- Tested as a user with `../tmp/sql-inj-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` on port 18995 with an
  RS256 token, the fake Lightdash and the fake engine.
  - All 8 hostile calls (`x'); DROP TABLE users; SELECT ('`) succeeded: promql range and instant, logql log and metric,
    cloudwatch Expression, cloudwatch_logs (in both the query and a log group), and search_traces. Each sent one
    extended-protocol query with SQL that held only `$n`, and the hostile text was in params.
  - These gave `isError` with 0 engine queries: query_promql with a hostile, unknown or loki source, and every other
    tool given a source of the wrong kind. get_trace refused a hostile trace_id through its hex rule. SIGTERM exits 0.
- Results: the check passes 8/8, and 198 unit tests pass. Acceptance: 27 files pass and 26 fail. The 26 are unbuilt
  features (ask_data, platform_*, alerts, docs, dockerfile, tool-catalog and others).
- 2026-11-08T17:32:24Z supervisor: mcp-sql-injection-safety passed the gate in round 1
- 2026-11-08T17:33:41Z supervisor: mcp-restricted-telemetry halted: worker mcp.feature.mcp-restricted-telemetry.r1 stopped: STOP file present

## mcp-restricted-telemetry (2026-11-08)

- Round 1 restarted after the earlier worker stopped on a STOP file. There was no STOP file this time, and the tree was
  clean.
- The property was already in place: `src/identity/token.ts` always mints `agent: true` (`iss = telemetry-mcp`), and
  `list_sources` reports each source's `restricted` flag from `MCP_SOURCES`. The check passed 3/3 before any change.
- Changed `src/engine/errors.ts`: a `42501` whose engine message mentions "restricted" now ends with "This is
  Restricted Telemetry, which is never readable through MCP: every MCP query identifies as an agent, so no Lightdash
  user attribute grants it here...". It used to say "ask a Lightdash admin" for the claim, which is wrong through MCP
  because a user who already holds `telemetry_restricted` is still refused. The advice now comes from a small
  `accessDeniedAdvice()` helper, and other 42501s keep the old advice.
  - Contract assumptions: §2/§7 put enforcement in the engine (§1.2 refuses Restricted Telemetry to `agent = true`).
    The MCP adds no local block for `restricted` sources. Restricted selectors and log groups
    (`restricted_selectors`/`restricted_log_groups`) are known only to the engine, so a local block would cover only
    part of it. The engine stays the single gate, and the MCP's part is `agent = true` plus a clear error.
- Unit tests: `src/engine/errors.test.ts` gained a case for the restricted 42501 text, and the generic 42501 case now
  uses `attrs.platform_read`. 199 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/restricted-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` on port 18999. The
  fake Lightdash gives the user `telemetry_restricted` and `platform_read`, and the fake engine refuses `loki-platform`
  to agent identities as §1.2 says.
  - list_sources showed `loki-platform:loki:restricted=true` and every other source `restricted=false`.
  - query_logql on `loki-platform` gave `isError`, no rows, and the access-denied text above (SQLSTATE 42501).
  - An ordinary query_logql returned 1 row. Every engine statement had `agent true` and `iss telemetry-mcp`, even with
    `attrs.telemetry_restricted true`. That covered the Ops Marts listing, logql, promql_instant and traceql.
- Traps for user-test scripts:
  - Under load (another factory line was running backend vitest), `dist/main.js` took more than 5 s to answer
    `/healthz`. Wait up to 30 s.
  - Kill the child on `process.on('exit')`. Otherwise a script that dies early leaves a server on its port that comes
    up late. The next run then reaches that stale server and gets 401 invalid_token.
  - Don't pipe the script into `head`/`tail`: the orphan inherits stderr and keeps the pipe open.
  - The fake engine tries handlers last-registered first, so register specific handlers after catch-all ones.
  - Pid 64110 (an older `dist/main.js` on 18987, not started by this session) is still running. I left it alone.
- Results: the check passes 3/3. Acceptance: 27 files pass and 26 fail. All 26 failures are unbuilt features (ask_data,
  platform_*, alerts, docs, dockerfile, readme, structured-logs, tool-catalog and others).
- 2026-11-08T17:47:47Z supervisor: mcp-restricted-telemetry passed the gate in round 1

## mcp-tool-alert-state (2026-11-08)

- New `src/lightdash/alerting.ts`: `createAlertingClient(config.lightdash)` with `.get(kind, query)`. It calls
  `GET /api/v2/projects/{LIGHTDASH_PROJECT_UUID}/alerting/state|history` with `Authorization: ApiKey <service token>`
  and returns `results` from the `{status:"ok", results}` envelope untouched (Contract assumption 2). Undefined query
  values are not sent. Failures become `AlertingError`s: "could not reach Lightdash", "HTTP <status>: <Lightdash
  error.message>" passed through `redactSecrets([apiToken])`, or "unexpected response" when the body is not the envelope.
  It reuses `LIGHTDASH_TIMEOUT_MS` from `auth/userMapping.ts`.
- New `src/tools/alertState.ts`: `alert_state` takes an optional `rule_uuid`. It is checked against `UUID_RE`, which
  `config.ts` now exports, before any Lightdash call, and is sent as `ruleUuid`. The result is `{ results }` as
  structuredContent, with its JSON as the text.
  - Decision: alert results are not row-shaped, so nothing is dropped. A result whose JSON is over
    `MCP_MAX_OUTPUT_BYTES` becomes an `isError` that suggests `rule_uuid`.
  - `alertingResult(results, maxBytes, hint)` is exported so that `alert_history` can reuse it.
- `src/mcp/server.ts`: `McpServerDeps.alerting?` is optional and defaults to `createAlertingClient(config.lightdash)`.
  `alert_state` is registered after `get_trace`.
- Next session (alert_history): reuse `alerting.get('history', { ruleUuid, from, to, limit })` and `alertingResult`.
  For from/to, use `parseInstant` + `isoParam` from `telemetryArgs.ts`.
- Unit tests: `src/lightdash/alerting.test.ts` and `src/tools/alertState.test.ts`. 212 unit tests pass, and typecheck is
  clean.
- Tested as a user with `../tmp/alert-state-ut/run.mts`. Run it from the repo root as `node_modules/.bin/tsx <abs path>
  $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` on port 18998 with an RS256 Okta token and the
  acceptance fakes.
  - tools/list showed `alert_state` with a `rule_uuid` string property.
  - A call with no arguments returned `{results:[...]}`. Lightdash saw `GET .../alerting/state` with no query string and
    the ApiKey service token.
  - A call with a `rule_uuid` showed `ruleUuid` in Lightdash's query.
  - `../../admin` returned isError "rule_uuid must be an Alert Rule uuid..." and made 0 Lightdash calls.
  - With Lightdash failing with a 503, the result was isError "The Lightdash alerting state request failed with HTTP 503:
    alerting evaluator unavailable", and the token did not appear in it.
  - The engine received 0 data queries, and SIGTERM exited 0.
- Results: the check passes 4/4. Acceptance: 28 files pass and 25 fail. All 25 failures are unbuilt features
  (alert_history, ask_data, platform_*, docs, dockerfile, readme, structured-logs, tool-catalog and others).
- 2026-11-08T17:52:40Z supervisor: mcp-tool-alert-state passed the gate in round 1

## mcp-tool-alert-history (2026-11-08)

- New `src/tools/alertHistory.ts`: `alert_history` takes optional `rule_uuid`, `from`, `to` and `limit`.
  `buildAlertHistoryQuery(args, now)` checks them all before any Lightdash call. Then it calls
  `alerting.get('history', { ruleUuid, from, to, limit })`. `from`/`to` go through `parseInstant` + `isoParam`, so
  they are sent as absolute ISO strings and `now-1d` works. The limit is sent as a string. Undefined values are not sent.
  The result goes through `alertingResult` (from `alertState.ts`) with a hint to narrow by rule, range or limit.
- Refused before Lightdash: a non-uuid `rule_uuid`; a `limit` outside 1..1000 or not a whole number (the SDK zod
  gives -32602 with isError, and `buildAlertHistoryQuery` checks again for direct callers); a bad time; and `to`
  before `from`.
  - Contract assumption: §7 / Contract assumption 2 give no limit bound and no default. The 1..1000 range is ours, and
    a missing limit is left to the Lightdash default. The integration line may align it with the alerting line's API.
- `src/mcp/server.ts`: `alert_history` is registered after `alert_state`, with the server clock `now`.
- Unit tests: `src/tools/alertHistory.test.ts`. 226 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/alert-history-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` on port 18999.
  - tools/list showed `alert_history` with its 4 properties (`limit` is an integer from 1 to 1000).
  - A call with no arguments returned `{results:[...]}`. Lightdash saw `GET .../alerting/history` with no query string
    and the ApiKey service token.
  - A filtered call sent `ruleUuid`, `from` and `to` (as ISO) and `limit` "25".
  - limit 0, a bad `from`, `to` before `from` and a bad `rule_uuid` all returned isError and made 0 Lightdash calls.
  - With Lightdash failing with a 503, the result was an isError naming HTTP 503, and the token did not leak.
  - The engine received 0 data queries, and SIGTERM exited 0.
- Results: the check passes 3/3. Acceptance: 29 files pass and 24 fail. All 24 failures are unbuilt features (ask_data,
  platform_*, docs, dockerfile, readme, structured-logs, tool-catalog, write_preview and others).
- 2026-11-08T17:56:18Z supervisor: mcp-tool-alert-history passed the gate in round 1

## mcp-tool-platform-schema (2026-11-08)

- New `src/tools/platformSchema.ts`: `platform_schema` takes optional `table_schema`, `table_name` and `description`.
  `buildPlatformSchemaQuery(args)` returns `{kind, sql, params, description}`:
  - With no `table_name`, it builds `SELECT * FROM platform_tables()` and returns `{tables:[...], rowCount, truncated}`.
  - With `table_name`, it builds `SELECT * FROM platform_columns($1, $2)` with params `[table_schema ?? 'public',
    table_name]` and returns `{columns:[...], rowCount, truncated}`.
  - It runs as an Audited Query: `engine.query(..., { maxRows, audit: { description } })`. A non-blank caller
    `description` is sent unchanged. A missing or blank one gets a generated one (Contract assumption 6):
    "MCP platform_schema: list Platform Database tables" or "...: describe the columns of one Platform Database table".
    The generated text never contains the table name, so a table name can never end up in an audit description.
  - Refused before the engine: `table_schema` without `table_name`, a blank `table_name`, a blank `table_schema`, and
    non-string values.
    - Decision: listing tables of one schema would need client-side filtering after the row cap, so a call with
      only `table_schema` is refused with a message that says to give both arguments or neither.
  - `platformSchemaResult(kind, result, maxBytes)` reuses `capTableBytes` on the table with `columns: []`. Then it
    swaps `"columns":[],"rows":` for `"<kind>":`, which is never longer, so the output cap holds. It is a few bytes more
    conservative than exact.
  - The tool does not check `platform_read` itself. The engine enforces it (§1.2), and a 42501 comes back through
    `failureResult` as "Access denied: ... Platform Database catalog read ...".
- `src/mcp/server.ts`: `platform_schema` is registered after `alert_history`.
- Unit tests: `src/tools/platformSchema.test.ts`. 238 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/platform-schema-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` on port 19001 with
  an RS256 Okta token and a fake engine that enforces `platform_read` and a non-blank description.
  - tools/list showed the 3 properties and readOnlyHint true.
  - A call with no arguments returned 3 tables from `platform_tables()` with params `[]`.
  - `ops`/`jobs` returned columns, with the engine receiving `platform_columns($1, $2)` and params `["ops","jobs"]`.
  - A call with only `table_name` sent params `["public","widgets"]`.
  - Every identity token had `audit.source` mcp and a generated description. A caller's description arrived verbatim.
  - The two refusals made 0 engine calls.
  - A user without `platform_read` got an isError 42501 "Access denied" result, and no secret leaked. SIGTERM exited 0.
- Results: the check passes 5/5. Acceptance: 30 files pass and 23 fail. All 23 failures are unbuilt features
  (ask_data, platform_query, platform_explain, write_preview, docs, dockerfile, readme, structured-logs, tool-catalog
  and others).
- 2026-11-08T18:01:07Z supervisor: mcp-tool-platform-schema passed the gate in round 1

## mcp-tool-platform-query (2026-11-08)

- New `src/tools/platformQuery.ts`: `platform_query` takes `sql` and `description` (both required in the input schema)
  and an optional `ticket`. `buildPlatformQuery(args)` returns `{sql: 'SELECT * FROM platform_query($1)', params: [sql],
  audit: {description, ticket}}`. The caller's SQL is only ever the bind parameter. The tool runs as an Audited Query:
  `engine.query(..., { maxRows, audit })`, and the result goes through `successResult(tableResult(...))`, so the row cap
  and output cap apply. Errors go through `failureResult(err, 'The Platform Database query')`. A 58000 becomes
  "Audit write failed ... withheld the result and no rows were returned" with no rows, and a 42501 becomes "Access denied".
  - Refused before the engine: a missing or blank `sql`, a missing or blank or non-string `description`, and a bad ticket.
    A missing `description` is refused by the SDK's zod validation as an isError -32602. A blank one is refused by our
    check.
  - The description is sent unchanged, not trimmed. The ticket is `null` when omitted or `null`.
  - Contract assumptions:
    - Ticket format. CONTEXT/ADR 0004 say "optional Linear ticket, validated against Linear". The MCP has no Linear
      credential, so it only checks the shape `^[A-Z][A-Z0-9]{0,9}-[1-9]\d{0,8}$` (upper-case team key, issue number
      ≥ 1). An empty string, a lower-case key and `ENG-0` are refused. Whether the issue exists in Linear is left to the
      integration line or the engine.
    - The MCP does not parse or check the SQL for being read-only. CONTRACTS §1.1/§5 put that on the engine's read-only
      role and guard. The MCP also does not check `platform_read`; the engine enforces it.
- `src/mcp/server.ts`: `platform_query` is registered after `platform_schema`.
- Unit tests: `src/tools/platformQuery.test.ts`. 252 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/platform-query-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It runs the real `dist/main.js` on port 19002 with an
  RS256 Okta token and a fake engine that enforces `platform_read` and a non-blank description, and fails with 58000
  when the SQL contains `audit_will_fail`.
  - tools/list showed props sql, description and ticket, required [sql, description], and readOnlyHint true.
  - With ticket ENG-123, the engine got `SELECT * FROM platform_query($1)` with the SQL as its only param, and the result
    had 2 rows. The audit block was `{description, ticket:"ENG-123", source:"mcp", resource_uuid:null}` and agent was true.
  - A call with no ticket sent ticket null.
  - A missing description, a blank description and a bad ticket each returned isError, with 0 engine calls.
  - A 58000 returned isError with "Audit write failed ... no rows were returned" and no structured content.
  - A user without `platform_read` got a 42501 "Access denied" result, and no secret leaked. SIGTERM exited 0.
- Results: the check passes 6/6. Acceptance: 31 files pass and 22 fail. All 22 failures are unbuilt features
  (ask_data, platform_explain, write_preview, docs, dockerfile, readme, structured-logs, tool-catalog and others).
- 2026-11-08T18:04:52Z supervisor: mcp-tool-platform-query passed the gate in round 1

## mcp-structured-logs (2026-11-08)

- New `src/log.ts`: `createLogger({level, write?, secrets?, now?})` writes one JSON object per line, as
  `{time, level, msg, ...fields}`. Lines below `LOG_LEVEL` are dropped. It writes to stdout by default, or to `deps.log`
  when given (the acceptance harness passes `deps.log`). Field values may only be scalars (string, number, boolean or
  null). Objects and arrays are dropped and never serialized. Every string goes through `redactSecrets` (the configured
  secrets plus any JWT-shaped string) and is cut to 200 characters. `configSecrets(config)` lists the secrets: identity
  secret, Lightdash API token, engine PG password and Anthropic key. A writer that throws never breaks a request.
- New `src/mcp/toolCallLog.ts`: `logToolCalls(transport, parsedBody, logger, sub, now)` wraps `transport.send`. It
  writes one `tool call` line when the JSON-RPC response for each `tools/call` id is sent. The line holds `tool`
  (`(invalid)` unless it is a plain identifier), `user` (the Okta `sub`), `durationMs`, `outcome`
  (`ok`/`error`/`rejected`) and, for JSON-RPC errors, `code`. It holds `rowCount`/`truncated` only from
  structuredContent. `ok` lines are logged at info and the others at warn.
  - Decision: it hooks the transport rather than wrapping each `registerTool` handler. That way it also logs calls the
    SDK answers itself: zod input rejections (SDK 1.31 returns them as isError results), unknown tools, and the
    no-tools server used for unmapped users.
  - Tool arguments, result content, error text and SQL are never read into a line.
- `src/http/server.ts`: `ServerDeps.log` is new, and the logger is built in `startServer`. Each request logs:
  - a 401 as warn `unauthorized request` with `reason` `missing`, `malformed` or `invalid` (the token and the verifier's
    description are not logged);
  - each finished request as debug `http request` with method, status, durationMs and path. A path that is not one of
    the server's own is logged as `(other)`, so probe URLs or query strings are never echoed;
  - an unhandled error as error `request failed` with the error *name* only;
  - startup as `telemetry-mcp listening` with `url`. This moved here from `main.ts`.
- `src/mcp/server.ts`: `McpRequestContext.logger` is new. An unmapped user logs warn `user not mapped` with the fixed
  `UserMappingError` sentence.
- `src/main.ts`: config and startup errors on stderr are now JSON lines too. Config errors name the variable and never
  echo its value.
- Contract assumptions: CONTRACTS/CONTEXT don't specify a log format, so the field names above are my own choice. The
  `user` field is the Okta `sub`, not the email, so log lines carry no staff email. Change this if ops wants email.
- Unit tests: `src/log.test.ts` and `src/mcp/toolCallLog.test.ts`. 263 unit tests pass, and typecheck is clean.
- Tested as a user with `../tmp/structured-logs-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It starts the real `dist/main.js` on port 19003 with
  LOG_LEVEL=debug and captures stdout and stderr. It then runs:
  - promql;
  - a platform_query whose SQL and result row contain a synthetic MRN and sentinels;
  - a bad time, a zod rejection, an unknown tool, an audit failure and an unknown user;
  - three 401s (junk, missing and bad-signature token) and a 404 probe with a token in the query string.
  Results: 28 lines, all JSON with level and msg, and every tool call is named. There were 0 hits for row values, SQL,
  the MRN, the access token or its signature, identity tokens or their payload, or any configured secret.
  SIGTERM exited 0.
- Results: the check passes 3/3. Acceptance: 32 files pass and 21 fail. All 21 failures are unbuilt features
  (ask_data, platform_explain, write_preview, docs, dockerfile, readme, tool-catalog and others).
- Next sessions: log through `context.logger` / `createLogger` with scalar metadata only. Never pass args, rows, SQL
  or error text.
- 2026-11-08T18:12:34Z supervisor: mcp-structured-logs passed the gate in round 1

### mcp-tool-platform-explain (session 2026-11-08)

- New `src/tools/platformExplain.ts`, registered in `src/mcp/server.ts` after `platform_query`.
  - The input is `{sql, description?, advise?}` (zod), with **no `analyze` argument**. zod strips an unknown `analyze`,
    and the engine never sees it.
  - The engine runs `SELECT * FROM platform_explain($1)` with the SQL as its only bind parameter, `maxRows: 1`, and
    audit `{description}`: the caller's description, or `GENERATED_EXPLAIN_DESCRIPTION` when it is missing or blank
    (Contract assumption 6). The identity token's `audit.source` is `mcp`, as the session always sets it.
  - The result is `{ plan, advice: null, adviceError? }`. The plan is the first cell of the first row; a JSON-text cell
    is parsed. When the result's JSON is over `MCP_MAX_OUTPUT_BYTES`, the tool returns an error (a plan is not rows,
    so nothing can be dropped).
  - Engine errors go through `failureResult(err, 'The Platform Database explain')`, so a 42501 reads "Access denied:
    ... platform_explain requires attrs.platform_read or attrs.platform_explain ...".
- **Hook for the next features (mcp-plan-advisor-port, mcp-plan-advice, mcp-ai-not-configured):** `advise` defaults to
  true. Until an advisor exists, `advise: true` returns `advice: null` and `adviceError: ADVICE_NOT_CONFIGURED`
  ("Plan advice is not configured on this server"); `advise: false` returns `advice: null` and no adviceError. The
  plan-advice feature should replace the `if (query.advise)` branch in the handler with the advisor call. Keep "a
  failing model never fails the tool". Note that plan-advice.test.ts calls without `advise`, so the default must stay
  true.
- Unit tests: `src/tools/platformExplain.test.ts`. 275 unit tests pass, and typecheck/build are clean.
- Tested as a user with `../tmp/platform-explain-ut/run.mts`. Run it from the repo root as
  `node_modules/.bin/tsx <abs path> $PWD/packages/telemetry-mcp`. It uses the real `dist/main.js` on port 19004, the
  SDK client, an RS256 Okta token, and the fake engine and Lightdash. Results:
  - tools/list shows props `sql, description, advise` and readOnlyHint true;
  - a platform_read user with advise false got the plan and advice null, and the engine saw
    `SELECT * FROM platform_explain($1)` with the SQL as its param, source mcp, the generated description and agent true;
  - with the default advise and a description, the caller's description was sent and adviceError was "not configured";
  - passing `analyze: true` was ignored, and no engine statement contained ANALYZE;
  - a blank sql was refused before the engine;
  - a platform_explain-only user got the plan;
  - a user with neither attribute got "Access denied ... (SQLSTATE 42501)".
- Results: the check passes. Acceptance: 33 files pass and 20 fail. All 20 failures are unbuilt features (ask_data,
  plan advice, ai-not-configured, write_preview, docs, dockerfile, readme, tool-catalog and others).
- 2026-11-08T18:17:02Z supervisor: mcp-tool-platform-explain passed the gate in round 1

### mcp-plan-advisor-port (session 2026-11-08)

- Source: `~/Remotes/HouseRx/db-query-portal` at `aea73de` (`git show aea73de:api/src/services/plan-advisor.service.ts`
  and `.test.ts`, read-only). The other portal ports can read their sources the same way.
- New `src/ask/llm.ts` holds the **`LlmClient` interface** (`createMessage(params) => Promise<LlmResponse>`, with the
  Anthropic Messages shape: text/tool_use/tool_result blocks, tools, tool_choice and usage) and `responseText()`, the
  portal's text-block join. It has no implementation yet. The next AI feature builds the `fetch` client from
  `ANTHROPIC_API_KEY` and wires `deps.llm`.
- New `src/ask/plan-advisor.service.ts` exports `createPlanAdvisor({ llm, defaultModel?, maxTokens?, existingIndexes? })`,
  which returns `{ advisePlan({ sql, plan, analyze?, model? }) }`. The prompt, `PLAN_CHAR_LIMIT`, `parseAdvice`,
  `AI_MODELS`/`resolveModel` and the defaults (haiku-4-5, 1200 tokens) are verbatim from the portal. What changed:
  - the SDK and Secrets Manager are replaced by the injected `LlmClient`;
  - `HttpError` becomes `PlanAdviceError` with `.status` (503 with "AI suggestions are not configured…" when `llm` is
    null, 502 with "AI suggestion request failed: <msg>" when the model call throws);
  - kpi and Sentry are dropped;
  - `pg_indexes` is not reachable through the contract, so the existing-index list comes from an optional injected
    lookup. Without one, the prompt says "(existing indexes could not be read)", as the portal did on failure;
  - `collectRelations` also walks arrays and `Plan` roots, so a whole FORMAT JSON plan (the
    `[{Plan:{...}}]` that `platform_explain` returns) gives its tables;
  - `analyze` defaults to false, so the prompt says "(estimates only)", which plan-advice.test.ts checks for.
  Everything is exported from `src/index.ts`.
- `src/ask/plan-advisor.service.test.ts`: the portal's 4 cases come first, unchanged except that jest became vitest
  and the module mocks became an injected `vi.fn` LLM and index lookup. 8 more cases cover the prompt and max_tokens,
  index-lookup degradation, index parsing, plan truncation, model resolution, and the 503 and 502 errors.
- **Hook for mcp-plan-advice:** in `platformExplain.ts`, replace the `if (query.advise)` branch with
  `createPlanAdvisor({ llm: deps.llm }).advisePlan({ sql, plan })`. On a thrown error, return `advice: null` and
  `adviceError: err.message`; the 502 text contains the model error, which satisfies /upstream overloaded|failed/.
  Consider running `redactSecrets` over it. Keep `ADVICE_NOT_CONFIGURED` for `llm` absent, or use the 503 message.
  mcp-ai-not-configured decides which.
- Tested as a user: ran `pnpm exec vitest run src/ask/plan-advisor.service.test.ts` in the package, and 12 of 12 passed.
  Ran the feature check from the repo root after `bash ./init.sh`, and it passed. The test file and the sources
  typecheck under the package's strict tsconfig; `pnpm typecheck` excludes test files, so a temporary tsconfig in
  `../tmp/plan-advisor-port` covered the test file. The full unit suite has 287 passing.
- Results: acceptance has 34 files passing and 19 failing. All 19 failures are unbuilt features (ask_data, plan-advice,
  ai-not-configured, ask-memory and the other ports, write_preview, docs, dockerfile, readme, tool-catalog,
  no-commit-tool).
- 2026-11-08T18:27:56Z supervisor: mcp-plan-advisor-port passed the gate in round 1

### mcp-plan-advice (session 2026-11-08)

- `platform_explain` now asks the ported plan advisor for advice. When `advise` is true (the default),
  `adviseOnPlan(llm, sql, plan, secrets)` in `src/tools/platformExplain.ts` calls
  `createPlanAdvisor({ llm }).advisePlan({ sql, plan, analyze: false })`. `advice` comes back as
  `{ summary, suggestions, indexes, model }`, with parsing (JSON, prose-wrapped JSON, severity normalising, plain-text
  fallback) and the "(estimates only)" prompt coming verbatim from the port. `advise: false` calls no model.
- Advice never fails the tool:
  - with no client, `advice: null` and `adviceError` is `ADVICE_NOT_CONFIGURED` ("Plan advice is not configured on
    this server"), so ai-not-configured's /not configured/ check already passes for platform_explain;
  - a thrown model call gives `advice: null` and `adviceError: "AI suggestion request failed: <msg>"`, run through
    `redactSecrets` with `configSecrets(config)`;
  - new: when plan + advice is over `MCP_MAX_OUTPUT_BYTES`, the advice is dropped (`ADVICE_TOO_LARGE`) and the plan
    still returns. A plan that is too large on its own is still an error.
- Wiring: `deps.llm` (the `LlmClient`) runs `ServerDeps.llm` → `McpRequestContext.llm` → `McpServerDeps.llm` →
  `registerPlatformExplain(server, config, engine, llm)`. ask_data should pick up `deps.llm` from `createMcpServer` the
  same way.
- **Gap for a later feature (not built here):** nothing builds a real `LlmClient` from `ANTHROPIC_API_KEY` yet. No
  feature in the list explicitly owns it. In production, with only the key set, advice says "not configured".
  mcp-tool-ask-data (or whichever feature first needs a live model) should add a `fetch` Messages client and build it
  in `startServer` when `deps.llm` is absent and `config.anthropicApiKey` is set. Acceptance tests never set the key
  in `baseEnv`, so they would make no network calls.
- Unit tests: 5 new cases in `src/tools/platformExplain.test.ts` (advice and prompt, no client, redacted failure,
  advice that fits, advice dropped for size). Typechecked under strict with a temporary tsconfig in `../tmp/plan-advice`.
- Tested as a user: drove the real HTTP MCP server through the acceptance harness with a `ScriptedLlm`
  (`../tmp/plan-advice/drive.test.ts`). Results:
  - JSON advice parsed, and the unknown severity "critical" became low/general;
  - the prompt held the SQL, the Seq Scan plan and "estimates only";
  - prose-wrapped JSON gave summary "wrapped";
  - plain text became the summary;
  - a throwing model returned the plan with advice null and "AI suggestion request failed: boom 529";
  - `advise: false` made no model call.
  The feature check passes after `bash ./init.sh`. Unit tests: 292 passing.
- Results: acceptance has 35 files passing and 18 failing. All 18 failures are unbuilt features. ai-not-configured
  fails only on its ask_data case.
- 2026-11-08T18:34:08Z supervisor: mcp-plan-advice passed the gate in round 1
- 2026-11-08T18:35:23Z supervisor: mcp-answer-verification-port halted: worker mcp.feature.mcp-answer-verification-port.r1 stopped: STOP file present

### mcp-answer-verification-port (session 2026-11-08, round 1 rerun after STOP-file halt)

- Source: `~/Remotes/HouseRx/db-query-portal` at `aea73de` (`git show aea73de:api/src/services/answer-verification.ts`
  and `.test.ts`, read-only).
- New `src/ask/answer-verification.ts`, a port whose logic is verbatim from the portal (only re-indented to 4 spaces).
  It exports `unverifiedFigures(answer, question, queries)` (figures in the answer not backed by rows, SQL, question,
  row counts or simple arithmetic; deduped, at most 6), `extractFigures(text)`, and types `EvidenceQuery` and `Figure`
  (`Figure` is now exported). All of these are re-exported from `src/index.ts`. It has no dependencies and no I/O.
- New `src/ask/answer-verification.test.ts`: the portal's 7 cases come first, unchanged except that jest globals became
  vitest imports. 4 more cases cover failed-query rows being ignored, dedupe with the cap of 6, and `extractFigures`
  parsing (separators, currency, K/M/B, %, digits inside words).
- **Hook for mcp-tool-ask-data:** after the model writes its answer, call
  `unverifiedFigures(answer, question, queries.map(q => ({ status, sql, rows })))` and surface any non-empty result
  as a warning. This mirrors how the portal uses it; check the portal's ask service for the exact wording.
- Tested as a user: `pnpm exec vitest run src/ask/answer-verification.test.ts` gave 11 of 11 passing. Called the built
  `dist/index.js` export directly, and `unverifiedFigures('30% paid, 31% rejected, 99 open', …rows n=30,70)` returned
  `["31%","99"]`. After `bash ./init.sh` the feature check passes. Strict typecheck covered the test file through
  `../tmp/answer-verification-port/tsconfig.json`. `pnpm typecheck` is clean, and the unit suite has 303 passing.
- 2026-11-08T18:37:40Z supervisor: mcp-answer-verification-port passed the gate in round 1

### mcp-ask-memory-store (session 2026-11-08, round 1)

- Source: portal `api/src/dynamo/askMemory.ts` at `aea73de` (read-only).
- New `src/ask/ask-memory-store.ts` holds the portal's `MemoryKind`, `MEMORY_KINDS`, `MemoryNote`, `UpsertNoteInput`,
  `noteId` and `shouldHide`, unchanged. The portal's free functions become the `AskMemoryStore` interface:
  `upsertNote`, `listNotes(db, { includeHidden })`, `getNote`, `touchNotes`, `voteNote`, `deleteNote`.
  `InMemoryAskMemoryStore` reproduces the DynamoDB update rules:
  - if_not_exists keeps createdAt, createdByEmail, status, uses and votes;
  - each upsert adds 1 to confirmations, and the latest topic, insight and tables win;
  - sqlTemplate is set only when given;
  - a hidden note stays hidden;
  - each voter counts once per note, and a repeat vote or a missing note returns null;
  - a note is hidden once `shouldHide` is true;
  - touch skips missing ids.
  Options are `{ ttlDays = 120 (portal AI_ASK_MEMORY_TTL_DAYS default), now }`. Expired items are dropped on read,
  like DynamoDB TTL. The portal's `voters` set is kept in a private map, so returned notes never carry voter ids.
  Notes are copied in and out. Everything is re-exported from `src/index.ts`.
- **Decision:** no DynamoDB-backed store and no config variable for the TTL or enablement. No feature asks for them,
  and the package has no AWS SDK. ask_data takes the store as `deps.askMemoryStore` (the harness already passes it).
- **For mcp-ask-memory-port:** my unit file is `src/ask/in-memory-ask-memory-store.test.ts`, with 6 extra
  non-portal cases. The file name `ask-memory-store.test.ts` is free on purpose, for the portal's 6 table cases
  run against the in-memory store. The portal's jest `ddb.send` mocks will need rewriting as store behaviour.
- Tested as a user: after `bash ./init.sh`, a node script (`../tmp/ask-memory-store/drive.mjs`) imported the built
  `dist/index.js` and followed the steps:
  - upsert gave the 32-hex portal noteId with every attribute (confirmations 1, uses and votes 0, ISO times, expiresAt
    about 120 days out);
  - re-upserting "active ORDER status!" gave the same id, confirmations 2 and one listed note;
  - downvote v1 stayed active, a repeat v1 returned null, and v2 made it hidden; the list showed 0, or 1 with
    includeHidden;
  - touch set uses to 1, and after delete, get returned undefined.
  Results: the feature check passes (5/5), the unit file passes 6/6, `pnpm typecheck` is clean, and a strict tsc over
  the test file passes via `../tmp/ask-memory-store/tsconfig.json`.
- 2026-11-08T18:40:11Z supervisor: mcp-ask-memory-store passed the gate in round 1

### mcp-ask-memory-port (session 2026-11-08, round 1)

- Source: portal `api/src/services/ask-memory.service.ts`, its `.test.ts` and `api/src/dynamo/askMemory.test.ts` at
  `aea73de` (read-only).
- New `src/ask/ask-memory.service.ts`. These are verbatim from the portal (re-indented only):
  - the pure helpers `looksSensitive`, `scrubSql`, `qualityScore`, `rankNotes`, `shortId`, `formatNotesForPrompt`,
    `sanitizeLearning`, `toView` and `memoryDisabledResult`;
  - the types `MemoryNoteView`, `AskMemoryResult`, `LearningContext`, `LearnArgs` and `LearningCandidate` (now
    exported);
  - the limits (3 learnings, 60 s recall cache, min weight 2, 1500-char SQL template).

  The portal's module-level state is now per service: `createAskMemoryService({ store, enabled = true,
  maxRecall = 8, now = Date.now, onError? })` returns `recallNotes`, `learnFromAnswer`, `recordFeedback`,
  `listNoteViews`, `removeNote`, `resetMemoryCache` and `enabled`.
  - `PortalUser` is now `AskMemoryUser { sub, email }`, and `sub` is the voter id (the portal used `auth0Sub`).
  - Sentry is now `onError(err, 'askMemory.<where>')`, still throttled to one call a minute. KPI metrics are dropped.
  - Everything is re-exported from `src/index.ts`.
- New `src/ask/ask-memory.service.test.ts` (24 cases). The portal's cases come first, unchanged except that the jest
  module mock became a stub `AskMemoryStore`. They are followed by 5 port cases: learn, touch, flag and recall over
  `InMemoryAskMemoryStore`; the recall cache and its drop after learning; store failures that never throw and are
  reported once a minute; disabled mode; list and remove.
- New `src/ask/ask-memory-store.test.ts` (10 cases). It holds the portal's `dynamo/askMemory.test.ts` describes and
  cases. The `ddb.send` request assertions are rewritten as store behaviour: a repeat or missing vote gives null,
  hiding happens at the threshold, upsert merges and never un-hides and sets sqlTemplate only when given, and the list
  is filtered by database, newest first.
- **For data-assistant-port / ask_data:** build a single `createAskMemoryService({ store: deps.askMemoryStore, now,
  onError })` per server and pass it in. The portal's `resetMemoryCache()` in `beforeEach` maps to the service method,
  or to a new service per test. The portal's `env.aiAskMemoryEnabled` in data-assistant maps to `memory.enabled`.
- Tested as a user: after `bash ./init.sh`, `../tmp/ask-memory-port/drive.mjs` imported the built `dist/index.js`
  and ran three learnings through `learnFromAnswer`:
  - only the valid query_pattern was stored, with SQL scrubbed to `... note = '?' AND id = ?`; the MRN-shaped and
    unknown-table lessons were rejected;
  - recall returned it with the UNVERIFIED prompt text;
  - feedback counted 1, and a repeat vote counted 0;
  - the views showed 1 upvote and 1 confirmation, and remove emptied the list.

  Results: the feature check passes (2/2), the unit files pass 24/24 and 10/10, the ask-memory-store acceptance check
  still passes (5/5), `pnpm typecheck` is clean, and strict tsc over both test files passes via
  `../tmp/ask-memory-port/tsconfig.json`.
- 2026-11-08T18:43:59Z supervisor: mcp-ask-memory-port passed the gate in round 1

### mcp-example-queries-port (session 2026-11-08, round 1)

- Source: portal `api/src/services/example-queries.service.ts` and its `.test.ts` at `aea73de` (read-only), plus the
  `Execution` type from `api/src/dynamo/executions.ts`.
- New `src/engine/audit.ts`, the §1.3 audit browser client:
  - `createEngineAuditBrowser(httpUrl, session, secrets?)` returns `{ list({ticket?, user?, month?, cursor?}) }`.
  - It calls `GET ${ENGINE_HTTP_URL}/v1/audit` with `Authorization: Bearer <fresh identity token>`. The token is
    minted with `session.identityToken(null)`, so it is not audited.
  - It returns `{ items: Execution[], nextCursor: string | null }`; an empty or missing cursor counts as null.
  - Failures throw `AuditBrowserError`: unreachable engine, a non-2xx reply (the message names the status and the
    engine's message, redacted) or a body that is not a page. An unmappable caller fails before any request.
  - The portal `Execution` type is exported from here.
- New `src/ask/example-queries.service.ts`. Filters, scrubbing (`scrubSql`/`looksSensitive` from ask-memory), ranking,
  limits and text are verbatim. `createExampleQueries({ audit, now?, onError? })` returns `findExampleQueries(database,
  keywords, limit?)` and `resetExamplesCache()`. The portal's module cache is now per service. Sentry is now
  `onError(err, 'askData.examples')`.
- **Contract assumption 9 (example-query paging).** §1.3 has no `from`/`to`/`pageSize`/`excludeScheduler`, so none of
  them is sent. The service sends no filters and follows `nextCursor` from the engine's default listing, at most 5
  pages as in the portal. It skips records whose `createdAt` is older than the 90-day lookback and keeps records
  without a readable `createdAt`. Scheduler runs are `action: 'assertion'` and `usable` drops them anyway.
  Walking `month=` was rejected because the portal's paging test pins exactly 2 calls for a 2-page history.
- **For data-assistant-port / ask-data-example-queries:** the audit browser acts as one caller, so build one
  `createExampleQueries({ audit: createEngineAuditBrowser(config.engine.httpUrl, session, configSecrets(config)) ,
  now: deps.now, onError })` per caller/request. Do not share its cache across users: a user without `platform_read`
  must not see examples another user loaded. With stateless `/mcp`, the 6 h cache then lasts one request; a
  per-user cache keyed by `sub` is a possible follow-up. The portal's `findExampleQueries` import in data-assistant
  maps to the service method.
- Tests:
  - `src/ask/example-queries.service.test.ts` (10 cases): the portal's 5 come first, unchanged except that the
    `listExecutions` mock is now a stub `AuditBrowser` with `{items, nextCursor}` pages and the Sentry mock is
    `onError`. Then 5 port cases: cursor paging capped at 5, the lookback, the 6 h per-database cache on the injected
    clock, onError (failures are not cached), and the limit and labels.
  - `src/engine/audit.test.ts` (7 cases): runs against a local http server.
- Tested as a user: after `bash ./init.sh`, `../tmp/example-queries-port/drive.mjs` imported the built
  `dist/index.js`. It wired `createIdentitySession` (stub resolver), `createEngineAuditBrowser` and
  `createExampleQueries` against a throwaway 2-page `/v1/audit` server holding literals, a write, a failure and
  another database.
  - Output: one example `run 2× by 2 people; tables: orders` with `status = '?'`, and no literals, write, failure or
    other database.
  - The server saw 2 requests (no cursor, then `cursor=p2`), each with a `Bearer` two-part token. A second call was
    cached (no new request). An unreachable engine gave "unavailable right now" with one onError call.
  - Results: the feature check passes (1/1), the unit files pass 10/10 and 7/7, `pnpm typecheck` is clean, and strict
    tsc over both test files passes via `../tmp/example-queries-port/tsconfig.json`.
- 2026-11-08T18:47:42Z supervisor: mcp-example-queries-port passed the gate in round 1

### mcp-data-assistant-port (session 2026-11-08, round 1)

- Source: portal `api/src/services/data-assistant.service.ts`, its `.test.ts`, `ask-domain-notes.ts` and
  `schema-catalog.service.ts` at `aea73de` (read-only).
- New `src/ask/ask-domain-notes.ts`, verbatim (re-indented), next to the data assistant (the acceptance test pins
  this).
- New `src/ask/schema-catalog.service.ts`, the engine-backed port of the portal's schema catalog.
  - `createPlatformCatalog({ engine, audit })` returns `{ loadCatalog, describeTables, searchSchema, findJoinPath,
    resolveColumn }`. `qualifiedName`, `formatCatalogForPrompt`, `PLATFORM_TABLES_SQL` and `PLATFORM_COLUMNS_SQL`
    are free exports.
  - It reads only `SELECT * FROM platform_tables()` and `SELECT * FROM platform_columns($1, $2)` (schema and table
    are bind params). Every read carries the ask's audit block.
  - Tables and per-table columns are cached for the catalog's lifetime (one ask, one caller). Failed reads are not
    cached.
- New `src/ask/data-assistant.service.ts`. Prompts, tools, limits, grounding, visualizations, the submit retry loop,
  figure verification and the memory flow are the portal's.
  - `createDataAssistant({ llm, engine, memory, examples, model?, maxTokens?, maxSteps?, maxQueries?, maxRows?,
    maxCellChars?, maxResultChars?, queryTimeoutMs?, deadlineMs?, shareRows?, now?, onError? })` returns
    `{ askData(input) }`. Defaults are in `DATA_ASSISTANT_DEFAULTS` (the portal's `AI_ASK_*`: sonnet-5-5, 8000
    tokens, 60 steps, 60 queries, 50 rows, 200 chars per cell, 16000 result chars, 30 s, 600 s, share rows).
  - `AskInput.user` is `AskMemoryUser {sub, email}`.
  - `HttpError` became `AskError` with `.status`: 503 not configured (`ASK_NOT_CONFIGURED_MESSAGE` in index), 502
    schema/model failure, 500 audit failure, 499 cancelled.
  - `run_sql`/`sample_values` run `SELECT * FROM platform_query($1)`. The param is the portal's wrapped
    `SELECT * FROM (\n<sql>\n) AS _ask LIMIT 51`, with `maxRows: 51`.
  - Every engine read of an ask (catalog and queries) carries `audit {description: auditDescription(ctx), ticket:
    null}`, i.e. `AI Ask (<model>; rows shared with model): <question>`.
- **Contract assumption 10 (engine-side Ask audit and catalog).**
  - (a) The engine writes the audit record. The portal's `recordExecution` is gone. A statement rejected locally
    (empty, over the query budget, or not leading with SELECT/WITH) never reaches the engine, so it has no audit
    record; it is still in `queries` and reported to the model. The portal's `guardQuery` was **not** ported: §5 says
    the guard runs in the engine. Locally only the portal's SELECT/WITH check remains.
  - (b) SQLSTATE 58000 from any engine read fails the whole ask with `AskError` 500 and no rows ("An AI query's audit
    record could not be persisted (…)"), mirroring the portal's fail-closed audit.
  - (c) A catalog read failure is 502 "Could not read the database schema…". For an `EngineError` with a SQLSTATE,
    `engineErrorText` is appended, so a missing `platform_read` is named.
  - (d) Through §1.1 there are no comments, row estimates, enums, constraints, indexes or FKs. `describe_tables` lists
    columns (type, NOT NULL), and the catalog shows `[table, row count unknown]`. `find_join_path` says FKs are not
    visible and gives the naming-convention hint (it still counts as a schema lookup). `search_schema` matches table
    names, plus columns of tables already described in this ask. Searching every column would be one audited
    `platform_columns()` per table.
- `src/ask/llm.ts`: `LlmRequest.system` may be `LlmSystemBlock[]` (with `cache_control`). `LlmRequest.thinking` was
  added. `createMessage(params, options?: LlmCallOptions {timeoutMs, signal})`. **For the real fetch client (next
  features):** send `system` blocks and `thinking` through as given, and honour `signal`/`timeoutMs`.
- Tests:
  - `src/ask/data-assistant.service.test.ts` (33 cases) holds the portal's 33 in order. The LLM mock is `create`.
    The engine is a fake `EngineClient` answering platform_tables/columns/query. Memory is
    `createAskMemoryService` over a mocked store, and examples are a stub. Env tweaks became options.
  - 8 cases were adapted because they asserted portal plumbing (pool `BEGIN READ ONLY`/`ROLLBACK`/`DISCARD`,
    `recordExecution`):
    - the SQL is only the bind param of `platform_query($1)`, with an audit description;
    - a DELETE never reaches the engine;
    - every engine read carries model and question;
    - 58000 on a schema lookup gives 500 after 1 model call;
    - 58000 on a query gives 500 after 1 model call;
    - a failed query reached the engine with an audit description;
    - find_join_path gives the naming-convention hint;
    - the sample_values audit description.
  - `src/ask/schema-catalog.service.test.ts` (6 cases).
- **For mcp-tool-ask-data:** per request, build `createDataAssistant({ llm, engine: <request engine client>, memory:
  <server-wide AskMemoryService>, examples: createExampleQueries({audit: createEngineAuditBrowser(...)}), maxSteps:
  config.askMaxSteps, queryTimeoutMs: config.statementTimeoutMs, now: deps.now, onError })`.
  - Call `askData({question, database: config.platformSource, user: {sub: userUuid, email}, history})`.
  - Map `AskError` to an `isError` result with its message.
  - Validate the question (1..1000 chars, `MAX_QUESTION_CHARS`) before calling.
  - The acceptance fake answers `platform_query` only when the param matches `count(*) AS n FROM orders`. The
    wrapped param still matches.
- Tested as a user: after `bash ./init.sh`, `../tmp/data-assistant-port/drive.test.ts` (run with vitest so it can use
  the acceptance fakes) drove the built `dist/index.js`. It used the real pg-wire `createEngineClient` +
  `createIdentitySession` against `startFakeEngine` with `installPlatformCatalog`, a `/v1/audit` page and a
  `ScriptedLlm`.
  - Run: describe_tables(orders, ghost), then find_example_queries, sample_values(orders.status), run_sql DELETE,
    run_sql count, then submit with a learning.
    - The answer "42" was grounded on query 3.
    - The DELETE was rejected and never reached the engine.
    - The engine got exactly platform_tables, platform_columns, and 2× platform_query.
    - Every identity token had `agent: true` and `audit.description` "AI Ask (claude-sonnet-5-5; rows shared with
      model): How many orders are there?".
    - Examples were scrubbed (`'?'`) and fetched with Bearer.
    - Memory learned 1 query_pattern.
    - Progress events were streamed. 0 connections were left open.
  - 58000 gave AskError 500 after 1 model call. `llm: null` gave 503 "not configured". A 42501 on platform_tables gave
    502 naming platform_read.
- Results:
  - The feature check passes (2/2). The unit files pass 33/33 and 6/6.
  - The `plan-advice` acceptance file passes 5/5 (the `LlmClient` signature changed).
  - `pnpm typecheck` is clean, and strict tsc over both new test files passes via `../tmp/data-assistant-port/tsconfig.json`.
- 2026-11-08T18:58:32Z supervisor: mcp-data-assistant-port passed the gate in round 1

## mcp-tool-ask-data (round 1)

- New `src/tools/askData.ts`: the `ask_data` tool. Input is `{question: string 1..1000, history?: [{question, answer}]}`.
  - zod enforces the length limits. That means an empty or 1001-character question comes back as an SDK `-32602`
    error. The handler also refuses a blank (whitespace-only) question and malformed history with `ToolInputError`
    (`parseAskDataArgs`). Both checks happen before any model call or engine connection.
  - For each call it builds `createDataAssistant({llm: deps.llm ?? null, engine, memory, examples, maxSteps:
    config.askMaxSteps, queryTimeoutMs: config.statementTimeoutMs, now, onError})` and calls `askData({question,
    database: config.platformSource, user: {sub: userUuid, email}, history, signal: extra.signal})`.
  - It returns the `AskResult` as `structuredContent` plus JSON text.
  - `AskError` becomes an `isError` result with the service's message, with secrets redacted. Any other error goes
    through `failureResult`.
  - Annotations are `readOnlyHint: false, destructiveHint: false, openWorldHint: true`, as tool-catalog requires
    (ask_data writes team memory).
  - Output cap (`askDataResult`): if the result is over `MCP_MAX_OUTPUT_BYTES`, every query's `rows` is emptied
    (`moreRowsAvailable: true`) so the answer still gets through. If it is still too large, the result is an error.
    This is my own reading; the spec doesn't decide it.
- `src/mcp/server.ts`:
  - `McpServerDeps.ask?` carries `{memory, examples, user, onError}`.
  - `serveMcpRequest` fills it per request:
    - examples: `createExampleQueries({audit: createEngineAuditBrowser(config.engine.httpUrl, session, secrets)})`;
    - user: the request's memoised Lightdash user, so there is no extra Lightdash call;
    - `onError`: logs a warn with only `where` and the error name.
  - Without `ask` (unit tests calling `createMcpServer` directly) it uses an in-memory memory, no examples, and a user
    that rejects.
- `src/http/server.ts`: `ServerDeps.askMemoryStore` is new. `McpRequestContext.askMemory` is one server-wide
  `createAskMemoryService({store: deps.askMemoryStore ?? new InMemoryAskMemoryStore(), now, onError})`, shared across
  requests and users.
- `src/index.ts` exports `ASK_DATA_TOOL`, `ASK_DATA_TOO_LARGE`, `askDataResult`, `parseAskDataArgs` and the types.
- New unit file `src/tools/askData.test.ts` (5 cases: argument checks, result, row-dropping cap, too large).
- Tested as a user: after `bash ./init.sh`, `../tmp/tool-ask-data/drive.test.ts` (run with `pnpm exec vitest run
  --root ../tmp/tool-ask-data --disableConsoleIntercept drive.test.ts` from the package) started the built
  `dist/index.js` against the fake Okta, Lightdash and engine, plus a `ScriptedLlm`. A real MCP client connected over
  streamable HTTP with an Okta bearer token.
  - `tools/list` shows ask_data with `question` and `history`.
  - ask_data (describe_tables → run_sql → submit_answer) returned answered, "42", `evidenceQueries` [1], and query 1
    ok with columns [n] and 1 row.
  - The model's tools were the 7 portal tools, and the catalog mentioned orders.
  - The engine saw `platform_tables()`, `platform_columns($1,$2)` and `platform_query($1)`, with the wrapped model SQL
    only as the param. Every token had `agent: true`, source `mcp`, and description "AI Ask (claude-sonnet-5-5; rows
    shared with model): <question>".
  - Empty, 1001-character and blank questions each gave an error. A follow-up with history made 2 model calls, and
    the earlier question was in the messages.
- Results:
  - Feature check: 5/5.
  - Also passing, run one at a time: ai-not-configured 2/2, structured-logs 3/3, plan-advice 5/5,
    unknown-user-no-tools 5/5, ask-data-memory 4/4, ask-data-example-queries 2/2, ask-data-abstain 4/4,
    ask-data-unverified-figures 3/3, and unit `src/mcp/server.test.ts` 5/5.
  - `pnpm typecheck` is clean.
- **For the next sessions:**
  - The checks for mcp-ask-data-abstain, -unverified-figures, -memory, -example-queries and mcp-ai-not-configured
    already pass with this wiring. Those sessions may only need to verify them and record it.
  - No real Anthropic client exists yet. PROGRESS "Public API" says to build one from `ANTHROPIC_API_KEY` when
    `deps.llm` is absent; no feature on the list covers it. Today, a server with a key but no `deps.llm` reports
    "not configured".
  - MCP progress notifications are not sent; `onProgress` is unused.
- 2026-11-08T19:03:16Z supervisor: mcp-tool-ask-data passed the gate in round 1

## mcp-ask-data-abstain (2026-11-08)

- No code changes. The mcp-tool-ask-data wiring (the ported data-assistant loop) already does everything this
  feature needs; this session verified it and recorded the result here.
- Tested as a user: after `bash ./init.sh`, `../tmp/ask-data-abstain/drive.test.ts` (run with `pnpm exec vitest run
  --root ../tmp/ask-data-abstain --disableConsoleIntercept drive.test.ts` from the package) started the built
  `dist/index.js` with `MCP_ASK_MAX_STEPS=4` against the fake Okta, Lightdash and engine, plus a `ScriptedLlm`. A real
  MCP client connected over streamable HTTP with an Okta bearer token.
  - unsafe_request abstention: status abstained, the reason and `whatWouldHelp` were passed through, there were no
    queries, and the engine saw 0 `platform_query` runs.
  - "answered" citing query 1 when no query had run: the model was re-prompted, 3 model calls in all. The result was
    abstained / `unsupported_answer` with an explanation and a hint.
  - The model never submitted: exactly 4 model calls, then abstained / `budget_exceeded` with `usage.steps` 4.
  - A bad table, then a good query: queries were [error "SQL error: relation does not exist", ok], status answered,
    and the engine saw 2 `platform_query` runs.
- Feature check: 4/4.
- Note: when an MCP tool result is not an error, `isError` is omitted rather than set to false. The harness treats a
  missing `isError` as false.
- 2026-11-08T19:04:38Z supervisor: mcp-ask-data-abstain passed the gate in round 1

## mcp-ask-data-unverified-figures (2026-11-08)

- No code changes. The ported answer verification inside the data-assistant loop, wired up by mcp-tool-ask-data,
  already does everything this feature needs. This session checked it and recorded the result.
- Tested as a user: after `bash ./init.sh`, `../tmp/ask-data-unverified-figures/drive.test.ts` (run with
  `pnpm exec vitest run --root ../tmp/ask-data-unverified-figures --disableConsoleIntercept drive.test.ts` from the
  package) started the built `dist/index.js` against the fake Okta, Lightdash and engine, plus a `ScriptedLlm`. A real
  MCP client connected over streamable HTTP with an Okta bearer token.
  - Query returned 42 and the model answered 97: there were 3 model calls. The third request said "Rejected: these
    figures in your answer do not appear in your query results (or follow from simple arithmetic on them): 97 ...".
    The corrected answer "42" came back answered at high confidence, with no caveats.
  - Model insisted on 97 three times: 4 model calls. The result was answered at low confidence with the caveat
    "Could not verify these figures against the query results: 97."
  - "42 orders, so 84": answered at high confidence, with no caveats.
- Feature check: 3/3.
- 2026-11-08T19:05:52Z supervisor: mcp-ask-data-unverified-figures passed the gate in round 1

## mcp-ask-data-memory (2026-11-08)

- No code changes. The ask-memory wiring from mcp-tool-ask-data already covers this feature: the ported
  ask-memory service runs inside the data-assistant loop, and `deps.askMemoryStore` falls back to
  `InMemoryAskMemoryStore`. This session verified it and recorded the result.
- Tested as a user: after `bash ./init.sh`, `../tmp/ask-data-memory/drive.test.ts` (run with `pnpm exec vitest run
  --root ../tmp/ask-data-memory --disableConsoleIntercept drive.test.ts` from the package) started the built
  `dist/index.js`. It ran against the fake Okta, Lightdash and engine, with a `ScriptedLlm` and a shared
  `InMemoryAskMemoryStore`. A real MCP client connected over streamable HTTP with an Okta bearer token.
  - Grounded answer with two proposed lessons, one containing a synthetic email: `memory.learned` held only the
    definition "active order status". The store held 1 note, the email was not in it, and its uses were 0.
  - Related question ("How many active orders are open?"): `memory.recalled` listed the note. The first model request
    contained "Team memory" and the note's insight. After the grounded answer, the note had 1 use.
  - Abstention (schema_gap) that proposed a lesson: `memory.learned` was empty, and the store still held 1 note.
- Feature check: 4/4.
- 2026-11-08T19:07:08Z supervisor: mcp-ask-data-memory passed the gate in round 1

## mcp-ask-data-example-queries (2026-11-08)

- No code changes. The ported example-queries service (mcp-example-queries-port) is already wired into the
  data-assistant loop's `find_example_queries` tool by mcp-tool-ask-data. It reads `GET /v1/audit` with the caller's
  identity token. This session checked it and recorded the result.
- Tested as a user: after `bash ./init.sh`, `../tmp/ask-data-example-queries/drive.test.ts` (run with
  `pnpm exec vitest run --root ../../../tmp/ask-data-example-queries --disableConsoleIntercept drive.test.ts` from the
  package) started the built `dist/index.js` against the fake Okta, Lightdash and engine, plus a `ScriptedLlm`. A real
  MCP client connected over streamable HTTP with an Okta bearer token. The audit page held 2 reads of the same shape
  with different string literals and 7-digit ids, a write, a failed read and a read on another database.
  - The model called `find_example_queries` for "orders status". The tool result showed one example, "run 2× by 2
    people; tables: orders", reading `status = '?' AND id > ?`. No literals, write, failure or other database appeared.
  - The engine saw 1 `GET /v1/audit` call. Its bearer was an identity token with iss `telemetry-mcp`, `agent: true`
    and the caller's email.
- Trap: `scrubSql` (portal behaviour, kept) replaces only quoted strings and numbers of 5 or more digits. Small numeric
  constants stay, so `id > 17` and `id > 99` are two different shapes and are not merged.
- Feature check: 2/2.
- 2026-11-08T19:08:40Z supervisor: mcp-ask-data-example-queries passed the gate in round 1

## mcp-ai-not-configured (2026-11-08)

- No code changes. The behaviour was already in place from earlier features. `askData` in
  `src/ask/data-assistant.service.ts` throws `AskError(503, NOT_CONFIGURED_MESSAGE)` before any catalog or engine
  call when `llm` is null. `platformExplain` returns the plan with `advice: null` and
  `adviceError: ADVICE_NOT_CONFIGURED` when there is no `deps.llm`. This session checked it and recorded the result.
- Tested as a user: after `bash ./init.sh`, `../tmp/ai-not-configured/drive.test.ts` (run with
  `pnpm exec vitest run --root ../../../tmp/ai-not-configured --disableConsoleIntercept drive.test.ts` from the
  package) started the built `dist/index.js` with no `deps.llm` and with `ANTHROPIC_API_KEY` unset, against the fake
  Okta, Lightdash and engine. A real MCP client connected over streamable HTTP with an Okta bearer token.
  - ask_data: isError true, "Ask is not configured for this environment (no Anthropic API key available)." The engine
    received 0 data queries.
  - platform_explain `SELECT 1`: isError false, plan returned, `advice: null`,
    `adviceError: "Plan advice is not configured on this server"`.
- Gap for a later or integration session (not in the feature list): `src/main.ts` never builds an `LlmClient`. The
  config reads `ANTHROPIC_API_KEY` and redacts it from logs, but nothing uses it to create a model client. So the
  production entry point (`dist/main.js`) always reports AI as "not configured", even when the key is set. Only callers
  that inject `deps.llm` through `startServer` get AI features. Wiring a real Anthropic client needs a decision about
  the SDK dependency and the model id.
- Feature check: 2/2.
- 2026-11-08T19:10:05Z supervisor: mcp-ai-not-configured passed the gate in round 1

## mcp-tool-write-preview (2026-11-08)

- Added `write_preview` (`src/tools/writePreview.ts`). Its input is `{statement, description, ticket?}`, with no mode
  argument. `statement` and `description` must be non-blank, and `ticket` must match `LINEAR_TICKET` from
  `platformQuery.ts`. Bad input is refused before any engine call. Annotations: `readOnlyHint: false`,
  `destructiveHint: false` (a Preview never commits), `idempotentHint: true`, `openWorldHint: false`.
- Added `src/engine/write.ts` (`createEngineWriter`). It sends `POST ENGINE_HTTP_URL/v1/write` with
  `Authorization: Bearer <fresh §3 identity token>`. The token's audit block holds the description and ticket. The
  body is `{statement, mode:"preview", confirmation_token, description, ticket|null}`. These become an
  `EngineWriteError`, with tokens and secrets redacted:
  - a non-2xx reply: "The Preview failed with HTTP <status>: <engine message>";
  - an unreachable engine;
  - `preview !== true`;
  - a malformed reply (audit_id must be a non-empty string, rows_affected an integer ≥ 0, returning an array of
    objects or null).
  The timeout is `MCP_STATEMENT_TIMEOUT_MS + 10 s`. `engineErrorMessage` in `engine/audit.ts` is now exported so the
  writer can reuse it.
- Added `src/identity/confirmation.ts`, which implements Contract assumption 4: `mintConfirmationToken` returns
  `base64url(json{v:1, stmt_sha256, sub, project, exp, nonce}).base64url(HMAC-SHA256(HRX_IDENTITY_SECRET, payload))`
  with a 60 s lifetime. `sub` and `project` are read back from the identity token the writer has just minted, so the
  `EngineSession` interface stays the same.
- `createMcpServer` registers the tool with `deps.writer`. `serveMcpRequest` builds the writer from the request's
  identity session. Without `deps.writer` (unit tests), the default writer refuses every Preview before any HTTP call.
- If the engine's RETURNING reply is over `MCP_MAX_OUTPUT_BYTES`, the tool returns an error that names the audit id
  and says nothing was committed. The rows are never cut.
- **Not in this feature:** the `platform_write` check before the HTTP call belongs to
  mcp-write-preview-requires-platform-write, the next feature. Right now a user without the attribute reaches the
  engine, which refuses them. Add the check in the tool handler before `writer.preview`; the mapped user's attrs are
  reachable through the session's resolver.
- Unit tests: `src/engine/write.test.ts` (9) and `src/tools/writePreview.test.ts` (9).
- Tested as a user: after `bash ./init.sh`, `../tmp/tool-write-preview/drive.test.ts` (run with
  `pnpm exec vitest run --root ../../../tmp/tool-write-preview --disableConsoleIntercept drive.test.ts` from the
  package) spawned the production entry `node dist/main.js` against the fake Okta, Lightdash and engine. The analyst
  was given `platform_write`. A real MCP client connected to `/mcp` over streamable HTTP with an Okta bearer token.
  - tools/list showed write_preview with `statement`, `description` and `ticket`, and readOnlyHint false.
  - The engine received body keys statement, mode `preview`, confirmation_token (354 chars), description and ticket.
    Its bearer verified as iss `telemetry-mcp`, agent true and platform_write true, with audit
    `{description, ticket ENG-456, source mcp}`.
  - The tool returned `{audit_id, rows_affected 1, preview true, returning [...]}`.
  - With no description, the call failed with an input validation error and the engine got 0 calls. An engine 400
    returned "The Preview failed with HTTP 400: DDL is always blocked". A reply with preview false was an error. No
    SQL text appeared in the server logs.
- Feature check: 6/6.
- 2026-11-08T19:14:05Z supervisor: mcp-tool-write-preview passed the gate in round 1

## mcp-write-preview-requires-platform-write (2026-11-08)

- `write_preview` now checks the caller's `platform_write` attr in the tool handler before any input validation or
  `writer.preview`. A caller without it gets "write_preview needs the platform_write user attribute, ...". The
  engine gets no request. The check fails closed: if the attrs cannot be read, the tool returns
  `PLATFORM_WRITE_UNCHECKED` and the engine gets no call (`writeAccessDenial` in `src/tools/writePreview.ts`).
- `registerWritePreview(server, config, writer, attrs)` takes a new `CallerAttrs` argument.
  `McpServerDeps.attrs` is optional; when it is absent (unit tests), `NO_ATTRS` rejects, so the tool refuses.
  `serveMcpRequest` passes `async () => (await users.user()).attrs`, which reuses the request's once-resolver, so
  the check costs no extra Lightdash call.
- The tool stays in tools/list for users without the attr (the description already says it needs platform_write).
  Hiding it per user was not asked for.
- Unit tests: 3 new `writeAccessDenial` cases in `src/tools/writePreview.test.ts` (12 total).
- Tested as a user: after `bash ./init.sh`, ran `../tmp/write-preview-platform-write/drive.test.ts` (from the package:
  `pnpm exec vitest run --root ../../../tmp/write-preview-platform-write --disableConsoleIntercept drive.test.ts`).
  It spawns `node dist/main.js` against the fake Okta, Lightdash and engine, with `MCP_USER_CACHE_TTL_MS=0`.
  - The analyst (platform_read only) and the viewer (no attrs) each got the platform_write error, and the engine
    got 0 `/v1/write` calls.
  - After the fake Lightdash granted the analyst platform_write, the same call returned a Preview, with 1 engine call.
- Feature check: 1/1. `tool-write-preview.test.ts` still 6/6, `src/mcp/server.test.ts` 5/5.
- 2026-11-08T19:16:13Z supervisor: mcp-write-preview-requires-platform-write passed the gate in round 1

## mcp-no-commit-tool (2026-11-08)

- No source change was needed: the guarantee was already structural. `createEngineWriter` sends the literal
  `mode: 'preview'` (`src/engine/write.ts`), `buildPreviewRequest` copies only `statement`, `description` and
  `ticket`, and the SDK's input schema drops unknown keys, so no client argument can reach the request body. The
  feature check passed on arrival (3/3).
- Added one unit case to `src/tools/writePreview.test.ts` (13 total): `buildPreviewRequest` drops smuggled
  `mode`, `commit`, `confirm` and `confirmation_token`. `src/engine/write.test.ts` already pins the body to mode preview.
- Tested as a user: after `bash ./init.sh`, ran `../tmp/no-commit-tool/drive.test.ts` (from the package:
  `pnpm exec vitest run --root ../../../tmp/no-commit-tool --disableConsoleIntercept drive.test.ts`). It spawns
  `node dist/main.js` against the fake Okta, Lightdash and engine, with the analyst granted platform_write.
  - tools/list showed 14 tools. write_preview is the only write-shaped one, and its properties are statement,
    description and ticket.
  - Every tool was called with `{mode: 'commit', commit: true, confirm: true, confirmation_token: 'x', ...}`.
    The engine got exactly 1 `/v1/write` call, from write_preview. Its mode was `preview` and its body keys were
    statement, mode, confirmation_token (server-minted), description and ticket.
  - Calls to the tools `commit`, `write_commit` and `execute_write` failed with MCP -32602 "Tool ... not found".
- Feature check: 3/3. `tool-write-preview.test.ts` still 6/6.
- Trap for later features: never add a pass-through of tool args (`...args`) into the write body, and never add a
  `mode` input; the acceptance test asserts no write_preview property matches /commit|confirm/i.
- 2026-11-08T19:18:18Z supervisor: mcp-no-commit-tool passed the gate in round 1

## mcp-tool-catalog (2026-11-08)

- No source change was needed: the catalog earlier features built already met the contract, and the feature check
  passed on arrival (4/4).
- Added one unit case to `src/mcp/server.test.ts` (6 total). It pins the catalog at the unit level: the exact 14
  CONTRACTS §7 tools, a description over 20 characters for every tool, an object input schema with every property
  described, readOnlyHint true on every tool except `ask_data` (it writes team memory) and `write_preview`, the
  glossary terms Platform Database, Audited Query, Preview and Telemetry Source, and none of the avoided terms.
- Tested as a user: after `bash ./init.sh`, ran `../tmp/tool-catalog/drive.test.ts` (from the package:
  `pnpm exec vitest run --root ../../../tmp/tool-catalog --disableConsoleIntercept drive.test.ts`). It spawns
  `node dist/main.js` against the fake Okta, Lightdash and engine, and connects over /mcp with an Okta token for the
  analyst. tools/list returned the 14 contract tools and every property was described. readOnlyHint was true for 12
  tools and false for ask_data and write_preview. A scan against the CONTEXT.md avoided terms (datasource,
  warehouse, connection, prod db, dry run, test run, logged/tracked query, proxy, gateway, panel and others) found
  none in the tool or property descriptions.
- Trap for later features: a new tool, a renamed tool or an undescribed input property now fails both the
  acceptance test and `src/mcp/server.test.ts`. Write descriptions in CONTEXT.md glossary terms.
- 2026-11-08T19:20:06Z supervisor: mcp-tool-catalog passed the gate in round 1

## mcp-no-ee-imports (2026-11-08)

- No source change was needed: the package was already independent of packages/backend. The feature check passed
  on arrival (4/4).
- Verified by hand after `bash ./init.sh`:
  - `grep -rnE "packages/backend|@lightdash/backend|/ee/|backend" src` in packages/telemetry-mcp found no match,
    and neither did the built `dist/` or the tsconfig files.
  - package.json depends only on @modelcontextprotocol/sdk, jose, pg, pg-cursor and zod (dev: @types/*,
    typescript, vitest). There are no workspace: dependencies.
  - `git diff --stat 6855d0840 -- packages/backend/src/ee` was empty, there were no untracked files under it, and
    nothing under packages/backend changed at all since the base commit.
- Trap for later features: don't import shared types from the backend (e.g. warehouse or ee code). If a type is
  needed, copy the narrow shape into the package, and never touch packages/backend/src/ee (decision no_ee_changes).
- 2026-11-08T19:20:55Z supervisor: mcp-no-ee-imports passed the gate in round 1

## mcp-dockerfile (2026-11-08)

- Added `packages/telemetry-mcp/Dockerfile` (written, never built: workers have no Docker). Build context is the
  repo root: `docker build -f packages/telemetry-mcp/Dockerfile .`.
  - Two stages, both `node:24.22.1-trixie-slim` (matches .nvmrc and the main image). The acceptance test requires
    every FROM to be `node:24…`, so pnpm comes from `corepack enable` and the root `packageManager` pin, not from
    the ghcr pnpm image the root dockerfile uses.
  - Build stage: `COPY . .`, `pnpm install --frozen-lockfile --filter @lightdash/telemetry-mcp...`, build, then the
    same install with `--prod` to drop dev deps. Runtime copies root node_modules (pnpm store) plus the package's
    package.json, node_modules and dist at their workspace paths, root-owned.
  - `USER node`, `EXPOSE 8080` (MCP_PORT default), `HEALTHCHECK` runs `node -e fetch(.../healthz)` (no curl in slim),
    `CMD ["node", "dist/main.js"]`. No secret ENV/ARG; only NODE_ENV, MCP_HOST, MCP_PORT.
- Tested: after `bash ./init.sh`, feature check 3/3. Ran the HEALTHCHECK command against local stub servers: exit 0
  on 200, 1 on 503 and 1 when nothing listens.
- Follow-ups for whoever first builds it: pin the base image by digest (no network here to resolve it); confirm
  pnpm 12's filtered `--frozen-lockfile` install and the `--prod` prune work in the container; consider a
  package-scoped .dockerignore if the root context is too large.
- 2026-11-08T19:22:43Z supervisor: mcp-dockerfile passed the gate in round 1

## mcp-readme (2026-11-08)

- Added `packages/telemetry-mcp/README.md`: what the server does (bearer challenge, Okta check, user mapping and
  attributes, hrx.identity tokens, caps, /healthz), a table of all 14 tools, a table of every env var read by
  `src/config.ts` (the 23 the test lists plus `MCP_ASK_MAX_STEPS` and `LOG_LEVEL`) with required/default/meaning,
  and the `pnpm -F @lightdash/telemetry-mcp` build, typecheck, start and single-file test commands.
- It links to `docs/eng-1799/telemetry-mcp.md`, which does not exist yet: the next feature (mcp-docs-attach-guide)
  creates it. The link is relative (`../../docs/eng-1799/telemetry-mcp.md`).
- Checked each claim against the source: time inputs are ISO-8601 or `now`/`now-<duration>` (not epoch); the
  acceptance harness imports `src/index.ts`, not `dist/`; defaults come from `loadConfig`.
- Tested as a user: read the README through; scanned it for the test's AVOID_TERMS and for the wider CONTEXT.md
  _Avoid_ lists (warehouse, connection, proxy, gateway, execution, panel, dry run…) and found none; ran the README's
  documented unit-test command (`src/config.test.ts`, 6/6). After `bash ./init.sh` the feature check passed 3/3.
- Trap: if a tool or env var is added or renamed, update the README tables too (the readme test pins the names).
- 2026-11-08T19:24:51Z supervisor: mcp-readme passed the gate in round 1

## mcp-docs-attach-guide (2026-11-08)

- Added `docs/eng-1799/telemetry-mcp.md`. It has sections on prerequisites, attaching the server to a Lightdash
  agent (an Operations Project MCP server with auth type `oauth` and credential scope `user`, OAuth credential sharing
  off, then enabled per agent), attaching it to Claude Code (`claude mcp add --transport http telemetry <url>/mcp`,
  then `/mcp` to sign in), Auth (the 401 `WWW-Authenticate` challenge, then protected-resource metadata, Okta with
  PKCE, the JWKS/RS256/iss/aud/exp checks and key rotation, mapping the user by email, the user attributes table, and
  `hrx.identity` tokens) and "Preview only" (`write_preview`, which nothing can commit).
- Checked each claim against the source. The identity token lifetime is 60 s (`IDENTITY_TOKEN_LIFETIME_SECONDS`);
  CONTRACTS allows up to 300 s. The audit source is `mcp`. The Lightdash agent fields (authType
  none/bearer/oauth, credentialScope shared/user, allowOAuthCredentialSharing) come from
  `packages/common/src/ee/AiAgent/index.ts` (read only).
- Fixed one README sentence that said Restricted Telemetry was readable with `telemetry_restricted`. MCP tokens
  always carry `agent = true`, so the engine never returns it through MCP (CONTRACTS §7). The readme check still
  passes 3/3.
- Tested as a user: ran `dist/main.js` with dummy env on 127.0.0.1. POST /mcp with no token got 401 and the
  challenge to `/.well-known/oauth-protected-resource/mcp`. A bad token got 401 with `error="invalid_token"`. The
  metadata named the `/mcp` resource and the Okta issuer. I stopped the server afterwards. Scanned the doc for the
  CONTEXT.md _Avoid_ terms and found none. Feature check 5/5.
- Open item for deployment: Okta must accept Claude Code and Lightdash as OAuth clients (redirect URIs or dynamic
  registration). The doc calls this Okta app setup; nobody has confirmed it against the real Okta.
- 2026-11-08T19:27:32Z supervisor: mcp-docs-attach-guide passed the gate in round 1
