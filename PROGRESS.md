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
