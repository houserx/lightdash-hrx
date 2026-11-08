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
