# Line `ldq` progress: Lightdash query path, access, Investigate, Write Mode, audit UI

Read first: `CONTEXT.md` (glossary; never use an `_Avoid_` term in code, UI copy or docs),
`docs/adr/0001`–`0004`, and `docs/eng-1799/CONTRACTS.md` (§2, §3, §4.1, §4.2 are this line's).
Alert Rules, new chart types and the Grafana importers belong to other lines. Don't touch them.

The feature list is `features.json`, kept by the supervisor. Take features strictly in list order.
Each feature's `check` is one command run from the repo root after `bash ./init.sh`.

## How to run things

| What | Command (from the repo root) |
|---|---|
| Prepare the tree | `bash ./init.sh` (about 1 s when warm, about 50 s cold) |
| One check | the feature's `check`, e.g. `TZ=UTC pnpm -F backend exec vitest run --config vitest.config.ts src/__acceptance__/ldq/write-preview-route.test.ts` |
| Typecheck (the regression gate) | `pnpm -F common typecheck && pnpm -F warehouses typecheck && pnpm -F backend typecheck && pnpm -F frontend typecheck` |
| One backend unit test | `TZ=UTC pnpm -F backend exec vitest run --config vitest.config.ts <file>` |
| One frontend test | `pnpm -F frontend exec vitest run <file>` |
| Regenerate TSOA routes by hand | `pnpm -F backend generate-api:build` (formatted; an unchanged API leaves no diff) |

- **All packages use vitest, not jest.** The goal text says `pnpm -F backend exec jest`; that is
  wrong for this fork. Every package config already sets `TZ=UTC`; the checks set it too.
- **`init.sh` starts no servers.** The line's goal says that init only installs and builds. It
  overrides the generic "start the app" step, because several lines share this machine. What init does:
  1. `pnpm install --frozen-lockfile`, only when `package.json` or the lockfile changed.
  2. It builds `common`, `warehouses`, `formula` and `visualization` when their sources changed.
     The frontend tests and the CLI build import common's `dist`. The backend and frontend
     typechecks resolve `@lightdash/formula` and `@lightdash/visualization` from `dist`.
  3. It regenerates `packages/backend/src/generated/routes.ts` and `swagger.json` whenever
     backend or common sources changed. The route checks drive the real TSOA routes, so a new
     controller needs this. A generation failure is a warning, not fatal: only the route checks
     depend on it.

  Change stamps live in `tmp/.ldq-init/`, with build logs next to them.
- `tmp/` (repo root) is gitignored now. Throwaway Postgres clusters and init stamps go there.
- The frontend vitest suite as a whole is red upstream: 123 files fail because
  `src/testing/testUtils.tsx` mocks paths that don't exist. Never use `renderWithProviders`.
  Run single files.

## Architecture found

- pnpm monorepo, TypeScript 7 (`tsrs` typechecks, `tsc --build` builds). Backend: Express +
  TSOA controllers (`packages/backend/src/controllers/**`, v2 under `controllers/v2/`), services
  reached through `req.services.getXService()` (`ServiceRepository.ts`), knex models and migrations
  (`src/database/migrations`). The frontend is React 19 + Mantine 8 + react-query.
- Postgres client: `packages/warehouses/src/warehouseClients/PostgresWarehouseClient.ts`.
  - Per-query session setup happens in `streamQueryAttempt`: `SET statement_timeout`, then
    `prepareSession(client)` (a protected hook, empty by default), then the agent `SET`, then the
    timezone.
  - `runQuery` goes through it too.
  - Agent sessions come from the `agentSession` option. `WarehouseClientFactory` sets it when the
    request has an agent identity or an AI plan.
  - Request-scoped agent detection uses `agentExecutionContext` (AsyncLocalStorage,
    `services/AiAccessService/agentExecutionContext.ts`).
- Reserved parameters: `packages/common/src/parameters/reservedParameters.ts` (`RESERVED_PARAMETERS`,
  `resolveReservedParameterValues(context)`).
  - Used today by `QueryComposer` (metric queries) with `{ dateZoom }`.
  - The SQL runner substitutes parameters with `safeReplaceParametersWithSqlBuilder`, which
    quotes values.
  - The cache key is `QueryHistoryModel.getCacheKey(projectUuid, { sql, ... })` over the
    compiled SQL.
- Dashboards: versioned fields live on `dashboard_versions` (`config` is jsonb). Use
  `DashboardModel.create` / `addVersion` / `getByIdOrSlug`. Dashboard-as-code types are in
  `common/src/types/contentAsCode/dashboards.ts`.
  - The JSON schema `common/src/schemas/json/dashboard-as-code-1.0.json` is generated from the
    backend `swagger.json`: run `pnpm -F backend generate-api:build`, then
    `pnpm -F common generate:dashboard-as-code-schema`.
  - Use index-signature literals (`{ [tileUuid: string]: ... }`), not `Record<string, ...>`, in
    types TSOA sees (see the comment above `DashboardTileTargets` in `common/src/types/filter.ts`).
- dbt targets are built in `backend/src/dbt/targets/index.ts` (`toDbtTarget`). Project adapters
  come from `backend/src/projectAdapters/projectAdapter.ts` (`projectAdapterFromConfig`; native git
  is `type: 'github'` + `semanticLayer: 'lightdash'`).
- CLI: commander in `packages/cli/src/index.ts`, handlers in `src/handlers/`. SQL charts as code are
  written to `<path>/charts/<slug>.yml` with `contentType: sql_chart` (see `handlers/download.ts`).
- Backend `setupVitest.ts` stubs global `fetch`. Tests that talk to a fake engine call
  `vi.unstubAllGlobals()` first. Implementations can use global `fetch`.

## Interfaces the acceptance tests pin

The tests live in the protected folders `packages/*/src/__acceptance__/ldq/` and can't be edited.
They load feature modules through `load('<path>')`, a non-literal dynamic import. That keeps the
folders typechecking before the features exist, and keeps the regression typecheck green, so
**export exactly these names from exactly these paths.**

### common (export everything from `packages/common/src/index.ts`)
- **Federation credentials.** `CreatePostgresCredentials` gains `flavor?: 'postgres' | 'federation'`,
  `identitySigningSecret?: string` and `httpBaseUrl?: string`.
  - `'identitySigningSecret'` goes in `sensitiveCredentialsFieldNames` (the existing stripping and
    `ProjectModel.mergeMissingWarehouseSecrets` then handle it).
  - Exports: `FEDERATION_DEFAULT_PORT = 5433`, `FEDERATION_DEFAULT_DBNAME = 'operations'`,
    `isFederationCredentials(creds?)` and `isFederationProject(project?)` (reads
    `project.warehouseConnection`).
  - No `WarehouseTypes` member. Nothing under `packages/backend/src/ee/` changes.
- **Time.**
  - `resolveTimeRange({from,to}, {now: Date, refreshInterval?: string|null}) → {from,to}`
    returns ISO strings from `Date#toISOString()`.
  - `getReservedTimeParameterValues(range, {now, refreshInterval?, maxDataPoints?}) →
    {__from,__to,__interval,__range}`.
  - `formatPrometheusDuration(ms)`.
  - `RESERVED_PARAMETERS` gains `__from`, `__to`, `__interval` and `__range`.
    `ReservedParameterContext` gains optional `timeRange`, `refreshInterval` and `now`.
  - Relative syntax: `now` and `now-<n><s|m|h|d|w>`. Relative bounds are rounded down to the
    refresh interval, or to 10 s. Absolute bounds are never rounded. `from > to` throws, and so
    does an unparsable bound.
  - `__interval` = ceil to a nice step of `(to-from)/maxDataPoints` (default 1000), floor 15 s.
  - `__range` uses compound largest units (`1d2h5s`, `1h30m`, `0s`).
- **Dashboard Time Range.**
  - `DASHBOARD_REFRESH_INTERVALS = ['10s','30s','1m','5m','15m','30m','1h']`.
  - Shape: `{ from, to, refreshInterval: <one of those> | null, tileTimeDimensions: { [tileUuid]: { fieldId, tableName } } }`.
  - `isValidDashboardTimeRange(value)`.
  - `getDashboardTimeRangeFilterRules({ timeRange, tileUuids, now })`: one `inBetween` rule per
    mapped tile. Its values are the resolved `[from,to]`, and its `tileTargets` holds the tile's
    target with every other listed tile set to `false`.
  - `isTileAffectedByTimeRange({ timeRange, tile: {uuid,type}, sql? })`.
  - `Dashboard.timeRange`, `CreateDashboard`/versioned fields and `DashboardAsCode.timeRange` are
    optional and nullable. As code, `tileTimeDimensions` is keyed by tile slug.
- **Investigate.**
  - `buildTelemetrySql(query)` with `kind` one of `promql | logql | logql_metric | cloudwatch |
    cloudwatch_logs | traceql | trace` (see the exact strings in the `telemetry-sql-*` tests). The
    time arguments are bare `${ld.parameters.__from}` / `__to` / `__interval`, which the
    parameter substitution quotes. Source names are appended last, and `'` is doubled.
  - `buildCloudWatchMetricDataQuery({namespace, metricName, dimensions, stat, period})` returns the
    AWS `MetricDataQuery` shape with `Id: 'm1'`.
  - `getTelemetryResultShape(columns) → 'metric'|'log'|'trace'|'table'`.
  - `isAuditedSql(sql)` matches `platform_(query|explain|tables|columns)(`.
  - `isAuditDescriptionRequiredError(message)`.
  - `PLATFORM_TABLES_SQL`, `buildPlatformColumnsSql(schema, table)`, `buildPlatformQuerySql(sql)`,
    `buildPlatformExplainSql(sql)` and `formatExplainPlanAsText(plan)` (Postgres text format,
    child indent `2 + 6*(depth-1)` then `->  `).

### warehouses
- `packages/warehouses/src/warehouseClients/FederationWarehouseClient.ts` exports
  `FederationWarehouseClient extends PostgresWarehouseClient`, re-exported from `src/index.ts`.
  `warehouseClientFromCredentials` returns it when `flavor === 'federation'`.
- `WarehouseClientOptions.getIdentityToken?: (context: { agent: boolean }) => Promise<string> | string`.
  - The federation client calls it once per query.
  - It sends `SET hrx.identity = '<token>'` on the query's own connection, immediately before the
    query (override `prepareSession`).
  - It never logs the token or puts it in errors.
  - Plain Postgres never calls it.
- The catalog (`getAllTables`, `getFields`, `getCatalog`) uses `information_schema` only: no
  `pg_catalog.` relations and no `pg_matviews`. The string literal `'pg_catalog'` in a schema
  filter is fine.

### backend
- `services/FederationIdentity/identityToken.ts` exports three functions.
  - `mintIdentityToken(claims, {secret, now, nonce?, ttlSeconds?})`. Output key order:
    `v, iss, sub, email, org, project, agent, sys, attrs{telemetry_restricted, platform_read,
    platform_write, platform_explain}, audit{description, ticket, source, resource_uuid}, iat, exp,
    nonce`. Missing values are `false`/`null`, ttl is capped at 300, and the nonce is 16 random bytes
    unless given.
  - `verifyIdentityToken(token, {secret, now})`.
  - `identityAttrsFromUserAttributes(map)`: true iff the values include exactly `'true'`.
- `services/FederationIdentity/FederationIdentityService.ts` exports `FederationIdentityService`.
  - Constructor: `({ userAttributesModel, clock?, ... })`.
  - `mintForUser({ secret, user: {userUuid,email,organizationUuid}, projectUuid, agentSession?, audit })`.
    It reads `userAttributesModel.getAttributeValuesForOrgMember({organizationUuid,userUuid})`.
  - `agent` is true when `agentSession` is true, or when `agentSession` is omitted and
    `agentExecutionContext.getStore()` is set.
  - `audit.source` must be one of the contract's values, else it throws.
  - `createTokenProvider(sameArgs) → (context?: {agent?: boolean}) => Promise<string>`.
- `services/FederationService/FederationService.ts` exports `FederationService`.
  - Constructed with `{ projectModel: { getWithSensitiveFields }, userAttributesModel }`. Further
    dependencies must be optional.
  - Its controller is a new v2 TSOA controller, and its only service call is
    `this.services.getFederationService()` (the route harness throws on any other getter). Register
    it in `ServiceRepository`.
  - `GET /api/v2/projects/{projectUuid}/federation/access` returns
    `{status:'ok', results:{isFederation, attrs}}`.
  - `POST /api/v2/projects/{projectUuid}/write/confirmations` takes `{statement}` and returns
    `{confirmationToken, expiresAt}`. 403 without `platform_write`; 4xx on non-federation projects.
  - `POST /api/v2/projects/{projectUuid}/write` takes
    `{statement, mode, confirmationToken, description, ticket?}`.
    - It returns 400 for a blank description or an unknown mode, and 403 without `platform_write`.
    - It returns 403 for `commit` inside an agent context, before the engine is called.
    - It calls `POST {httpBaseUrl}/v1/write` with `Authorization: Bearer <fresh token>` (audit
      `source: 'write_mode'`) and the body
      `{statement, mode, confirmation_token, description, ticket|null}`.
    - The result is `{status:'ok', results:<engine body>}`. Engine 4xx statuses are passed through.
  - `GET /api/v2/projects/{projectUuid}/federation/audit?ticket&user&month&cursor` calls
    `GET {httpBaseUrl}/v1/audit` with only the given params. 403 without `platform_read`, 400 for a
    month that isn't `YYYY-MM`.
- The v2 query routes `/query/sql`, `/query/dashboard-sql-chart` and `/query/dashboard-chart`
  accept `timeRange` (`{from,to,refreshInterval?}`), and `/query/sql` also accepts `audit`
  (`{description, ticket?}`). They pass both unchanged to the `AsyncQueryService` method.
- A migration adds the nullable jsonb column `dashboard_versions.time_range`. `DashboardModel`
  writes it on create and `addVersion` and reads it back as `timeRange`.
- `toDbtTarget` throws `ParameterError('dbt is not supported for the Federation Engine')` for a
  federation flavour.

### frontend (components are presentational: data and callbacks come in as props)
- **Time range control.** `features/timeRange/components/TimeRangePicker.tsx` exports
  `TimeRangePicker`.
  - Props: `{value, onChange, refreshInterval?, onRefreshIntervalChange?}`.
  - The trigger button shows the label, e.g. "Last 6 hours". Quick ranges ("Last 15 minutes",
    "Last 1 hour", "Last 24 hours", "Last 7 days", …) are in a popover, along with the "From" and
    "To" inputs and an "Apply" button.
  - A "Refresh" select (Off, 10s … 1h) appears only when `onRefreshIntervalChange` is given.
- **Dashboard Time Range** (`features/dashboardTimeRange/`):
  - `utils/urlState.ts` exports `readTimeRangeFromSearchParams` and `writeTimeRangeToSearchParams`.
    The `refresh=off` param means null, and epoch-ms bounds become ISO.
  - `components/DashboardTimeRangeSettings.tsx` takes `{tiles, value, onChange}`. Each tile gets a
    select labelled with the tile name, with a "None" option. Tiles without time dimensions say
    "No time dimension".
  - `components/TileTimeRangeIndicator.tsx` takes `{timeRange, tile, sql?}` and shows
    "Not affected by the time range".
  - `hooks/useDashboardAutoRefresh.ts` exports `useDashboardAutoRefresh(interval|null, onRefresh)`.
- **Investigate** (`features/investigate/components/`):
  - `SqlRunnerModeSwitch` takes `{project, mode, onModeChange}`. It is a radio group "SQL" /
    "Investigate", rendered only for federation projects.
  - `InvestigateEditor` takes `{onChange, initialSql?}`.
    - Source picker: a radio group (SegmentedControl) with Prometheus, Loki, CloudWatch metrics,
      CloudWatch Logs, Tempo and Platform Database.
    - Plain text areas, labelled: "PromQL"; "LogQL" with a "Metric query" checkbox; "TraceQL";
      "Platform SQL"; for CloudWatch metrics, the text inputs "Namespace", "Metric name",
      "Dimensions" (`Name=Value`, comma separated), "Statistic" and "Period", plus the textarea
      "MetricDataQuery JSON"; for CloudWatch Logs, "Log groups" (comma separated) and
      "Logs Insights query".
    - An optional "Source name" input, and an editable "SQL" textarea.
    - `onChange({kind, sql, statement?})` (`statement` is the raw Platform SQL).
  - `InvestigateResults` takes `{columns, rows, onOpenTrace?}`. It renders test ids
    `investigate-timeseries` (with `data-series-count`), `investigate-log-list` and
    `investigate-trace-table`, or a plain table.
  - `InvestigateWorkspace` takes `{access, runQuery, onSaveAsChart, writeApi?, initialTimeRange?}`.
    - Its pieces are the editor, a `TimeRangePicker` (default `now-6h..now`), "Run", the results,
      "Save as chart" (a modal with "Chart name" and "Save"), "Description" (required) and
      "Linear ticket" fields, "Explain", and a "Write Mode" switch.
    - `runQuery({sql, timeRange, audit?})`.
    - Platform Database: "Run" appears only with `platform_read`, and "Explain" with
      `platform_read || platform_explain`.
    - The Explain plan has "Download JSON" (`explain-plan.json`) and "Download text"
      (`explain-plan.txt`) data-URL links.
  - `PlatformSchemaBrowser` takes `{loadTables, loadColumns, onInsert}` and has a
    "Search tables" input.
  - `SavedSqlPicker` takes `{items, onSelect}` and has a "Search saved SQL" input. It shows
    "No saved SQL yet" when the list is empty.
  - `WriteModePanel` takes `{statement, api: {createConfirmation, write}}`.
    - Fields: "Description", "Linear ticket" and "Type COMMIT to confirm".
    - Buttons: "Preview" and "Commit". Results appear in `data-testid="write-mode-result"`; the
      workspace wraps the panel in `data-testid="write-mode-panel"`.
- **Audit browser.** `features/auditBrowser/components/AuditBrowser.tsx` takes
  `{canRead, fetchPage}`.
  - Filters: "Ticket", "User", "Month", then "Apply filters". Paging: "Next page".
  - It shows `linearTicketId`, `executedByEmail` and `description` of the portal's `Execution`
    records.
- Wire the presentational pieces into real pages/hooks yourself (SQL Runner page, dashboard header,
  dashboard settings, an audit page route). Those wirings have no acceptance check of their own.
  Give them unit tests and keep the typecheck green.

### cli
- `lightdash import portal-scripts <file.json> [--path <dir>=./lightdash] [--space <slug>=platform-saved-sql]`.
  - It writes one `<path>/charts/<slug>.yml` per portal `SavedScript`. Slugs come from
    `generateSlug(title)`; duplicates get `-2`, `-3`, ….
  - Each file holds: `version: 1`, `contentType: sql_chart`, `name`, `description`, `slug`, `sql`,
    `limit`, `spaceSlug`, `chartKind: table`, `config.type: table`.
  - It never copies the portal user fields.
  - It prints the count. A non-array input exits non-zero with a message mentioning saved scripts.

## Work with no acceptance check of its own

These are in scope, but no check covers them, because their seams sit deep inside upstream's
largest files. Do them inside the features they serve, with unit tests, and keep edits small:
- `AsyncQueryService`:
  - Resolve the reserved time parameters from the request's `timeRange` (or the dashboard's
    saved one) before compiling and computing the cache key. Use `resolveReservedParameterValues`
    with `{timeRange, refreshInterval, now}`.
  - Merge `getDashboardTimeRangeFilterRules` into the dashboard filters for chart tiles.
  - Pass `audit` and the tile uuid through to the warehouse client options.
- `WarehouseClientFactory`: for federation credentials, pass `getIdentityToken` from
  `FederationIdentityService.createTokenProvider(...)`, with the secret from the credentials.
- `DashboardService` / the dashboard controllers: accept and return `timeRange`.
  `CoderService`: map `tileTimeDimensions` between tile uuids and slugs (like the date-zoom
  tile-target helpers).
- Investigate's "Save as chart" and the saved SQL list call the existing SQL chart (saved SQL)
  APIs. Shared saved SQL is an existing SQL chart in a space of the Operations Project.

## Conventions

- New code goes in new files. Upstream edits stay small: a registration line, a union member, a
  route mount. Never change `packages/backend/src/ee/**`; this line was measured to need zero
  changes there.
- Use the glossary terms in UI copy: Federation Engine, Investigate, Dashboard Time Range, Tile,
  Audited Query, Write Mode, Preview, Operations Project, Platform Database, Restricted Telemetry.
- Never log identity tokens, signing secrets or confirmation tokens. Fixtures are synthetic, with
  values like `test-secret-not-real`.
- Tests start their own servers on `127.0.0.1:0`, and Postgres via
  `src/__acceptance__/ldq/pgCluster.ts` in the repo's `tmp/` (no unix socket, stopped by the same
  test). No Docker, no fixed ports, no HouseRx network.
- Don't commit the formatted output of `generate-api:build` by hand. init.sh regenerates it, and
  the release workflow owns it upstream.

## Contract assumptions (narrowest compatible readings; the integration line reconciles)

1. **Identity token shape.** `audit` is always present; missing fields are `null`. `sys` defaults to
   `false`. Lifetime is exactly 300 s. A user attribute is true when any of its values is exactly
   `"true"` (Lightdash attributes are multi-valued).
2. **The token reaches the client through a callback.**
   `WarehouseClientOptions.getIdentityToken({agent})`. Without a provider, a federation client
   sends no `SET hrx.identity` (the engine treats that as no claims).
3. **Confirmation tokens** use the identity-token encoding:
   `base64url(json).base64url(HMAC-SHA256(identity secret, base64url(json)))` with
   `{v:1, statement_sha256 (hex), sub, project, exp, nonce}`. `exp` is at most 120 s ahead. §4.2
   gives the inputs but not the encoding.
4. **The engine write request** sends `ticket: null` when no ticket is given. Engine 4xx statuses
   (409 reused confirmation, 403 guard) are returned to the browser unchanged.
5. **ISO timestamps** for `__from`/`__to` are `Date#toISOString()`, with milliseconds.
   `__range` uses compound units, largest first (`1h30m`, `1d`).
6. **Restricted Telemetry is enforced only by the engine.** Lightdash can't see the engine's
   restricted selectors, so Investigate asks for a description when the engine answers
   "audited query requires a description" and reruns. The schema browser's `platform_tables` and
   `platform_columns` calls are Audited Queries, so they must send a description, e.g.
   "Platform Database schema browser".
7. **Explain-only scope.** It applies to the Platform Database source only. Telemetry runs as
   usual, and Explain also needs a description.
8. **CloudWatch metric queries** use AWS's `MetricDataQuery` JSON shape (Id, MetricStat{Metric{Namespace, MetricName, Dimensions[]}, Period, Stat}, ReturnData) with default `Id: 'm1'`.
9. **The audit browser** passes the engine's `Execution` items (the portal's
   `api/src/dynamo/executions.ts` fields) through unchanged.
10. **The portal saved-scripts export** is a JSON array of `SavedScript`.

## Status

- 2026-11-08 init session: wrote the 70-feature list and 70 acceptance tests (protected
  folders), plus `init.sh` and this file, and added `/tmp/` to `.gitignore`.
  - Every check fails on the initial tree, each for the intended reason: a missing module or
    route, or an assertion about behaviour that doesn't exist yet.
  - `init.sh` exits 0. The common, warehouses, backend, frontend and cli typechecks are green
    with the acceptance folders in place.
- No feature is built yet.
- 2026-11-08T16:35:35Z supervisor: initialized: 70 features, run 20261108-103050
- 2026-11-08T17:24:21Z supervisor: initialized: 70 features, run 20261108-121123
- 2026-11-08 ldq-federation-credential-fields (session):
  - `CreatePostgresCredentials` (common `types/projects.ts`) gains optional `flavor?: 'postgres' |
    'federation'`, `identitySigningSecret?` and `httpBaseUrl?` (CONTRACTS §4.1). No WarehouseTypes
    member was added.
  - `identitySigningSecret` is now in `sensitiveCredentialsFieldNames`, so the existing generic code
    (`stripSensitiveWarehouseCredentials`, `ProjectModel` secret merge, `omitEmptySecrets`, preview
    `mergeWarehouseCredentials`) treats it like `password` with no further edits.
    ldq-federation-secret-stripping should verify that end to end through the API.
  - New `packages/common/src/types/federation.ts`: `FEDERATION_FLAVOR`, `FEDERATION_DEFAULT_PORT`
    (5433), `FEDERATION_DEFAULT_DBNAME` ('operations'), `PostgresFlavor`, `FederationCredentials`,
    and the `isFederationCredentials` / `isFederationProject` guards. Use these guards wherever
    "federation project" appears in the spec. The connection form
    (ldq-postgres-form-federation-switch) should take its defaults from the constants.
  - Backend: two exhaustive per-field classification tables had to list the new keys.
    `personalCredentialOverlay.ts` marks them all 'connection' and
    `aiServiceAccountRoutingFields.ts` marks them all 'routing'. The reason: the signing secret and
    engine URL belong to the connection and must survive personal or AI service account credential
    overlays, otherwise token minting breaks for those users.
  - `src/generated/routes.ts` and `swagger.json` were regenerated by init.sh. The diff is exactly the
    three new fields, and tsoa body validation needs it.
  - Tested: built common through init. Validated a federation body against the regenerated tsoa
    `CreatePostgresCredentials` model with throw-on-extras: 0 errors, and a bogus flavor is
    rejected. Stripping removes user, password and identitySigningSecret and keeps flavor and
    httpBaseUrl. Also ran the feature check (5/5), the common unit tests, the related backend unit
    tests, and the backend and frontend typechecks.
- 2026-11-08T17:32:03Z supervisor: ldq-federation-credential-fields passed the gate in round 1
- 2026-11-08 ldq-federation-secret-stripping (session):
  - The check already passed on arrival, because ldq-federation-credential-fields put
    `identitySigningSecret` in `sensitiveCredentialsFieldNames`. I traced the real paths:
    `ProjectModel.get` and `stripSensitiveWarehouseCredentials` (the API responses) drop it.
    `ProjectService` update → `ProjectModel.mergeMissingProjectConfigSecrets` →
    `mergeMissingWarehouseSecrets` restores it when it comes back as `''` or is omitted (after
    `omitEmptySecrets`).
  - One change, in `backend/src/utils/credentialDestination.ts`: the Postgres credential
    destination now includes the normalized `httpBaseUrl` (Redshift is unchanged). Saved secrets
    only carry over when the destination is unchanged. Before this change, pointing a federation
    connection at a different engine URL, with the same host and port, silently kept the saved
    signing secret. Tokens minted with it would then go to the new URL. Plain Postgres has no
    `httpBaseUrl`, so both sides normalize to `''` and nothing changes for it. Contract
    assumption: a new engine URL counts as a new destination, so the admin must re-enter the
    secret. Unit test added in `credentialDestination.test.ts`.
  - Tested: ran a throwaway in-process round trip (deleted afterwards). Save federation creds with
    the secret → the strip function's response has no secret → resubmit the loaded form with blank
    password and secret, both raw and through `omitEmptySecrets` → the merged project keeps the
    stored secret. Changing httpBaseUrl drops it. I did not boot the full server: it needs a
    migrated DB and session. I ran the feature check (3/3), the credentialDestination,
    ProjectModel, ProjectService, WarehouseConnectionService, AiServiceAccountService and
    inheritUpstreamSshTunnelPrivateKey unit tests (2540 pass), and the backend typecheck.
  - Trap: running the whole `src/__acceptance__/ldq/` folder shows many failures. Those belong to
    features that aren't built yet. Run single check files.
- 2026-11-08T17:37:29Z supervisor: ldq-federation-secret-stripping passed the gate in round 1
- 2026-11-08 ldq-federation-warehouse-client (session):
  - New `packages/warehouses/src/warehouseClients/FederationWarehouseClient.ts`: an empty
    `class FederationWarehouseClient extends PostgresWarehouseClient {}`, exported from the
    package index. `warehouseClientFromCredentials` returns it for Postgres credentials where
    `isFederationCredentials` is true (from common). `flavor: 'postgres'` and no flavor still get
    `PostgresWarehouseClient`. It deliberately has no overrides yet. Later features add them here:
    the information_schema catalog (ldq-federation-catalog), `SET hrx.identity`
    (ldq-federation-identity-set) and turning off `pg_matviews`/version gating.
  - Backend `WarehouseClientFactory.buildClient`: compile-group (multi-connection compile)
    acquisitions used to build `ListedDatabasesPostgresWarehouseClient` for every Postgres
    connection. That bypassed the factory, so a federation connection would have lost its client.
    Federation credentials are now excluded from that branch and go through
    `getWarehouseClientFromCredentials`. Contract assumption: the engine exposes a single database
    (`operations`), so listing other databases does not apply to it.
  - Trap for ldq-federation-catalog and the identity features: `PostgresWarehouseClient`
    internally does `new PostgresWarehouseClient({...credentials, dbname})` (in
    `withClientForDatabase`, and in `ListedDatabasesPostgresWarehouseClient`) for other databases.
    Those inner clients are plain Postgres and skip any federation override.
  - Tested: init, then the feature check (3/3). Loaded the built `dist` the way the backend does and
    called `warehouseClientFromCredentials` with federation, postgres and no-flavor credentials. I
    got FederationWarehouseClient, PostgresWarehouseClient and PostgresWarehouseClient; all are
    instanceof PostgresWarehouseClient with adapter 'postgres'. Also ran the warehouses and
    backend typechecks, oxlint on the changed files, the backend WarehouseClientFactory unit tests
    (839 pass) and PostgresWarehouseClient.test.ts (35 pass). Root `prettier --check` finds no config
    and flags even unchanged HEAD files for quote style. Ignore that.
- 2026-11-08T17:44:13Z supervisor: ldq-federation-warehouse-client passed the gate in round 1
- 2026-11-08 ldq-federation-catalog (session):
  - `FederationWarehouseClient` now overrides `supportsMatviews()` to return `false` without
    querying. The inherited `getAllTables`, `getFields` and `getCatalog` then send only their
    `information_schema.tables`/`.columns` part: no `pg_matviews`/`pg_class`/`pg_attribute`
    UNION, and no `SELECT version()` lookup. That covers CONTRACTS §4.1: "information_schema
    only" and "version() gating turned off". Effect: materialized views are not listed for the
    engine, which has none anyway.
  - `listDatabases()` is overridden to return only the configured `dbname` (isDefault, not
    truncated). The base version reads `pg_database`, and any other database would be opened
    with a plain `PostgresWarehouseClient` (the trap from the previous entry). With one database,
    `getTablesForDatabase` always uses `this`. Contract assumption: the engine serves a single
    database (the same assumption as WarehouseClientFactory's compile-group exclusion).
  - Tested: init, then the feature check (1/1). It runs a real throwaway Postgres with statement
    logging and asserts that the tables, fields and catalog come back with `information_schema`
    and nothing matching pg_catalog relations. Also ran federation-client-factory (3/3),
    PostgresWarehouseClient.test.ts (35/35) and the warehouses `tsc --noEmit`. Called the built
    `dist` `listDatabases` on a federation client: it returns only `operations`.
  - Not built here: `SET hrx.identity` (ldq-federation-identity-set). The check passes a second
    `{ getIdentityToken }` argument to `warehouseClientFromCredentials`, and it is currently
    ignored.
- 2026-11-08T17:49:24Z supervisor: ldq-federation-catalog passed the gate in round 1
- 2026-11-08 ldq-identity-token-mint (session):
  - New `packages/backend/src/services/FederationIdentity/identityToken.ts` with
    `mintIdentityToken(claims, { secret, now?, nonce?, ttlSeconds? })`. The payload is built
    field by field in the CONTRACTS §3 key order (v, iss, sub, email, org, project, agent, sys,
    attrs{telemetry_restricted, platform_read, platform_write, platform_explain},
    audit{description, ticket, source, resource_uuid}, iat, exp, nonce). The token is
    unpadded base64url JSON, then '.', then base64url HMAC-SHA256(secret, encoded payload).
    `v` is always 1. iat is floor(now/1000). The lifetime is min(ttlSeconds, 300) (default 300,
    floored at 0). The nonce defaults to 16 random bytes; a nonce of any other length throws, and
    so does an empty secret.
  - Contract assumptions: omitted `agent`/`sys`/attrs mean false. Omitted audit
    description/ticket/resource_uuid mean null (the acceptance test needs this). Mapping attrs
    from user attributes ("true" means true) is NOT done here; it belongs to
    ldq-identity-token-attrs (`identityAttrsFromUserAttributes` in this module).
  - Not built here: `verifyIdentityToken` (identity-token-verify.test.ts loads it from this same
    module) and `FederationIdentityService` (the provider, agent and audit tests).
  - Tested: init, then the feature check (4/4). Backend `tsc --noEmit` is clean. I ran a tsx
    script that minted a token: it has no '=' padding, an independent HMAC matches the
    signature, the decoded payload has the defaults and exp-iat=300 with ttlSeconds=1000, and a
    fixed clock and nonce give identical tokens. Use `pnpm exec`, not `npx`: npx fails the
    devEngines node-version check under node 26.
- 2026-11-08T17:52:23Z supervisor: ldq-identity-token-mint passed the gate in round 1
- 2026-11-08 ldq-identity-token-verify (session):
  - Added `verifyIdentityToken(token, { secret, now? })` and `InvalidIdentityTokenError` to
    `packages/backend/src/services/FederationIdentity/identityToken.ts`. The order of checks:
    the shape (exactly two non-empty '.' parts), then the HMAC (constant-time compare, before
    anything is parsed), then the JSON object, `v === 1`, numeric iat/exp, expiry, and finally
    iat no more than 60 s ahead (`MAX_IDENTITY_TOKEN_CLOCK_SKEW_SECONDS`). It returns the parsed
    payload as is. Other claims are not validated field by field.
  - Contract assumptions: "exp has passed" means floor(now/1000) > exp, so a token is still
    accepted at exactly `exp`. An iat exactly 60 s ahead is accepted; 61 s ahead is refused. An
    empty secret throws a plain Error, not InvalidIdentityTokenError.
  - Tested: init, then the feature check (5/5), identity-token-byte-exact (4/4) and backend
    `tsc --noEmit`, and oxfmt passes. A tsx script under ../tmp/verify minted a token and ran
    it through the verifier. It was accepted 100 s in and also at exactly exp. It was refused
    1 s after exp ("expired"), 61 s before iat ("issued in the future"), and with a wrong
    secret or a tampered token ("bad signature").
- 2026-11-08T17:55:12Z supervisor: ldq-identity-token-verify passed the gate in round 1
- 2026-11-08 ldq-identity-token-user-attrs (session):
  - Added `identityAttrsFromUserAttributes(map)` to `services/FederationIdentity/identityToken.ts`.
    An attr is true only if one of its values is exactly "true" ("yes", "True" and missing are
    false). Values can come from several groups, so ['false','true'] counts as true; the
    acceptance test requires this.
  - New `services/FederationIdentity/FederationIdentityService.ts`. The constructor takes
    `{ userAttributesModel, clock? }`. `mintForUser({ secret, user: {userUuid, email,
    organizationUuid}, projectUuid, audit })` calls
    `userAttributesModel.getAttributeValuesForOrgMember({ organizationUuid, userUuid })` and
    mints with iss 'lightdash', sub = userUuid, the clock's time and the default 300 s TTL.
  - Not built here: `agent` (ldq-identity-token-agent), audit source validation (the audit
    test expects source 'dashboard' to reject; ldq-identity-token-audit-block),
    `createTokenProvider` (ldq-identity-token-provider), and registration in
    ServiceRepository/the query path. The service is a plain class, not a BaseService, because
    the acceptance tests construct it with only these two arguments.
  - Tested: init, then the feature check (3/3), identity-token-byte-exact and verify (12/12
    together), backend `tsc --noEmit` and oxfmt. As a user: a scratch vitest (deleted
    afterwards) used migratedDatabase with the real UserAttributesModel. The admin created the
    `platform_read` attribute with the user value 'true' and `platform_write` with 'yes'. Minting
    for that user on a project gave a validly signed token with platform_read true,
    platform_write false and the other attrs false, and exp-iat=300.
- 2026-11-08T17:58:57Z supervisor: ldq-identity-token-user-attrs passed the gate in round 1
- 2026-11-08 ldq-identity-token-agent (session):
  - `FederationIdentityService.mintForUser` takes an optional `agentSession?: boolean` and sets
    the token's `agent` from the new exported `isAgentSession(agentSession)`. An explicit flag
    wins, the same way WarehouseClientFactory's `overrides.agentSession` reaches
    PostgresWarehouseClient. When the flag is absent, a live
    `agentExecutionContext.getStore()` (services/AiAccessService/agentExecutionContext) means
    agent. `sys` stays false, and attrs are still reported for agents (the engine refuses
    restricted reads).
  - Contract assumption: an explicit `agentSession: false` inside an agent context gives
    agent=false (the explicit flag wins, as in the factory). Whoever wires the query path
    (ldq-identity-token-provider) should pass WarehouseClientFactory's computed
    `agentSession` through, not leave it out.
  - Tested: init, then the feature check (3/3), plus the attrs, byte-exact and verify tests
    (15/15 together), backend `tsc --noEmit` and oxfmt. As a user: a scratch vitest (deleted
    afterwards) minted tokens through the service and verified each one. A person gave
    agent=false; agentSession:true gave true; inside a real MCP agent execution context it
    gave true (sys false, telemetry_restricted still true); explicit false inside the context
    gave false; after the context ended it gave false. Note: a standalone tsx script can't
    import these modules because parseConfig needs LIGHTDASH_SECRET, S3 and so on, so use a
    scratch vitest instead.
- 2026-11-08T18:02:35Z supervisor: ldq-identity-token-agent passed the gate in round 1
- 2026-11-08 ldq-identity-token-audit-block (session):
  - `identityToken.ts` now exports `IDENTITY_AUDIT_SOURCES` (investigate, tile, alert_rule,
    mcp, write_mode) and `isIdentityAuditSource`. `IdentityAuditSource` is derived from the
    array. `mintIdentityToken` refuses, before signing, an audit block whose `source` is unknown
    or missing (e.g. 'dashboard') or whose description/ticket/resource_uuid is not a string or
    null. It does this at runtime because callers may pass untyped request bodies. Since
    FederationIdentityService.mintForUser goes through mintIdentityToken, it rejects these too.
    Omitted description/ticket/resource_uuid still default to null (unchanged).
  - Contract assumption: an empty description is not rejected at mint time. CONTRACTS §2 has
    the engine refuse Audited Queries without a non-empty description (42501), and only
    Audited Queries need one, so tile/alert tokens may lack it.
  - Not wired into the query path yet (ldq-identity-token-provider will pass the audit block
    from Investigate/tile/alert callers).
  - Tested: init, then the feature check (3/3) and the attrs, byte-exact, verify and agent
    tests (15/15), backend `tsc --noEmit` and oxfmt --check. As a user: a scratch vitest
    (deleted afterwards) minted through FederationIdentityService and verified the tokens.
    Investigate with a description and ticket gave audit {description, ticket, source
    'investigate', resource_uuid null}. A tile gave {null, null, 'tile', the tile uuid}.
    Source 'dashboard', a missing source, and a numeric ticket were all refused.
- 2026-11-08T18:07:03Z supervisor: ldq-identity-token-audit-block passed the gate in round 1
- 2026-11-08 ldq-identity-token-provider (session):
  - `@lightdash/warehouses` (warehouseClientFromCredentials.ts) now exports
    `IdentityTokenContext` ({ agent: boolean }) and `IdentityTokenProvider`
    ((context) => Promise<string>). `WarehouseClientOptions` gains an optional
    `getIdentityToken?: IdentityTokenProvider`, documented as federation-only. No client reads
    it yet: ldq-federation-identity-set makes FederationWarehouseClient call it once per query
    with `{ agent: this-client's agentSession }` and send `SET hrx.identity`. Its acceptance
    test expects exactly that shape.
  - `FederationIdentityService.createTokenProvider(args)` (args = MintForUserArgs without
    `agentSession`, exported as `CreateTokenProviderArgs`) returns an IdentityTokenProvider.
    Every call goes through `mintForUser` with `agentSession: agent`, so each query gets a new
    nonce, iat and exp, and re-reads the user's attributes. The explicit agent flag from the
    client wins, which follows the agent session's contract assumption.
  - Not wired into WarehouseClientFactory/AsyncQueryService yet. The factory has no
    user/audit context; ldq-query-routes-time-range-audit ("passed to the async query service
    that ... mints the identity token") or an integration feature must build the provider
    there and pass it as `getIdentityToken` in the client options.
  - Tested: init, then the feature check (2/2) and all six identity-token acceptance tests
    (20/20). The warehouses catalog and factory acceptance tests passed (4/4). Backend and
    warehouses `tsc --noEmit` and oxfmt --check are clean. As a user: a scratch vitest
    (deleted afterwards) used a migrated throwaway DB with the real UserAttributesModel
    (org defaults platform_read 'true' and platform_write 'yes'). It passed the provider to
    warehouseClientFromCredentials for federation credentials and got a
    FederationWarehouseClient. Two calls in a row gave different tokens with different
    nonces, and both verified with verifyIdentityToken: platform_read true, platform_write
    false, agent false, ttl 300, audit kept. `{ agent: true }` gave agent true and sys false.
    A wrong secret was rejected.
- 2026-11-08T18:13:07Z supervisor: ldq-identity-token-provider passed the gate in round 1
- 2026-11-08 ldq-federation-identity-set (session):
  - `PostgresClient` (PostgresWarehouseClient.ts) has a new protected hook, `beforeQuery(client)`.
    It is a no-op by default. `streamQueryAttempt` runs it on the query's own pooled connection
    after statement_timeout, prepareSession, the agent SET and the timezone SET, and just before
    the query. runQuery and executeAsyncQuery both go through streamQuery, so they run it too.
  - `FederationWarehouseClient` now takes `FederationWarehouseClientOptions`
    ({ agentSession?, getIdentityToken? }). It stores the provider and overrides `beforeQuery`
    to call `getIdentityToken({ agent: this.agentSession })` once per query attempt, then send
    `SET hrx.identity = '<token>'`, with single quotes doubled so the SQL literal is safe. Plain
    `PostgresWarehouseClient` ignores `getIdentityToken`.
  - Contract assumption: a federation client created without `getIdentityToken` sends no
    identity and still runs the query. The engine then applies its own rules for a missing
    identity. I did not fail closed, because the backend does not pass a provider yet (see
    ldq-identity-token-provider's note). Catalog refreshes and other system queries would break
    until an integration feature wires `FederationIdentityService.createTokenProvider` into the
    client options. Whoever does that wiring should decide whether a missing provider becomes
    an error.
  - Trap for ldq-federation-identity-not-logged: if the SET fails, the pg error passes through
    `parseError(error, sql)` with the user's SQL, not the SET text. Check that error messages
    and console output never include the token.
  - Tested: init, then the feature check (3/3). The warehouses ldq acceptance tests plus the
    Postgres and Redshift unit tests passed (56/56). Warehouses `tsc --noEmit`, oxlint and
    oxfmt --check are clean. As a user: a scratch vitest (deleted afterwards) started a
    throwaway Postgres and used the real backend `mintIdentityToken` as the provider on an
    agent federation client. Two queries each read `current_setting('hrx.identity')` in the
    query itself, so the token was set on the same connection. The two tokens differed, and
    both verified with agent true and `lightdash.agent` = 'true'. A token containing a quote
    round-tripped intact. On a plain Postgres client the setting was empty and the provider
    was never called.
- 2026-11-08T18:17:39Z supervisor: ldq-federation-identity-set passed the gate in round 1
- 2026-11-08 ldq-federation-identity-not-logged (session):
  - The feature check already passed on arrival. On the normal path the token is only in the
    SET statement. Nothing logs SQL, and parseError only sees the user's SQL.
  - Closed the gap the previous session flagged. If `SET hrx.identity` itself fails,
    `FederationWarehouseClient.beforeQuery` now throws a fresh
    `WarehouseQueryError("Federation identity was rejected: ...")`. In that message the token,
    raw or SQL-quoted, is replaced with `[redacted]`, and there is no `cause`. streamQuery
    rethrows WarehouseQueryError unchanged, so the engine's raw error, which may echo the
    value, never reaches the message, JSON or logs.
  - Follow-up (not client logs, out of scope): with Sentry in non-OTel mode, Sentry's default
    Postgres span integration (see packages/backend/src/sentry.ts) records query text as a
    span attribute. That text would include `SET hrx.identity = '<token>'`. Whoever wires
    federation into the backend should check this. Options: drop that integration, or scrub
    db.statement for SET hrx.identity in beforeSendSpan.
  - Tested: init, then the feature check (1/1). The real failing query on a throwaway cluster
    names the table, the error and console contain no token, and the server log shows it was
    sent. A scratch vitest (deleted) made SET reject with the statement echoed in its message
    and detail. The resulting error's message, JSON and stack held neither the raw nor the
    quoted token. Warehouses ldq acceptance plus the Postgres unit tests passed (43/43).
    tsc, oxfmt and oxlint are clean.
- 2026-11-08T18:24:34Z supervisor: ldq-federation-identity-not-logged passed the gate in round 1
- 2026-11-08 ldq-federation-dbt-refused (session):
  - `postgresTarget` (packages/backend/src/dbt/targets/postgres.ts) now throws
    `NotSupportedError` (HTTP 400) when `credentials.flavor === 'federation'`. The message
    starts with "dbt is not supported for the Federation Engine." Every dbt path goes through
    the shared `toDbtTarget` (profiles.ts, CredentialResolverRegistry, the SSH-tunnel, OAuth and
    SSO resolvers, and the dev seed), so they all get the refusal in one place. Plain Postgres
    (flavour absent or 'postgres') is unchanged.
  - The AI service-account Postgres resolver already returns `kind: 'none'` and builds no
    target, so it needed no change.
  - Contract assumption: I chose to throw rather than return `{ kind: 'none', reason }`.
    The acceptance test expects a throw, and §4.1 says dbt "fails". Callers that catch
    `kind: 'none'` to skip dbt quietly therefore do not apply here.
  - Tested: init, then the feature check (2/2). Ran the dbt/targets, profiles and
    WarehouseClientFactory suites (1040/1040). Backend tsc, oxlint and oxfmt are clean. As a
    user: a scratch vitest (deleted) called `profileFromCredentials`, which builds
    profiles.yml for dbt runs. With federation credentials it threw NotSupportedError with
    status 400 and the message above. Plain Postgres still produced a `type: postgres` profile.
- 2026-11-08T18:32:04Z supervisor: ldq-federation-dbt-refused passed the gate in round 1
- 2026-11-08T18:35:23Z supervisor: ldq-federation-project-types halted: worker ldq.feature.ldq-federation-project-types.r1 stopped: STOP file present
- 2026-11-08 ldq-federation-project-types (session, round 1 after a STOP-file halt):
  - No code change was needed. The tree was clean on arrival, and the feature check already
    passed (4/4). Earlier features provide all of it.
    `warehouseClientFromCredentials` returns a FederationWarehouseClient. The `none` and
    native-git (`semanticLayer: 'lightdash'`, GitHub/Bitbucket) branches of
    `projectAdapterFromConfig` never resolve a dbt target. The dbt branches (dbt, and
    dbt-on-git) call the lazy `dbtTarget.resolve()`. In ProjectService that is
    `warehouseClientFactory.toDbtTarget`, which reaches the `postgresTarget` refusal.
  - Contract assumption: CONTRACTS §4.1 places the refusal "at the point where the dbt target
    is built". So MANIFEST and DBT_CLOUD_IDE projects (no dbt target is built) are not
    refused on federation connections. Left as is. The integration line can decide whether
    they should be.
  - Tested: init, then the feature check (4/4). A scratch vitest (deleted) ran against a
    throwaway Postgres in tmp/. A `none` adapter on federation credentials held a
    FederationWarehouseClient. `adapter.test()` and a query each sent `SET hrx.identity`
    before running, and the config loaded. A local dbt project and a GitHub dbt project both
    threw NotSupportedError (400) "dbt is not supported for the Federation Engine. ...".
    Plain Postgres still built a DbtLocalCredentialsProjectAdapter. Native-git was tested
    only up to construction, because cloning would need the network.
- 2026-11-08T18:39:54Z supervisor: ldq-federation-project-types passed the gate in round 1
- 2026-11-08 ldq-postgres-form-federation-switch (session):
  - `PostgresForm.tsx` (frontend ProjectConnection/WarehouseForms) now has a "Federation Engine"
    Mantine `Switch` at the top of the form, bound to `warehouse.flavor`. When it is on, the form
    shows "Identity signing secret" (a PasswordInput) and "Engine HTTP URL" (`httpBaseUrl`)
    below DB name. Turning it on sets flavor 'federation' and port 5433 / dbname 'operations'.
    Turning it off sets flavor 'postgres', restores 5432 / '', and clears the secret and URL.
    The defaults are swapped only when the field still holds the other flavour's default (or
    is empty), so values the user typed are kept. The constants come from
    `@lightdash/common` (FEDERATION_DEFAULT_PORT/DBNAME/FLAVOR).
  - Trap: use a plain Mantine `Switch`, not the repo's `BooleanSwitch`. BooleanSwitch renders
    its label as `<Text>`, not a `<label>`, so `getByLabelText` cannot find it. Also, a Switch
    `description` sits inside its `<label>` and breaks an exact label match, so the
    description is a separate `Input.Description`.
  - The secret is required unless the saved project is already a federation connection. That
    matches the secret-stripping feature: a blank secret on save keeps the stored one.
  - Tested: init, then the feature check (3/3). A scratch user-flow vitest (deleted) clicked
    the switch by role: on gave 5433/operations and showed both fields. Off gave 5432/'',
    hid the fields and cleared the secret. A typed DB name survived switching back on.
    Frontend typecheck, oxlint and oxfmt are clean. Not driven in a live browser (no browser
    tool, and the full app needs backend + DB).
- 2026-11-08T18:43:25Z supervisor: ldq-postgres-form-federation-switch passed the gate in round 1
- 2026-11-08 ldq-federation-access-route (session):
  - New `GET /api/v2/projects/{projectUuid}/federation/access` (controllers/v2/FederationController.ts,
    operationId `getFederationAccess`) returns `{status:'ok', results:{isFederation, attrs}}`,
    where attrs holds the four ldq claims. New `services/FederationService/FederationService.ts`
    with `getAccess(account, projectUuid)`: it reads the project via
    `projectModel.getWithSensitiveFields`, checks `view Project` (403 otherwise), and reads
    `userAttributesModel.getAttributeValuesForOrgMember` for `account.user.userUuid`. The
    mapping reuses `identityAttrsFromUserAttributes` (only "true" is true). Only booleans
    leave the service, never the project or its credentials.
  - ServiceRepository has `getFederationService()` (manifest key `federationService`). Its deps
    are `{projectModel, userAttributesModel}`, the two routeHarness pins. Later
    write/audit features will need more deps (engine HTTP, identity minting). Add them
    as optional constructor args or build them from those two, because
    routeHarness.buildFederationService passes only these two.
  - common `types/federation.ts` gains `FederationAttrs`, `FederationAccess` and
    `ApiFederationAccessResponse`. Backend `IdentityAttrs` is now an alias of `FederationAttrs`.
  - Tested: init, then the feature check (3/3) and identity-token-attrs (3/3, a regression
    check for the alias). A scratch vitest (deleted) drove the real TSOA routes through
    routeHarness. A user with platform_read ['false','true'] got it as true, and the body did
    not contain the password or secret. A user without project view got 403. A real
    ServiceRepository built a FederationService. Backend and common tsc, oxlint and oxfmt
    are clean. Not run against a live server and DB (no Docker or credentials).
- 2026-11-08T18:48:49Z supervisor: ldq-federation-access-route passed the gate in round 1
- 2026-11-08 ldq-time-relative-resolution (session):
  - New `packages/common/src/utils/timeRange.ts`, exported from common's index:
    `resolveTimeRange({from,to}, {now?, refreshInterval?})` returns `{from,to}` as ISO-8601 UTC.
    `now` and `now-<n><unit>` (units s, m, h, d, w) resolve against the clock and are floored to
    epoch multiples of the refresh interval. With no interval (undefined, null or 'off') they
    floor to 10s (`DEFAULT_TIME_RANGE_ROUNDING_MS`). Also exports `parseTimeRangeDuration` and
    `isRelativeTimeExpression`. Errors are `ParameterError` (unparseable expression, bad
    duration, start after end).
  - Next session (ldq-time-absolute-range): absolute ISO strings currently throw "Cannot parse".
    Extend `resolveExpression` to accept them, unrounded; the start-after-end check is already
    there. The refresh option set (10s..1h/off) belongs to ldq-dashboard-time-range-model; here
    any positive `<n><unit>` duration is accepted.
  - Tested: init, then the feature check (5/5). A scratch tsx script (deleted) on the real clock
    gave a 6h window ending on a 10s boundary with refresh off and on a 5m boundary with '5m'.
    'yesterday' and a reversed range threw ParameterError. common tsc, oxlint and oxfmt are clean.
- 2026-11-08T18:51:52Z supervisor: ldq-time-relative-resolution passed the gate in round 1
- 2026-11-08 ldq-time-absolute-range (session):
  - `packages/common/src/utils/timeRange.ts`: `resolveExpression` now accepts absolute ISO-8601
    date-times and returns them unrounded. They come back normalised to UTC (`toISOString`, ms
    precision). New export `isAbsoluteTimeExpression`. The existing start-after-end check covers
    absolute and mixed ranges.
  - Contract assumptions (CONTRACTS §2 only says "ISO-8601 UTC timestamp"): an absolute input
    must be a full date-time with an explicit offset (`Z`, `±hh:mm` or `±hhmm`). Non-UTC offsets
    are converted to UTC. Date-only or offset-less strings are refused (ParameterError
    "Cannot parse"), so the server's local time zone never matters. Impossible calendar values
    (Feb 30, hour 24) are refused instead of rolling over the way Date.parse does. Years 0000-0099
    are refused too (a Date.UTC quirk), which shouldn't matter in practice. Precision past
    milliseconds is truncated by JS Date.
  - Tested: init, then the feature check (3/3) and time-relative (5/5, regression). A scratch tsx
    script (deleted) gave these results: +02:00 input converted to Z, from==to accepted,
    Feb 30 / 24:00 / no-offset / date-only refused, and `now-1h` → a 2026-01-01 end refused as
    start after end. common tsc, oxlint and oxfmt are clean.
- 2026-11-08T18:54:43Z supervisor: ldq-time-absolute-range passed the gate in round 1
- 2026-11-08 ldq-time-interval-parameter (session):
  - `packages/common/src/utils/timeRange.ts` gains `getReservedTimeParameterValues(range, {now?,
    refreshInterval?, maxDataPoints?})` → `{__from, __to, __interval, __range}`, plus
    `getTimeIntervalMs(rangeMs, maxDataPoints=1000)`, `formatPrometheusDuration(ms)`,
    `TIME_INTERVAL_STEPS_MS`, `MIN_TIME_INTERVAL_MS` (15s) and `DEFAULT_MAX_DATA_POINTS` (1000).
    __interval = range / maxDataPoints, rounded up to the first CONTRACTS §2 step that is >= it
    (1s..1d), floored at 15s. Bad maxDataPoints (not a positive integer) → ParameterError.
  - Contract assumptions: past the largest step (range/points > 1d) __interval rounds up to whole
    days (e.g. '2d'); the contract's step list stops at 1d. `formatPrometheusDuration` uses units
    d/h/m/s (plus ms for sub-second remainders), largest whole units combined (`1h30m`), no weeks or
    years, because time-range-duration.test.ts expects now-7d → '7d'.
  - __range was needed by this feature's test ('6h'), so it is already implemented; the
    ldq-time-range-parameter check (time-range-duration.test.ts) already passes 3/3. The next
    session only needs to confirm it. ldq-time-reserved-parameters still needs the registry
    wiring (getReservedParameterNames, resolveReservedParameterValues, mergeReservedValues).
  - Tested: init, then the feature check (4/4) and time-relative (5/5), time-absolute (3/3),
    time-range-duration (3/3). A scratch tsx script (deleted) on the real clock gave 5m→15s,
    6h→30s, 24h→5m/'1d', 7d→15m, 30d→1h, 90d→3h; maxDataPoints 0 threw ParameterError.
    common tsc, oxlint and oxfmt are clean.
- 2026-11-08T18:57:26Z supervisor: ldq-time-interval-parameter passed the gate in round 1
- 2026-11-08 ldq-time-range-parameter (session):
  - No code change needed. The ldq-time-interval-parameter session already implemented `__range`
    as `formatPrometheusDuration(to - from)` in `packages/common/src/utils/timeRange.ts`, using the
    largest whole units d/h/m/s combined (e.g. `1h30m`, `1d2h5s`). This session confirmed it.
  - Tested: init, then the feature check (3/3). A scratch tsx script (deleted) on the real clock
    gave these results: now-6h → `__range` '6h' (refresh off and refresh '5m'), absolute
    09:00Z→10:30Z → '1h30m', and now-90m → '1h30m'.
  - Next: ldq-time-reserved-parameters (registry wiring) is still open; see the previous entry.
- 2026-11-08T18:58:58Z supervisor: ldq-time-range-parameter passed the gate in round 1
- 2026-11-08 ldq-time-reserved-parameters (session):
  - `packages/common/src/parameters/reservedParameters.ts`: the registry now has `__from`, `__to`,
    `__interval` and `__range` next to `date_zoom`. Each one resolves through
    `getReservedTimeParameterValues`. `ReservedParameterContext` gains the optional fields
    `timeRange`, `refreshInterval`, `now` and `maxDataPoints`. `resolveReservedParameterValues`
    reads the clock once per call (`now ?? new Date()`), so all four values come from the same
    instant and can't straddle a rounding bucket. User parameters still win through the unchanged
    `mergeReservedValues`/`mergeReservedDefinitions`/`mergeReservedNames`.
  - Contract assumption: with no time range in the context (every current caller, e.g.
    QueryComposer passes only `{ dateZoom }`), the four values resolve to '', the same as
    date_zoom without a zoom. Through `safeReplaceParametersWithSqlBuilder` an empty reserved value
    is still reported in missingReferences and left unsubstituted. date_zoom does the same today,
    so this is existing behaviour, not something this feature added. No backend caller passes
    `timeRange` yet. Wiring it from dashboards and the SQL runner belongs to later features
    (ldq-time-cache-key-buckets, ldq-query-routes-time-range-audit). The four names now also show up
    wherever reserved definitions are listed (the parameters UI, available parameters).
  - `reservedParameters.test.ts`: the mergeReservedNames expectations now include the new names.
    Added tests that resolve from a range and that give '' without one.
  - Tested: ran init, then the feature check (4/4) and time-relative (5/5). Ran these unit tests
    one at a time: common reservedParameters, compiler/parameters, dashboardTileParameters and
    exploreCompiler; backend QueryBuilder/parameters, queryCompiler and ProjectService. All passed.
    A scratch backend tsx script (deleted) compiled
    `promql('up', ${ld.parameters.__from}, …__to, …__interval, …__range)` through
    safeReplaceParametersWithSqlBuilder on the real clock with refresh 5m and got quoted ISO
    timestamps, '30s' and '6h'. A user `__from` overrode only __from. common tsc, oxlint and
    oxfmt are clean.
- 2026-11-08T19:04:02Z supervisor: ldq-time-reserved-parameters passed the gate in round 1
- 2026-11-08 ldq-time-cache-key-buckets (session):
  - No code change needed. The feature check passed 4/4 on the unchanged tree. The
    ldq-time-reserved-parameters work already does what it needs: `resolveReservedParameterValues`
    reads the clock once and rounds relative ranges to the refresh bucket, the values are
    substituted into the SQL, and `QueryHistoryModel.getCacheKey` hashes the substituted SQL. The
    executeAsyncQuery path (AsyncQueryService, `sharedCacheKey` from `sql: query`) keys on the
    compiled query, so the resolved timestamps are in the key, as CONTRACTS §2 requires.
  - Not done here (belongs to ldq-query-routes-time-range-audit): no backend caller passes
    `timeRange`/`refreshInterval` into `resolveReservedParameterValues` yet. QueryComposer passes
    only `{ dateZoom }`. The SQL runner paths (`probeDuckdbQueryColumns`, column discovery,
    ~line 15132) substitute user `parameters` only. When wiring those, merge the reserved values
    with `mergeReservedValues` before both substitution and `getCacheKey`, and resolve once per
    request so column discovery and the run use the same bucket.
  - Tested: init, then the feature check (4/4). A scratch backend tsx script (deleted) on the
    real clock compiled now-6h with refresh 1m at the start and end of the current minute and got
    identical SQL and keys. The next minute gave timestamps one minute later and a new key.
    Refresh off, back-to-back runs, gave identical SQL. No missing references.
- 2026-11-08T19:06:19Z supervisor: ldq-time-cache-key-buckets passed the gate in round 1
- 2026-11-08 ldq-dashboard-time-range-model (session):
  - New `packages/common/src/types/dashboardTimeRange.ts`, exported from the common index. It has
    `DASHBOARD_REFRESH_INTERVALS` (10s, 30s, 1m, 5m, 15m, 30m, 1h), the types
    `DashboardRefreshInterval`, `DashboardTileTimeDimension` ({ fieldId, tableName }) and
    `DashboardTimeRange` ({ from, to, refreshInterval: interval | null, tileTimeDimensions keyed by
    tile uuid }), plus the guards `isDashboardRefreshInterval` and `isValidDashboardTimeRange`.
    Unit tests are in `dashboardTimeRange.test.ts`.
  - Decisions (narrowest reading of the acceptance test): refresh off is `null`, not the string
    'off'. 'off' is still accepted by `resolveTimeRange` options but is refused in the persisted
    shape. `refreshInterval` and `tileTimeDimensions` are required keys (use `null`/`{}`).
    Bounds must be relative (`now`, `now-<n><s|m|h|d|w>`) or ISO-8601 with an explicit offset.
    from > to is refused only when both bounds are the same kind. A mixed relative/absolute
    range's order depends on the clock, so `resolveTimeRange` refuses it at resolve time instead.
  - Not done here: no Dashboard type field, no persistence, no API validation. Those belong to
    ldq-dashboard-time-range-migration/-persisted. Call `isValidDashboardTimeRange` there to refuse
    bad input with a ParameterError. The as-code JSON schema enum
    (ldq-dashboard-time-range-as-code) should match DASHBOARD_REFRESH_INTERVALS.
  - Tested: init, then the feature check (3/3), time-relative (5/5) and the new unit file (19/19).
    A scratch tsx script (deleted) imported the common index. It accepted now-24h with each
    listed interval and with null, and an absolute week with 1h. It refused 2m, 'off', 1d and 15s.
    common tsc, oxlint and oxfmt are clean.
- 2026-11-08T19:09:25Z supervisor: ldq-dashboard-time-range-model passed the gate in round 1
