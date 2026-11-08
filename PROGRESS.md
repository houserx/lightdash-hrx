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
11. **Investigate's Save as chart** saves to the first space the user can create charts in,
    as a TABLE SQL chart on the default connection. The spec names no space picker.
12. **The audit browser's identity token** uses audit source `investigate` with no description
    or ticket. §3 lists no source for the audit browser, and listing the audit store is not an
    Audited Query, so the engine needs only `attrs.platform_read` from it.

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
- 2026-11-08 ldq-dashboard-time-range-migration (session):
  - New migration `packages/backend/src/database/migrations/20261108120000_add_dashboard_versions_time_range.ts`
    adds a nullable `jsonb` column `dashboard_versions.time_range`. The down migration drops it. It follows
    the migrations AGENTS.md rules: no imports from common, and `SET LOCAL lock_timeout = '60s'` in both
    directions. There is no backfill and no default, so existing versions stay NULL (no time range).
  - Not done here (belongs to ldq-dashboard-time-range-persisted): DbDashboardVersion in
    `entities/dashboards.ts`, the DashboardModel reads and writes, the Dashboard type field, and API validation
    with `isValidDashboardTimeRange`. The column holds the common `DashboardTimeRange` shape.
  - Tested: init, then the feature check (1/1). It runs every non-ee migration on a throwaway Postgres and
    reads information_schema: data_type jsonb, is_nullable YES. oxfmt and oxlint are clean on the file.
- 2026-11-08T19:11:58Z supervisor: ldq-dashboard-time-range-migration passed the gate in round 1
- 2026-11-08 ldq-dashboard-time-range-persisted (session):
  - Common: `CreateDashboard`, `Dashboard` and `DashboardVersionedFields` gain
    `timeRange?: DashboardTimeRange | null`. TSOA routes and swagger are regenerated by init, so the
    v1 dashboard create and update bodies accept it. Both generated files are part of the diff.
  - Backend: `DbDashboardVersion.time_range` (insertable). `DashboardModel.createVersion` writes
    `version.timeRange ?? null`, so every version stores its own range and omitting it means none
    at the model level. `getByIdOrSlug` and `getVersionByUuid` select it and return
    `timeRange: time_range ?? null`. Old versions read back as null. The model mocks gained
    `time_range: null` / `timeRange: null`.
  - DashboardService: `assertValidTimeRange` (uses `isValidDashboardTimeRange`) throws a
    ParameterError on create and on update when `timeRange` is present. On a versioned update an
    omitted `timeRange` keeps the saved one, like `config` and `parameters`. Explicit null clears
    it. Duplicate remaps `tileTimeDimensions` keys to the new tile uuids, like the dateZoom
    tileTargets. Rollback restores the target version's range. Rename, promote and as-code
    callers spread the full dashboard object, so they carry the range unchanged.
  - Decision: the model treats an omitted range as none, and the service treats it as "keep the
    saved range". The current frontend doesn't send timeRange yet, so this stops a UI save from
    wiping it. Drafts (`maybeStoreDraft`) are untouched: they store whatever fields arrive.
  - Not done here: as-code YAML (ldq-dashboard-time-range-as-code), frontend picker/settings/URL.
  - Tested: init, then the feature check (2/2), DashboardModel.test (36/36), DashboardService.test
    (101/101), backend tsc clean, and oxlint/oxfmt clean on the changed files. A scratch vitest file
    (deleted) on a throwaway migrated Postgres created a dashboard with now-24h/1m and reopened it
    (same range). A new version changed it to now-1h, a later one cleared it (null), and the first
    version, read by uuid for rollback, still had now-24h. A dashboard without a range read null.
    The validator accepted 30s and null and refused 2m, 'off' and a reversed absolute range.
- 2026-11-08T19:19:44Z supervisor: ldq-dashboard-time-range-persisted passed the gate in round 1
- 2026-11-08 ldq-dashboard-time-range-as-code (session):
  - Common: new `DashboardTimeRangeAsCode` (the `DashboardTimeRange` shape with `tileTimeDimensions`
    keyed by tile slug) and `DashboardAsCode.timeRange?: DashboardTimeRangeAsCode | null`.
    `schemas/json/dashboard-as-code-1.0.json` is regenerated from swagger, so `refreshInterval` is an
    enum of 10s..1h or null and the schema refuses `2m`. TRAP: init regenerates routes/swagger but
    NOT the as-code JSON schemas (root `postgenerate-api` is not run by `generate-api:build`). After
    an as-code type change, run `pnpm -F common generate:dashboard-as-code-schema`, then init again
    so common's dist (used by the CLI) picks up the new JSON.
  - Backend `dashboardReferences.ts`: `getTimeRangeWithTileSlugs` (download; drops uuids with no tile
    slug, like dateZoom tileTargets) and `getTimeRangeWithTileUuids` (upload; unknown slugs are dropped
    and returned as upload warnings). CoderService writes `timeRange` on download only when the
    dashboard has one (no `timeRange: null` noise in existing YAML). `upsertDashboard` refuses an
    invalid range with ParameterError before any write (`isValidDashboardTimeRange`) and passes the
    uuid-keyed range to create and to the promote update.
  - Decision: on as-code upload an omitted or null `timeRange` saves the dashboard with no time range
    (declarative, like `config`/`parameters`). This differs from the v1 API update, where omitted keeps
    the saved range. A YAML downloaded before this feature will clear a UI-set range on re-upload.
  - Tested: built CLI `lightdash lint -p` on a synthetic dashboard YAML (tmp, deleted): now-6h/now/30s
    with a tile slug passed; the same file with `refreshInterval: 2m` failed at the timeRange line.
    New unit tests: slug<->uuid round trip (CoderService.test, 90/90) and upsertDashboard saving the
    uuid-keyed range with a warning for an unknown slug, and refusing 2m (upsertContentAccess,
    268/268). Feature check 3/3, schema `--check` in sync, generator test 4/4, backend and common tsc
    clean, oxlint/oxfmt clean.
- 2026-11-08T19:28:35Z supervisor: ldq-dashboard-time-range-as-code passed the gate in round 1
- 2026-11-08 ldq-dashboard-time-range-tile-filters (session):
  - Common: new `utils/dashboardTimeRangeFilters.ts` (exported from index).
    `getDashboardTimeRangeFilterRules({ timeRange, tileUuids, now })` returns one `inBetween`
    DashboardFilterRule per mapped tile: target = that tile's `{ fieldId, tableName }`, values = the
    range resolved by `resolveTimeRange` with the dashboard's refresh interval (10s when off;
    absolute bounds unrounded), `tileTargets` = own target for that tile and `false` for every other
    tile in `tileUuids`. No range or no mappings gives []. Mappings for tiles not in `tileUuids`
    (deleted tiles) are ignored.
  - Decision: rule ids are deterministic (`dashboard-time-range:<tileUuid>`, via
    `getDashboardTimeRangeFilterId`), not uuidv4, so the tile query and cache key only change when
    the resolved range does. Label is undefined.
  - TRAP for callers: `getDashboardFilterRulesForTile` applies a rule to any tile that is missing
    from `tileTargets`. Pass EVERY tile uuid of the dashboard as `tileUuids`, or unmapped tiles get
    the time filter.
  - Not done here (later features): sending the rules with dashboard tile queries / the query
    route (ldq-query-routes-time-range-audit), URL override, settings UI, tile-status.
  - Tested: unit tests `utils/dashboardTimeRangeFilters.test.ts` (6/6) feed the rules through the
    real `getDashboardFiltersForTile`: the orders tile gets only its orders_created_at rule over
    04:37:00Z..10:37:00Z for now-6h/1m at 10:37:43Z, the fills tile only fills_filled_at, the
    markdown tile nothing; same rules within one minute bucket; `renderFilterRuleSql` compiles the
    rule to a bounded Postgres timestamp filter. init, feature check 2/2, common tsc clean,
    oxlint/oxfmt clean.
- 2026-11-08T19:32:51Z supervisor: ldq-dashboard-time-range-tile-filters passed the gate in round 1
- 2026-11-08 ldq-dashboard-time-range-tile-status (session):
  - Common `utils/dashboardTimeRangeFilters.ts` (already exported from index):
    `isTileAffectedByTimeRange({ timeRange, tile: { uuid, type }, sql? })` is true when the tile
    has a `tileTimeDimensions` mapping, or when `sql` uses a reserved time parameter. No range
    gives false for every tile. Also `RESERVED_TIME_PARAMETER_NAMES` (__from, __to, __interval,
    __range; date_zoom is not a time-range parameter) and `usesReservedTimeParameters(sql)`, which
    reuses `getParameterReferences`, so `${ld.parameters.X}`, `${lightdash.parameters.X}` and bare
    refs inside Liquid `{% %}` tags all count; `__fromage` or a quoted '__from' does not.
  - Decision: the check uses the SQL whatever the tile type. Callers pass `sql` only for SQL
    tiles (sql_chart / telemetry SQL); markdown, loom and heading tiles have none, so they are never
    affected. A user parameter that shadows `__from` still counts as affected (narrow reading).
  - For the next features (settings UI, tile-not-affected badge): the frontend must fetch or
    hold each SQL tile's SQL to pass in; mapped saved charts need no SQL.
  - Tested: built common dist (cjs) driven with node on a dashboard with a mapped saved chart, a
    promql SQL tile using ${ld.parameters.__from} and a markdown tile: true, true, false; no
    range: false. Unit tests dashboardTimeRangeFilters.test 10/10, feature check 4/4, common tsc,
    oxlint, oxfmt clean.
- 2026-11-08T19:36:45Z supervisor: ldq-dashboard-time-range-tile-status passed the gate in round 1
- 2026-11-08 ldq-time-range-picker (session):
  - Frontend: new `features/timeRange/` with `components/TimeRangePicker.tsx` and `utils.ts`
    (+ `utils.test.ts`). Props: `value: {from,to}`, `onChange`, optional `refreshInterval`
    (DashboardRefreshInterval | null) and `onRefreshIntervalChange`, `disabled`.
  - Trigger is a Mantine Button labelled by `getTimeRangeLabel` ("Last 6 hours" for now-6h..now,
    singular "Last 1 hour"; anything else shows "<from> to <to>"). It opens a Popover with From/To
    TextInputs (prefilled with the current value; accept ISO-8601 with offset or now-<n><unit>,
    validated with common's isRelative/isAbsoluteTimeExpression + resolveTimeRange order check),
    an Apply submit button (Enter works too), and the quick ranges `QUICK_TIME_RANGES`
    (5m,15m,30m,1h,3h,6h,12h,24h,2d,7d,30d). Picking or applying closes the popover.
  - TRAP: the popover must close on pick (and only renders when open): the quick list contains the
    current label, so an open popover makes `getByText('Last 6 hours')` ambiguous in tests.
  - Refresh is a NativeSelect with aria-label "Refresh" (Off + DASHBOARD_REFRESH_INTERVALS),
    rendered only when `onRefreshIntervalChange` is passed; Off reports `null`.
  - Not wired into any page yet: dashboards (url/settings/auto-refresh) and Investigate
    (investigate-time-range expects a button named /Last 6 hours/) mount it in later features.
  - Tested: a scripted user-event session on a stateful harness: Last 6 hours -> Last 15 minutes
    relabels the button; typed garbage From shows the error; typed absolute From/To + Enter
    applies and closes; Refresh lists Off..1h, 1m then Off give "1m" then null. Feature check 5/5,
    utils.test 5/5, frontend typecheck clean, oxlint/oxfmt clean.
- 2026-11-08T19:40:42Z supervisor: ldq-time-range-picker passed the gate in round 1
- 2026-11-08 ldq-dashboard-time-range-url (session):
  - Frontend `features/dashboardTimeRange/utils/urlState.ts`: `readTimeRangeFromSearchParams(params,
    saved)` and `writeTimeRangeToSearchParams(params, range)` (+ param name constants). Valid
    `from`/`to` (now-<n><unit>, ISO-8601 with offset, or epoch ms -> ISO UTC) and `refresh`
    (an allowed interval, or `off` -> null) override the saved range one by one; invalid values are
    ignored; URL bounds that would put from after to are dropped together (refresh still applies).
    No saved range: both bounds needed, else null. Other saved fields (tileTimeDimensions) are kept.
    Write always sets all three params (`refresh=off` when null) and keeps other params.
  - `hooks/useDashboardTimeRangeUrlState(saved)` gives `{ timeRange, setTimeRange }` from the router
    location (navigate with replace, like the parameters sync). `components/DashboardTimeRangeControl`
    mounts the TimeRangePicker (with refresh select) on it. `DashboardHeader` shows it in view mode
    only, when `dashboard.timeRange` is set (next to the refresh button).
  - Decision: params are written only when the viewer changes the range, so unchanged dashboards
    keep clean URLs. Edit mode shows no control (settings UI is the next feature).
  - NOT done (later features): the effective range is not yet sent with tile queries
    (ldq-query-routes-time-range-audit) nor drives auto-refresh (ldq-dashboard-auto-refresh); use
    `useDashboardTimeRangeUrlState(dashboard.timeRange).timeRange` as the source of truth there.
    The existing DashboardRefreshButton is unrelated and untouched.
  - Tested: no full stack (no Docker); drove the real DashboardHeader in jsdom with a MemoryRouter
    (DashboardHeader.test.tsx, 3 new cases): pick Last 15 minutes from Last 6 hours -> URL gains
    from=now-15m&to=now&refresh=1m keeping tab=overview, button relabels; Refresh Off -> refresh=off;
    opening ?from=now-24h&to=now&refresh=5m shows Last 24 hours and 5m over the saved 6h/1m; edit
    mode shows no control. Feature check 5/5, header test 7/7, frontend typecheck, oxlint, oxfmt clean.
- 2026-11-08T19:44:59Z supervisor: ldq-dashboard-time-range-url passed the gate in round 1
- 2026-11-08 ldq-dashboard-time-range-settings (session):
  - Frontend `features/dashboardTimeRange/components/DashboardTimeRangeSettings.tsx` (presentational,
    the acceptance target): props `tiles: {uuid,name,timeDimensions:{fieldId,tableName,label}[]}[]`,
    `value` (tileTimeDimensions by tile uuid), `onChange`, `disabled`. One NativeSelect per tile,
    labelled by the tile name, options None + its time dimensions; picking reports the whole map
    with `{fieldId,tableName}`, None removes the tile's key. Tiles with no time dimension show the
    name and "No time dimension". A saved mapping missing from a tile's options stays selectable.
  - `utils/tileTimeDimensions.ts` `getTimeRangeSettingsTiles(tiles, filterableFieldsByTileUuid)`:
    tile name via dashboardControls `getTileTitle` (fallback "Untitled tile"); time dimensions =
    visible dimensions with date/timestamp type from the dashboard context's filterable fields.
  - `components/DashboardTimeRangeSettingsButton.tsx`: edit-mode "Time range settings" button +
    modal; reads `filterableFieldsByTileUuid` with useDashboardContext; shows a loader while undefined.
  - Wiring: `DashboardHeader` new optional props `tileTimeDimensions` / `onTileTimeDimensionsChange`;
    the button shows in edit mode only when `dashboard.timeRange` exists. `pages/Dashboard.tsx` keeps
    a staged map (undefined = untouched), adds it to `hasDashboardChanged`, resets on cancel and on
    save success, and sends `timeRange: {...saved, tileTimeDimensions: staged}` only when staged.
  - Decision: no UI to create a time range on a dashboard that has none (spec doesn't ask; ranges come
    from as-code/API). Backend keeps the saved range when `timeRange` is omitted and the model already
    drops mappings of deleted tiles, so the page does not prune.
  - Tested: no full stack (no Docker); drove the real DashboardHeader in edit mode with a stateful
    harness (DashboardHeader.test.tsx, 3 new cases): open Time range settings -> Orders per hour shows
    saved Created at, Runbook says No time dimension; pick Shipped at -> staged map has
    orders_shipped_at/orders; pick None -> {}; loader before fields load; no button without a range.
    Feature check 3/3, header test 10/10, tileTimeDimensions.test 2/2, frontend typecheck, oxlint,
    oxfmt clean.
- 2026-11-08T19:50:37Z supervisor: ldq-dashboard-time-range-settings passed the gate in round 1
- 2026-11-08 ldq-dashboard-tile-not-affected (session):
  - Frontend `features/dashboardTimeRange/utils/tileTimeRangeIndicator.ts`
    `isTileMarkedNotAffectedByTimeRange({ timeRange, tile, sql })` (same args as common's
    `isTileAffectedByTimeRange`): true only when there is a range, the tile is a saved_chart or
    sql_chart, and the range does not reach it. `components/TileTimeRangeIndicator.tsx` (the
    acceptance target) renders a gray Mantine Badge "Not affected by the time range" (clock-off icon,
    tooltip) when that is true, else null.
  - Decisions: markdown, heading, loom and data app tiles show no data, so they get no mark (avoids
    noise). A sql_chart whose SQL is still undefined (loading) gets no mark, so telemetry tiles don't
    flash it.
  - Wiring: `DashboardChartTile` (main, non-minimal tile) and `DashboardSqlChartTile` (no-results and
    results states) read `dashboard.timeRange` with useDashboardContext and pass the badge as
    TileBase `visibleHeaderElement` only when marked. TRAP: any truthy visibleHeaderElement makes
    the header pill always visible, so pass undefined (not a null-rendering element) for other
    tiles. The chart tile merges it with the always-visible comments button.
  - Uses the SAVED range's tileTimeDimensions (staged edits in the settings modal show after save);
    URL overrides only change from/to/refresh, not mappings, so they don't matter here. Minimal /
    embedded chart tiles and the chart tile's error/loading TileBase states carry no badge.
  - Tested: no full stack (no Docker); rendered the real tiles in jsdom. DashboardChartTile (cases
    added to DashboardChartTile.merge.test.tsx, mocked dashboard context gains timeRange): unmapped
    tile shows the badge, mapped tile and no range show none. New
    DashboardSqlChartTile.timeRange.test.tsx: plain SQL shows it; promql SQL with
    ${ld.parameters.__from/__to/__interval} and no range show none. Both fail with the tile wiring
    stashed. Feature check 3/3, merge test 16/16, SQL tile test 3/3, TileBase test 11/11, frontend
    typecheck, oxlint, oxfmt clean.
- 2026-11-08T19:56:20Z supervisor: ldq-dashboard-tile-not-affected passed the gate in round 1
- 2026-11-08 ldq-dashboard-auto-refresh (session):
  - Frontend `features/dashboardTimeRange/hooks/useDashboardAutoRefresh(refreshInterval, onRefresh)`
    (the acceptance target): setInterval at `parseTimeRangeDuration(interval)` from common; null,
    undefined or an unknown interval is off; a changed interval restarts the timer; unmount stops it.
    onRefresh goes through useStableCallback, so a new callback each render does not restart it.
  - `components/DashboardTimeRangeAutoRefresh.tsx` (renders null), mounted inside
    `DashboardTimeRangeControl` with the effective range's refreshInterval (saved range overridden
    by the URL `refresh`). It shows only in view mode on dashboards with a time range, so edit mode
    and leaving the dashboard stop refreshing. While on it sets tile-status `isAutoRefresh` true
    (tile queries run in the AUTOREFRESHED_DASHBOARD context, as with the legacy button) and false
    on off/unmount.
  - Decision: each tick calls `useDashboardRefresh().invalidateDashboardResultsQueries()` only
    (dashboard_chart_ready_query + savedSqlChartResults). It does NOT call clearCacheAndFetch /
    removeQueries like the manual refresh button: that sets the sticky invalidateCache (warehouse
    cache bypass forever after) and blanks tiles; CONTRACTS §2 relies on bucketed relative ranges so
    cache keys change exactly when data should. Chart definitions (saved_query etc.) are not
    re-fetched. Data-app tiles (iframe, refreshCounter) are not reloaded by it.
  - Known overlap: the legacy DashboardRefreshButton auto-refresh (5m-2h, local state) still
    exists and also writes isAutoRefresh; turning time-range refresh off while the legacy one is on
    flips isAutoRefresh to false (only affects the query context label). Untouched by design.
  - Until ldq-query-routes-time-range-audit sends the range with tile queries, a refresh re-runs
    the same tile query (backend results cache may answer it).
  - Tested: no full stack (no Docker). DashboardHeader.test.tsx (mocks tile-status context and
    useDashboardRefresh; 3 new cases): set Refresh to 10s in the real picker -> results invalidated
    at 10s, 20s, 30s, not at 9.999s; Off -> none for an hour; ?refresh=10s then unmount -> stops;
    edit mode -> none. Both refresh cases fail with the wiring removed. New
    DashboardTimeRangeAutoRefresh.test.tsx with a real QueryClient: tile results query re-runs every
    10s, saved_query does not, tile keeps its data; off -> no re-run. Feature check 3/3, header
    13/13, url acceptance 5/5, frontend typecheck, oxlint, oxfmt clean.
- 2026-11-08T20:02:48Z supervisor: ldq-dashboard-auto-refresh passed the gate in round 1
- 2026-11-08 ldq-query-routes-time-range-audit (session):
  - common `types/api/paginatedQuery.ts`: new `QueryTimeRange` ({from, to, refreshInterval?:
    DashboardRefreshInterval|null}) and `QueryAudit` ({description, ticket?: string|null}).
    `timeRange?` on ExecuteAsyncSqlQuery/DashboardChart/DashboardSqlChart request params; `audit?`
    on the SQL one only (as this file's API section says). Matching args in the backend
    `AsyncQueryService/types.ts`; `QueryController` passes them through unchanged (routes regenerated
    by init; generated routes/swagger diffs are part of this change, as in earlier features).
  - New `AsyncQueryService/queryTimeRange.ts`: `withTimeRangeParameters(params, range, now?)` adds
    `__from/__to/__interval/__range` (resolveReservedParameterValues, refresh bucket, user value
    wins); `withTimeRangeTileFilter({dashboardFilters, timeRange, savedTimeRange, tileUuid})` adds
    the `dashboard-time-range:<tile>` inBetween rule from getDashboardTimeRangeFilterRules for a
    mapped tile; `normalizeQueryAudit` (trim, blank description -> ParameterError, blank ticket ->
    null). Invalid ranges -> ParameterError "Invalid time range ...".
  - AsyncQueryService: SQL runner and dashboard SQL chart tiles merge the time parameters into the
    combined parameters before substitution, so `${ld.parameters.__from}` now works in the SQL
    runner (it threw "Missing values" before) and the cache key carries the resolved bucket.
    Dashboard chart tiles load the saved range's tileTimeDimensions with the new lightweight
    `DashboardModel.getDashboardTimeRangeByIdOrSlug` (only when the request has a range) and
    add the tile's rule before resolveDashboardDateFilters (merge charts get it too). The request
    `timeRange` (not audit) is recorded in query history requestParameters for sql and
    dashboard-chart, so rerun keeps the range.
  - Frontend: `features/dashboardTimeRange/hooks/useDashboardQueryTimeRange()` = saved range
    overridden by URL from/to/refresh (undefined when the dashboard has none, same as the
    control). useDashboardChartReadyQuery and DashboardSqlChartTile -> useSavedSqlChartResults ->
    getDashboardSqlChartPivotChartData send it (registered path only; embed endpoints untouched)
    and it is in the query keys. Relative ranges keep the same key; auto-refresh invalidation
    re-runs them and the backend resolves the next bucket.
  - NOT DONE, needs a decision (follow-up): `audit` stops at AsyncQueryService (validated, then
    unused). FederationIdentityService is still not registered in ServiceRepository and no
    query path passes `getIdentityToken` to the warehouse client. Warehouse clients are cached and
    shared across users/jobs (WarehouseClientFactory cacheKey), so a per-query audit/tile uuid
    cannot ride the client options without either adding user+audit to the cache key or a
    per-query context (AsyncLocalStorage) the provider reads. That integration belongs to whoever
    wires WarehouseClientFactory (see "Work with no acceptance check"); until then the engine sees
    no identity, and Audited Queries fail closed at the engine. Audit is deliberately not stored in
    query history (free-text description may hold sensitive detail).
  - Tested: no full stack (no Docker). Feature check 3/3. New queryTimeRange.test.ts 13/13.
    AsyncQueryService.test.ts 998/998 incl. new cases: SQL runner substitutes promql(...) with
    the absolute range ('5m' interval for 1d) and records timeRange; reserved params without a
    range -> ParameterError; bad range / blank audit refused before the warehouse; mapped chart
    tile gets the inBetween filter (fails with the wiring removed), unmapped/no-range untouched;
    dashboard SQL chart gets the four params. Frontend: new
    useDashboardChartReadyQuery.timeRange.test.tsx (real DashboardProvider + mocked API: saved
    range, URL override, none; fails with the wiring removed), DashboardSqlChartTile.timeRange
    6/6, useSavedSqlChartResults 4/4, bridge 10/10, merge 16/16, header 13/13. Backend acceptance
    persisted/federation-access/time-cache-key and frontend dashboard-auto-refresh pass. common,
    backend, frontend typecheck clean; oxfmt/oxlint clean on changed files (run oxfmt per file:
    one run over AsyncQueryService.test.ts plus others was killed, exit 137).
- 2026-11-08T20:21:47Z supervisor: ldq-query-routes-time-range-audit passed the gate in round 1
- ldq-investigate-sql-promql (round 1):
  - New `packages/common/src/utils/telemetrySql.ts`, exported from common's index:
    `buildTelemetrySql(telemetryQuery)` returns
    `SELECT * FROM promql('<query>', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}[, '<source>'])`
    (CONTRACTS §1.1/§2). Single quotes are doubled in the query and the source. A missing or
    empty source is left out so the engine's `default_source` applies. `TelemetryQuery` is a
    discriminated union on `kind` with only `promql` so far, and the switch has a `never`
    default. The next sql-* features (logql/logql_metric, cloudwatch, cloudwatch_logs,
    traceql/trace) add union members and cases here, and reuse the private
    `tableFunctionSql(name, args, source)` / `toSqlStringLiteral` helpers. Exported
    `TELEMETRY_SQL_FROM/TO/INTERVAL` constants hold the reserved parameter references.
  - The backend AsyncQueryService.test.ts SQL-runner time-range cases now build their SQL with
    `buildTelemetrySql({kind:'promql', query:'up'})`, so the generated SQL is checked through
    real parameter substitution (-> `promql('up', '<from>', '<to>', '5m')`).
  - Tested: Investigate has no UI yet (source editors come in a later feature), so the
    user-facing surface is the common function plus the SQL runner path. Feature check 3/3.
    New telemetrySql.test.ts 5/5. Backend "reserved time parameters" cases 3/3 using the
    builder. common tsc clean; oxfmt/oxlint clean on changed files.
- 2026-11-08T20:24:34Z supervisor: ldq-investigate-sql-promql passed the gate in round 1
- ldq-investigate-sql-logql (round 1):
  - `packages/common/src/utils/telemetrySql.ts`: `TelemetryQuery` gains `logql`
    (`{query, limit?, direction?, source?}`) and `logql_metric` (`{query, source?}`).
    LogQL log -> `logql('<q>', __from, __to, <limit>, '<direction>'[, '<source>'])`; limit and
    direction are ALWAYS written out (defaults `LOGQL_DEFAULT_LIMIT` 1000 and
    `LOGQL_DEFAULT_DIRECTION` 'backward', exported) so they stay visible/editable in the SQL, as
    the acceptance test requires. A non-positive/non-integer limit or a direction other than
    forward/backward throws (they are interpolated into SQL). Metric -> `logql_metric('<q>',
    __from, __to, __interval[, '<source>'])` (CONTRACTS §1.1). The `never` default now narrows
    the whole query object.
  - Tested: no Investigate UI yet; surface is the exported common function. Feature check 3/3,
    promql acceptance 3/3 (regression), telemetrySql.test.ts 10/10 (5 new: defaults, quote
    escaping + source, bad limit, bad direction, metric with source). common tsc clean;
    oxfmt/oxlint clean (use `pnpm exec`, plain `npx` fails on the devEngines node pin).
- 2026-11-08T20:26:44Z supervisor: ldq-investigate-sql-logql passed the gate in round 1
- ldq-investigate-sql-cloudwatch (round 1):
  - `packages/common/src/utils/telemetrySql.ts`: new `CloudWatchMetricDataQuery` type (metric
    stat or Expression, the Grafana-stored shape), `CloudWatchMetricForm`
    (`{namespace, metricName, dimensions?: Record<string,string>, stat, period}`) and
    `buildCloudWatchMetricDataQuery(form)` -> `{Id:'m1', MetricStat:{Metric:{Namespace,
    MetricName, Dimensions:[{Name,Value}]}, Period, Stat}, ReturnData:true}`. Dimensions keep
    the record's insertion order; no dimensions -> `[]`. Blank namespace/metric/stat or a
    non-positive/non-integer period throws. `TelemetryQuery` gains `cloudwatch`
    (`{metricDataQuery, source?}`) -> `cloudwatch('<JSON.stringify(mdq)>', __from, __to[, '<source>'])`
    (CONTRACTS §1.1; no step argument). Single quotes inside the JSON are doubled.
  - Tested: no Investigate UI yet; surface is the exported common functions. Feature check 2/2,
    logql acceptance 3/3 (regression), telemetrySql.test.ts 14/14 (4 new). common tsc clean;
    oxfmt/oxlint clean on changed files.
- 2026-11-08T20:28:41Z supervisor: ldq-investigate-sql-cloudwatch passed the gate in round 1
- ldq-investigate-sql-logs-insights (round 1):
  - `packages/common/src/utils/telemetrySql.ts`: `TelemetryQuery` gains `cloudwatch_logs`
    (`{logGroups: string[], query, source?}`) -> `cloudwatch_logs('<g1,g2>', '<query>', __from,
    __to[, '<source>'])` (CONTRACTS §1.1). Private `joinLogGroups` trims names, drops blanks,
    joins with ',' (no space). It throws when no group is left, or when a name contains a comma,
    because the engine's comma-separated argument can't carry that name (narrowest reading; the
    contract gives no escape). Quotes are doubled in the groups, the query and the source.
  - Tested: no Investigate UI yet; surface is the exported common function. Feature check 2/2,
    cloudwatch acceptance 2/2 (regression), telemetrySql.test.ts 16/16 (2 new: trim/drop
    blanks, refuse empty and comma). common tsc clean; oxfmt/oxlint clean on changed files.
- 2026-11-08T20:31:05Z supervisor: ldq-investigate-sql-logs-insights passed the gate in round 1
- ldq-investigate-sql-traceql (round 1):
  - `packages/common/src/utils/telemetrySql.ts`: `TelemetryQuery` gains `traceql`
    (`{query, limit?, source?}`) -> `traceql('<q>', __from, __to, <limit>[, '<source>'])` with the
    limit always written out (default `TRACEQL_DEFAULT_LIMIT` 20, exported), and `trace`
    (`{traceId, source?}`) -> `trace('<id>'[, '<source>'])` with no time arguments (CONTRACTS
    §1.1). The trace id is trimmed and a blank id throws; no hex format is enforced (narrowest
    reading, the contract types it as text). The limit check is now a shared private
    `positiveLimit(language, limit)` used by logql and traceql (same "positive integer" message).
  - Tested: no Investigate UI yet; surface is the exported common function. Feature check 3/3,
    logql acceptance 3/3 (regression), telemetrySql.test.ts 21/21 (5 new: default limit, quote
    escaping + source, bad limit, trace id trim + source, blank id). common tsc clean;
    oxfmt/oxlint clean on changed files (oxlint via `pnpm -F common exec oxlint`).
- 2026-11-08T20:33:57Z supervisor: ldq-investigate-sql-traceql passed the gate in round 1
- ldq-investigate-result-shape (round 1):
  - New `packages/common/src/utils/telemetryResultShape.ts` (exported from common index):
    `TelemetryResultShape = 'metric'|'log'|'trace'|'table'` and
    `getTelemetryResultShape(columnNames)`. Rules, checked in this order: timestamp + value +
    labels -> metric; timestamp + (line | message) -> log; trace_id -> trace; else table
    (column sets from CONTRACTS §1.1). Contract assumption: names match case-insensitively
    and order is ignored (warehouses may upper-case identifiers); extra columns are allowed.
  - Tested: no Investigate UI yet; called the exported function through `tsx` against the §1.1
    column sets (metric/log/trace/table as expected). Feature check 4/4, traceql acceptance 3/3
    (regression), new telemetryResultShape.test.ts 4/4 (case/order, partial metric, log needs
    timestamp, empty). common tsc clean; oxlint/oxfmt clean on changed files.
- 2026-11-08T20:35:57Z supervisor: ldq-investigate-result-shape passed the gate in round 1
- ldq-investigate-audited-sql-detection (round 1):
  - New `packages/common/src/utils/auditedSql.ts` (exported from common index):
    `isAuditedSql(sql)` is true when the SQL calls `platform_query`, `platform_explain`,
    `platform_tables` or `platform_columns` (CONTRACTS §2 table; case-insensitive, optional
    double quotes, whitespace before `(`, not part of a longer identifier). String literals
    (`''` escapes) and `--` / `/* */` comments are stripped first so their text never counts.
    `isAuditDescriptionRequiredError(message)` matches "audited query requires a description"
    (CONTRACTS §2; SQLSTATE 42501 alone is not enough, it is also plain permission denied).
  - Contract assumption: Restricted Telemetry is also audited but depends on source config the
    client cannot see, so it is not detected from SQL; the UI should fall back to the engine
    error via `isAuditDescriptionRequiredError`. Dollar-quoted strings are not stripped.
  - Tested: no Investigate UI yet; called the exported functions through `tsx` from the common
    index on all four platform_* calls (true), promql and Ops Marts SQL (false) and the engine
    error text (true). Feature check 3/3, result-shape acceptance 4/4 (regression), new
    auditedSql.test.ts 4/4. common tsc clean; oxlint/oxfmt clean on changed files.
- 2026-11-08T20:38:25Z supervisor: ldq-investigate-audited-sql-detection passed the gate in round 1
- ldq-investigate-availability (round 1):
  - New `packages/frontend/src/features/investigate/components/SqlRunnerModeSwitch.tsx`:
    `SqlRunnerMode = 'sql' | 'investigate'` and `SqlRunnerModeSwitch({project, mode,
    onModeChange})`, a Mantine SegmentedControl (radios "SQL" / "Investigate") rendered only when
    common `isFederationProject(project)` is true; otherwise it renders nothing.
  - `pages/SqlRunner.tsx`: on a new query (no saved-chart slug, not a virtual view) of a federation
    project, the switch sits above the content panel; local `runnerMode` state (not the redux
    slice's existing `mode`, which means default/virtualView). In Investigate mode the SQL
    ContentPanel is replaced by an "Investigate" SuboptimalState placeholder.
  - Next sessions: replace that placeholder in `pages/SqlRunner.tsx` with the Investigate UI
    (InvestigateEditor / InvestigateResults are loaded by later acceptance tests from
    `features/investigate/components/`). Saved SQL charts and virtual views never show the switch.
  - Tested: new page test `src/pages/SqlRunner.investigate.test.tsx` (2/2) renders the real
    SqlRunner page (heavy panels mocked): federation project shows SQL checked, clicking
    Investigate hides the SQL panel, clicking SQL brings it back; plain Postgres shows no radios.
    No browser/backend available (no Docker). Feature check 2/2, SqlRunner.navigation 3/3
    (regression). frontend tsc clean; oxfmt/oxlint clean on changed files.
- 2026-11-08T20:41:08Z supervisor: ldq-investigate-availability passed the gate in round 1
- ldq-investigate-source-editors (round 1):
  - New `packages/frontend/src/features/investigate/components/InvestigateEditor.tsx`:
    `InvestigateEditor({onChange})`. Source picker is a SegmentedControl (aria-label "Source",
    radios Prometheus / Loki / CloudWatch metrics / CloudWatch Logs / Tempo / Platform Database,
    default Prometheus). Editors: "PromQL", "LogQL" + "Metric query" checkbox (logql vs
    logql_metric), "TraceQL", "Platform SQL"; optional "Source name" for every source but
    Platform (platform_query takes no source, CONTRACTS §1.1). SQL comes from common
    `buildTelemetrySql`; onChange gets `{kind, sql}` (platform: `{kind:'platform', statement,
    sql}`), only when the generated SQL changes and is non-empty.
  - New common `buildPlatformQuerySql(statement)` in `utils/auditedSql.ts` (quotes doubled).
  - `pages/SqlRunner.tsx`: the Investigate placeholder is replaced by `<InvestigateEditor>`;
    onChange is a no-op until the results/run features land.
  - Next sessions: CloudWatch metrics / CloudWatch Logs radios exist but show "The CloudWatch
    editor is not available yet." (ldq-investigate-cloudwatch-editors fills them in; emit
    `cloudwatch` / `cloudwatch_logs` kinds from the same `change` memo). The "SQL" textarea is
    readOnly and has no `initialSql` yet; ldq-investigate-sql-editable must make it editable,
    keep manual edits, and accept `initialSql`. Trap: on the SqlRunner page the mode radio is
    also labelled "SQL", so page tests must use `getByLabelText('SQL', {selector: 'textarea'})`.
  - Tested: no browser/backend (no Docker). The page test `SqlRunner.investigate.test.tsx` now
    renders the real SqlRunner page, switches to Investigate, picks Tempo, types TraceQL and sees
    the traceql(...) SQL (3/3). Feature check 6/6; common auditedSql.test.ts 5/5. frontend tsc
    clean; oxfmt/oxlint clean on changed files.
- 2026-11-08T20:44:32Z supervisor: ldq-investigate-source-editors passed the gate in round 1
- ldq-investigate-sql-editable (round 1):
  - `features/investigate/components/InvestigateEditor.tsx`: the "SQL" textarea is no longer
    readOnly. It shows local `sql` state, seeded from the new optional `initialSql` prop. A newly
    generated SQL (a string that differs from the last generated one) replaces the box and goes
    to onChange as before. A manual edit goes to onChange as `{kind, sql: edited}`. The kind
    comes from the picked source (`kindOfSource`). For platform the payload also carries the
    current Platform SQL `statement`.
  - Decision: a manual edit stays through re-renders and through switching sources and back.
    It is replaced only when the source query changes and so produces a different SQL. initialSql
    is not reported through onChange on mount, because the parent already has it.
  - Next sessions: the parent should run whatever onChange last reported. That is the edited
    SQL when the user edited it. SqlRunner's onChange is still a no-op until the run/results
    features land. The CloudWatch editors should also feed `change` so they get the same
    overwrite rule.
  - Tested: no browser or backend (no Docker). New page test in `SqlRunner.investigate.test.tsx`
    (4/4) renders the real SqlRunner page. It switches to Investigate and types `up` as PromQL,
    and the promql SQL appears. It edits the SQL, switches to Loki and back to Prometheus, and
    the edit is still there. It changes the PromQL, and the SQL is regenerated. Feature check
    2/2, investigate-editor-sources 6/6 (regression). frontend tsc clean; oxfmt and oxlint clean
    on changed files.
- 2026-11-08T20:46:42Z supervisor: ldq-investigate-sql-editable passed the gate in round 1
- ldq-investigate-cloudwatch-editors (round 1):
  - New `features/investigate/components/CloudWatchEditors.tsx`, which holds two presentational
    components. `CloudWatchMetricsEditor` has the fields "Namespace", "Metric name",
    "Dimensions" (`Name=Value` pairs separated by commas or new lines), "Statistic" (default
    Average) and "Period" (seconds, default 300), plus the "MetricDataQuery JSON" textarea.
    `CloudWatchLogsEditor` has "Log groups" (comma-separated) and "Logs Insights query".
  - New `features/investigate/utils/cloudWatchForm.ts` with the helpers. They live outside the
    components file because oxlint's only-export-components rule flags them there.
    `metricDataQueryJsonFromForm` returns undefined while the form is incomplete, and otherwise
    uses common `buildCloudWatchMetricDataQuery`, Id m1. `parseMetricDataQuery` takes JSON typed
    by hand. It needs an object with an Id and a MetricStat or an Expression, and gives an
    error message otherwise. `splitLogGroups` splits the log groups field.
  - `InvestigateEditor.tsx`: the CloudWatch placeholder is gone. The `cloudwatch` and
    `cloudwatch_logs` kinds now come from the same `change` memo, so they follow the
    manual-SQL-edit rule. "Source name" applies to both.
  - Decision: when the form describes a complete metric stat, a form edit rewrites the JSON.
    A hand edit of the JSON stays until the form is edited again. While the form is incomplete,
    the JSON is left as it is. Invalid hand JSON shows an error under the box ("Not valid
    JSON", etc.) and generates no SQL.
  - Tested: no browser or backend (no Docker). The new page test in
    `SqlRunner.investigate.test.tsx` (5/5) renders the real SqlRunner page. It fills in the
    CloudWatch metrics form, and the JSON and the cloudwatch(...) SQL appear. Broken JSON shows
    the error. A metric math expression typed by hand gives its SQL. Then it switches to
    CloudWatch Logs, enters log groups, a query and a source name, and the cloudwatch_logs(...)
    SQL appears. Feature check 3/3, investigate-editor-sources 6/6 (regression). frontend tsc
    clean; oxfmt and oxlint clean on changed files.
- 2026-11-08T20:50:23Z supervisor: ldq-investigate-cloudwatch-editors passed the gate in round 1
- ldq-investigate-results-timeseries (round 1):
  - New `features/investigate/components/InvestigateResults.tsx` with the props
    `{columns, rows, onOpenTrace?}`. It picks a renderer with common `getTelemetryResultShape`.
    A metric result renders `data-testid="investigate-timeseries"` with `data-series-count`,
    holding an ECharts line chart (the repo's `EChartsReactWrapper`, svg renderer, time x
    axis, scrolling legend, one line per series) that is 360px high through
    `InvestigateResults.module.css`. When there are no points it says "No data points".
    Every other shape currently renders a plain Mantine table (`data-testid="investigate-table"`).
  - New `features/investigate/utils/timeSeries.ts`: `groupTimeSeries(columns, rows)` and
    `findColumn`. The series name is the `series` column, or `labels` when there is no `series`
    column. Columns match case-insensitively. Timestamps may be ISO strings, epoch ms or Dates.
    Values that are numeric strings become numbers, and non-finite values become null (a gap).
    Points are sorted by time.
  - Next sessions: ldq-investigate-results-logs and ldq-investigate-results-traces add the
    `log` and `trace` branches in `InvestigateResults` (`onOpenTrace` is accepted but not used
    yet). The plain table stays the fallback for `table`. Nothing renders InvestigateResults on
    the page yet. The run wiring belongs to the workspace and time-range features.
  - Tested: no browser or backend (no Docker), and no Run button in Investigate yet, so the
    component was driven directly. The new `InvestigateResults.test.tsx` (5/5) feeds promql-shaped
    rows. It checks for one line per series, that ECharts draws an svg, and that no table
    appears; it also covers the empty metric result, the plain-table fallback, and the
    series/labels grouping including upper-cased columns. Feature check 1/1. frontend tsc
    clean; oxfmt and oxlint clean on changed files.
- 2026-11-08T20:54:11Z supervisor: ldq-investigate-results-timeseries passed the gate in round 1
- ldq-investigate-results-logs (round 1):
  - `InvestigateResults` has a `log` branch now. A log-shaped result (common
    `getTelemetryResultShape`: a timestamp plus line or message) renders
    `data-testid="investigate-log-list"` with `data-log-count`. It shows one row per log line:
    a `<time datetime>` with the ISO UTC timestamp, the line/message in monospace (pre-wrap),
    and under it, dimmed, the context (logql `stream`, else `labels`, else cloudwatch_logs
    `fields`). The list scrolls inside 600px max (`ScrollArea.Autosize`). Empty results say
    "No log lines". The styles are in `InvestigateResults.module.css` (.logLine, .logTimestamp,
    .logMessage).
  - New `features/investigate/utils/logLines.ts`: `toLogEntries(columns, rows)`. Columns match
    case-insensitively. Timestamps come out as ISO UTC strings; a value that is not a time is
    shown raw. JSON objects become text. `toEpochMs` in `timeSeries.ts` is now exported for
    reuse.
  - Decision: rows keep the order the query returned them in (the engine/user picks the
    sort). Nothing is re-sorted on the client.
  - Tested: no browser or backend (no Docker), and no Run button in Investigate yet, so the
    component was driven directly. `InvestigateResults.test.tsx` (8/8) adds toLogEntries for
    logql/cloudwatch_logs columns (upper-case, epoch, Date, invalid time) and component tests
    for the list with its `<time>` and the empty state. Feature check 2/2, regression
    investigate-results-metric 1/1. frontend tsc clean; oxfmt and oxlint clean on
    features/investigate.
  - Next: ldq-investigate-results-traces adds the `trace` branch (`onOpenTrace` still unused).
- 2026-11-08T20:56:23Z supervisor: ldq-investigate-results-logs passed the gate in round 1
- ldq-investigate-results-traces (round 1):
  - `InvestigateResults` has a `trace` branch now (common `getTelemetryResultShape`: any
    `trace_id` column, so both traceql search results and trace(...) span lists). It renders
    `data-testid="investigate-trace-table"`: every column in result order (root_service,
    root_name, duration_ms for searches; service, name, status, ... for spans). The trace id
    column (found case-insensitively) is monospace. When `onOpenTrace` is given, each non-empty
    trace id is a button-styled Anchor that calls `onOpenTrace(traceId)`. Without it, or for a
    null id, the id is plain text. The plain table (`investigate-table`) is still the fallback
    for `table` shapes. `ResultTable` is shared and now takes `testId`, `traceIdColumn` and
    `onOpenTrace`.
  - Decision: durations are shown as the raw value the engine returns (no ms/s formatting), so
    the table matches the SQL result exactly.
  - Next: nothing renders InvestigateResults on the page yet. The workspace feature should pass
    an `onOpenTrace` that runs the `trace('<id>')` SQL (common's TraceQL builder already makes
    it).
  - Tested: no browser or backend (no Docker), and no Run button in Investigate yet, so the
    component was driven directly. `InvestigateResults.test.tsx` (10/10) adds an upper-cased
    traceql result: one clickable id, a null id not clickable, and a click calls onOpenTrace
    once with the id. It also checks that span ids are plain text without onOpenTrace. Feature
    check 3/3, regression investigate-results-logs 2/2. frontend tsc clean; oxfmt and oxlint
    clean on features/investigate.
- 2026-11-08T20:58:24Z supervisor: ldq-investigate-results-traces passed the gate in round 1
- ldq-investigate-time-range (round 1):
  - New `features/investigate/components/InvestigateWorkspace.tsx`. This is the component the
    later Investigate acceptance tests load. It has a top row with the shared `TimeRangePicker`
    (default `now-6h`..`now`, or `initialTimeRange`) and a Run button. Below that are
    `InvestigateEditor` and then the result. Run is disabled while the SQL box is empty or a
    run is in flight. Each run calls `runQuery({ sql, timeRange: { from, to } })` with the SQL
    box text and the range in the control. The result block (`data-testid="investigate-result"`)
    is labelled "Results over <range label>" with the range that run used, so changing the
    control afterwards does not mislabel it. A failure shows a red "Query failed" Alert with the
    error message. A late answer from an earlier run is dropped.
  - Props so far: `runQuery` and `initialTimeRange` only. The acceptance tests also pass
    `access` and `onSaveAsChart`. They are not declared yet: the audited-query, write-mode and
    save-as-chart features add them (and `audit` on the request) when they use them.
  - The page is wired up. `pages/SqlRunner.tsx` renders `InvestigateWorkspace` in Investigate
    mode, replacing the placeholder editor. The new hook
    `features/investigate/hooks/useInvestigateRunQuery.ts` calls `executeSqlQuery`. It maps the
    VizColumn references to column names and the RawResultRows to rows.
    `ExecuteSqlQueryOptions` (executeQuery.ts) gained optional `timeRange` and `audit`. Each is
    put in the POST body only when given; the backend accepts both since
    ldq-query-routes-time-range-audit.
  - Not done: `onOpenTrace` is not passed to InvestigateResults yet. Running trace('<id>')
    directly would show a result that doesn't match the SQL box. A later session should put
    the trace SQL in the SQL box and then run it.
  - Lint trap: in this checkout every ancestor path contains `.factory`, so `oxfmt <files>` and
    `oxlint <files>` silently match 0 files. Workarounds: run `oxlint -c <frontend>/.oxlintrc.json .`
    from inside the folder, and use `oxfmt --stdin-filepath=<f> < <f>` and diff the output.
    The react only-export-components rule rejects exported constants in component files.
  - Tested: no browser or backend (no Docker), so the workspace was driven through its
    rendered UI in vitest. Feature check 2/2. The new InvestigateWorkspace.test.tsx (3/3)
    covers Run disabled without SQL, the result label keeping the range it ran with, and the
    failure alert. executeQuery.test.ts 6/6 checks that timeRange/audit are in the body only
    when given. Regressions: SqlRunner.investigate 5/5, sql-runner-mode-switch 2/2,
    investigate-results-traces 3/3. frontend tsc, oxlint and oxfmt are clean.
- 2026-11-08T21:04:43Z supervisor: ldq-investigate-time-range passed the gate in round 1
- ldq-investigate-audited-query (round 1):
  - `InvestigateWorkspace` shows a required "Description" field and an optional "Linear ticket"
    field below the editor. They appear whenever the current SQL box text is an Audited Query
    per common's `isAuditedSql` (it calls platform_query/explain/tables/columns), so they follow
    the SQL, not the source picker. If the user edits the SQL so it no longer calls a platform_*
    function, the fields hide and no audit is sent. Run is disabled while the Description is
    empty or blank.
  - `InvestigateRunRequest` gained `audit?: QueryAudit`. It is present only for audited SQL:
    `{ description }` trimmed, plus `ticket` only when a non-blank ticket is given. The ticket is
    free text (no ENG-123 format check; the spec doesn't define one). `useInvestigateRunQuery`
    passes `audit` to `executeSqlQuery`, which puts it in the POST body only when set.
  - Next: ldq-investigate-restricted-description (investigate-audit-retry.test.tsx) should
    reuse the same two fields. Show them also after an `isAuditDescriptionRequiredError`
    failure, and send `audit` on the rerun. `access` and `onSaveAsChart` props are still
    undeclared (the tests pass them as `any`).
  - Trap: with this checkout's `.factory` path, never pipe `npx oxfmt` output back over a file.
    npx fails here (EBADDEVENGINES, node 26 vs 24) and leaves the file empty. Use the repo-root
    `node_modules/.bin/oxfmt --stdin-filepath`, check that its exit code is 0 and its output is
    not empty, then move the output over the file. oxlint lives in
    packages/frontend/node_modules/.bin.
  - Tested: no browser or backend (no Docker), so I drove the workspace through its rendered UI
    in vitest. Feature check 3/3. InvestigateWorkspace.test.tsx 4/4: a new test covers a blank
    description keeping Run disabled, trimming, no ticket sent when it is blank, and editing
    the SQL away from platform_query dropping both the fields and the audit. Regression
    investigate-time-range 2/2. frontend tsc, oxlint and oxfmt are clean.
- 2026-11-08T21:08:02Z supervisor: ldq-investigate-audited-query passed the gate in round 1
- ldq-investigate-restricted-description (round 1):
  - `InvestigateWorkspace` handles the engine asking for a description. If a run *without*
    `audit` fails with an error matching common's `isAuditDescriptionRequiredError`, the
    workspace remembers that exact SQL (`descriptionRequiredForSql`). It treats that SQL as
    audited, so the same Description (required) and Linear ticket fields from
    ldq-investigate-audited-query appear and Run waits for a description. It shows a yellow
    "Audited Query" alert instead of the red "Query failed" one, and the rerun sends `audit`.
    The engine's request covers only the SQL it refused: editing the SQL hides the fields
    again, until the engine asks again. A run that already sent `audit` and is refused again
    shows as a normal failure, so it never loops on prompts. Other engine errors (e.g. a
    missing claim) show as before.
  - Trap: the alert title must not contain the word "Description". Mantine labels the alert
    by its title, so `getByLabelText(/Description/)` would match it too.
  - Not done: the `access` and `onSaveAsChart` props are still undeclared (the tests pass
    them as `any`).
  - Tested: no browser or backend (no Docker), so I drove the workspace through its rendered UI
    in vitest. Feature check 2/2. InvestigateWorkspace.test.tsx 5/5. Its new test covers the
    engine prompt, Run disabled until a description is given, a second refusal with audit
    shown as "Query failed", and different SQL hiding the fields. Regression
    investigate-audit-fields 3/3. frontend tsc, oxlint and oxfmt are clean.
- 2026-11-08T21:10:35Z supervisor: ldq-investigate-restricted-description passed the gate in round 1
- ldq-investigate-save-as-chart (round 1):
  - `InvestigateWorkspace` takes `onSaveAsChart?: ({ name, sql }) => Promise<void>`. When it is
    given, a "Save as chart" button sits next to Run. It is disabled while the SQL box is empty;
    a run is not required. It opens a "Save as chart" dialog with a "Chart name" field. The dialog
    saves the SQL taken when it opened, with the name trimmed. If the save throws, the dialog
    stays open with the reason. Without `onSaveAsChart` the button is hidden.
  - New `useInvestigateSaveAsChart(projectUuid)` (features/investigate/hooks), wired in
    `pages/SqlRunner.tsx`. It creates the chart through the existing
    `useCreateSqlChartMutation`: POST /sqlRunner/saved with a TABLE config, limit
    DEFAULT_SQL_LIMIT and no description. The mutation shows its success/error toast and
    navigates to the new chart.
  - Contract assumption (the spec doesn't say where the chart goes): it saves to the first space
    the user can create charts in. That is the same space the SQL runner's own save dialog
    preselects. With no such space it throws "You have no space you can save charts in", and the
    dialog shows that. No warehouseConnectionUuid is sent, because Investigate runs don't send
    one either.
  - Trap: the Chart name field must not be `required`. Mantine's asterisk makes the label
    "Chart name *", and the acceptance test matches 'Chart name' exactly. Save is disabled until
    a name is entered instead.
  - Not done: the `access` prop is still undeclared (it belongs to the write-mode/platform
    features).
  - Tested: no browser or backend (no Docker), so I drove the workspace through its rendered UI
    in vitest. Feature check 2/2. InvestigateWorkspace.test.tsx 7/7: new tests cover the hidden
    button without `onSaveAsChart`, and a failed save keeping the dialog open before a retry
    succeeds with the trimmed name. Regression investigate-audit-retry 2/2. frontend tsc,
    oxlint and oxfmt are clean. The page hook itself has no unit test.
- 2026-11-08T21:14:30Z supervisor: ldq-investigate-save-as-chart passed the gate in round 1
- ldq-platform-schema-sql (round 1):
  - common `utils/auditedSql.ts` now exports `PLATFORM_TABLES_SQL`
    (`SELECT table_schema, table_name FROM platform_tables()`) and
    `buildPlatformColumnsSql(schema, table)`
    (`SELECT column_name, data_type, is_nullable FROM platform_columns('<schema>', '<table>')`).
    Both names become SQL string literals with single quotes doubled. That is the same private
    `sqlStringLiteral` helper `buildPlatformQuerySql` now uses. The column lists follow
    CONTRACTS §1.1. Both statements are Audited Queries under `isAuditedSql`, so the schema
    browser has to send them with an audit description like any platform_* call.
  - Not done (next feature, ldq-platform-schema-browser): no UI uses these yet. The browser
    should run them through the same SQL runner path Investigate uses.
  - Tested: this is a pure common helper with no running UI to drive. Feature check 3/3.
    auditedSql.test.ts 7/7: new cases cover quotes in both schema and table names, and both
    statements counting as audited. common tsc, oxfmt and oxlint are clean.
- 2026-11-08T21:16:56Z supervisor: ldq-platform-schema-sql passed the gate in round 1
- ldq-platform-schema-browser (round 1):
  - New `PlatformSchemaBrowser` (features/investigate/components). Props are `loadTables()`,
    `loadColumns(schema, table)` and `onInsert(text)`. The row types follow CONTRACTS §1.1
    (`PlatformTable`, `PlatformColumn`), and the loaders are grouped as `PlatformSchemaLoaders`.
    Tables load once on mount and are grouped by schema, with schemas and tables sorted. The
    "Search tables" field filters by table name, case-insensitively. Clicking a table expands it
    and loads its columns once, cached per table (a failed load retries on the next open). Each
    column shows its name, data type and "not null" when `is_nullable` is false. Clicking a column
    calls `onInsert(column_name)` with the raw, unquoted name. A failed table load shows its
    message in a "Could not load tables" alert.
  - Wiring: `InvestigateWorkspace` and `InvestigateEditor` take an optional
    `platformSchema?: PlatformSchemaLoaders`. With it, the Platform Database source shows a
    "Browse tables" / "Hide tables" toggle under the Platform SQL box. The browser mounts, and so
    reads the catalog, only when the user opens it. A clicked column replaces the selection in
    the Platform SQL box, or is appended at the end if the box was never focused. That regenerates
    the platform_query SQL as usual. `pages/SqlRunner.tsx` passes in
    `usePlatformSchemaLoaders(projectUuid)` (features/investigate/hooks), which runs
    `PLATFORM_TABLES_SQL` / `buildPlatformColumnsSql` through `executeSqlQuery`, the same path
    Investigate runs on, with no time range. It coerces values to strings, and `is_nullable`
    from true/'true'/'t'.
  - Contract assumption (the spec doesn't say which description catalog reads carry): the
    loaders send fixed audit descriptions, "Schema browser: list Platform Database tables" and
    "Schema browser: list columns of <schema>.<table>", with no ticket. The user is not asked
    for a description to browse.
  - Tested: no browser or backend (no Docker), so I drove the components through their rendered
    UI in vitest. Feature check 3/3. InvestigateWorkspace.test.tsx 8/8: the new test covers no
    toggle without loaders, no catalog read before opening, and a column inserted at the cursor
    flowing into the SQL box. Regressions investigate-audit-fields 3/3,
    investigate-editor-sources 6/6 and investigate-editor-sql-editable 2/2. frontend tsc, oxlint
    and oxfmt are clean. The page hook has no unit test.
- 2026-11-08T21:22:01Z supervisor: ldq-platform-schema-browser passed the gate in round 1
- ldq-platform-explain-sql (round 1):
  - common `utils/auditedSql.ts` now exports `buildPlatformExplainSql(statement)`, which builds
    `SELECT plan FROM platform_explain('<statement>')` with single quotes doubled (the shared
    `sqlStringLiteral`). It wraps the raw Platform SQL statement, not the generated
    platform_query SQL. The next feature's acceptance test expects exactly that.
  - New common `utils/explainPlan.ts` exports `formatExplainPlanAsText(plan)`. It follows the
    explain.c text layout: the root line, then child lines as `->  ` (child arrows at 2, 8, 14...
    spaces), and `(cost=a.aa..b.bb rows=n width=w)`. It accepts the Postgres plan array, one
    `{ Plan }` element, a bare plan node, or any of those as a JSON string, and throws
    "Not a Postgres JSON explain plan" otherwise. It also renders Aggregate strategies
    (HashAggregate, ...), non-inner join types ("Hash Left Join"), Parallel, Backward,
    `using <index>`, `on <relation> <alias>` (CTE and function scans too), Subplan Name lines,
    and these detail lines: Group/Sort Key, Hash/Merge Cond, Join Filter, Index/Recheck Cond,
    One-Time Filter and Filter. Other keys (actual times, Output, Workers...) are not printed.
    That is enough for estimate-only plans.
  - Not done (next feature, ldq-platform-explain-only): there is no Explain button or download
    UI yet. Its frontend test wants `runQuery` called with buildPlatformExplainSql(<Platform SQL>)
    plus the audit description, the plan text shown, and "Download JSON" / "Download text" data:
    links (explain-plan.json / explain-plan.txt). The `plan` cell may arrive as a JSON string.
  - Tested: this is a pure common helper with no running UI to drive. Feature check 3/3, and the
    new explainPlan.test.ts 3/3 (joins, aggregates, index scans, subplans, bad input).
    auditedSql.test.ts 8/8. common tsc, oxlint and oxfmt are clean.
- 2026-11-08T21:27:32Z supervisor: ldq-platform-explain-sql passed the gate in round 1
- ldq-platform-explain-only (round 1):
  - `InvestigateWorkspace` takes an optional `access?: FederationAttrs`. On the Platform Database
    source, Run shows only with `platform_read`, and Explain shows with `platform_read` or
    `platform_explain` (CONTRACTS 1.2). Other sources always show Run. With no `access` (the
    unit tests, or before the claims load), both show and the engine decides.
  - Explain sends `buildPlatformExplainSql(<Platform SQL statement>)`, which wraps the raw
    statement, not the SQL box. It always sends the audit (description plus optional ticket)
    and waits for a description. The `plan` cell of row 0 may be JSON text or an object. It
    renders through `formatExplainPlanAsText` in new `components/ExplainPlan.tsx`: a Code block,
    plus "Download JSON" / "Download text" data: links (explain-plan.json / .txt; the JSON is
    pretty-printed). A failure shows an "Explain failed" alert. The plan has no
    "Results over ..." label.
  - Audit fields: always shown for an explain-only user on the Platform Database. For everyone
    else they still follow the SQL box (an existing unit test pins this), and Explain stays
    disabled while they are hidden.
  - `InvestigateEditor` adds the optional `onSourceChange` and `onPlatformSqlChange` callbacks.
    The workspace needs the source before any SQL exists, and an emptied Platform SQL box,
    which never produces an editor change.
  - Page wiring: new `hooks/useFederationAccess(projectUuid, enabled)` fetches GET
    `/api/v2/projects/{uuid}/federation/access`. SqlRunner enables it only for federation
    projects and passes `attrs` as `access`. common `types/api.ts` adds
    `ApiFederationAccessResponse['results']` to `ApiResults` so lightdashApi accepts it.
  - Tested: no browser or backend, so I drove the components through vitest. Feature check 3/3.
    InvestigateWorkspace.test.tsx 9/9: the new test explains the Platform SQL, then a failed
    explain, then clearing the SQL disables Explain. Regressions investigate-audit-fields 3/3,
    audit-retry 2/2, time-range 2/2, save-as-chart 2/2 and editor-sources 6/6. frontend
    typecheck, oxlint and oxfmt are clean. The useFederationAccess hook has no unit test.
  - Next (write-mode-toggle) already passes `access` with `platform_write`. This feature does
    not interpret `platform_write`.
- 2026-11-08T21:34:37Z supervisor: ldq-platform-explain-only passed the gate in round 1
- ldq-saved-sql-picker (round 1):
  - New `SavedSqlPicker` (features/investigate/components) takes `{items, onSelect}`. `SavedSqlItem`
    is `{uuid, name, description|null, spaceName}`, and the props are generic, so extra fields
    such as the acceptance test's `sql` go back to onSelect unchanged. The "Search saved SQL" field
    matches name, description and space name, case-insensitively. An empty list shows
    "No saved SQL yet", with no search box.
  - `InvestigateWorkspace` takes an optional `savedSql?: SavedSqlLoaders`
    (`{loadItems(), loadSql(item)}`). With it, a "Saved SQL" button opens a "Saved SQL" modal.
    The list loads each time the modal opens, never before. Picking a script loads its SQL. A
    failure shows "Could not open <name>" and the modal stays open. On success the modal closes
    and the editor is remounted (`key`) with `initialSql`. The workspace resets its own
    source/platformStatement to match the new editor (Prometheus, empty Platform SQL), so the
    source picker shows Prometheus while the SQL box holds the saved SQL. Saved platform_query
    SQL is still an Audited Query through isAuditedSql. Explain stays disabled until the user
    types Platform SQL, because it explains the Platform SQL box.
  - Page wiring: the new `hooks/useOperationsSavedSql(projectUuid)` lists GET
    `/api/v2/content?projectUuids=<p>&contentTypes=chart` (100 per page, up to 10 pages, sorted by
    name). It keeps `source === 'sql'` and reads the SQL on pick through the existing
    `fetchSavedSqlChart` (GET `/api/v1/projects/{p}/sqlRunner/saved/{uuid}`). SqlRunner passes it
    as `savedSql`.
  - Contract assumption: the "Operations Project" is the federation project the SQL Runner is
    on, and "shared" saved SQL is every SQL chart the content API returns for it (spaces the
    user can view). Private spaces are not filtered out.
  - Tested: no browser or backend (no Docker), so I drove the components through vitest. Feature
    check 3/3. InvestigateWorkspace.test.tsx 10/10: the new test opens Saved SQL, sees name,
    description and space, searches, fails to open one, opens another into the SQL box, and runs
    it with an audit description. Regressions save-as-chart 2/2, platform-explain-only 3/3,
    audit-fields 3/3 and time-range 2/2. frontend typecheck, oxlint and oxfmt are clean.
    The useOperationsSavedSql hook has no unit test.
- 2026-11-08T21:38:44Z supervisor: ldq-saved-sql-picker passed the gate in round 1
- ldq-cli-import-portal-scripts (round 1):
  - New `packages/cli/src/handlers/importPortalScripts.ts` and the `lightdash import portal-scripts
    <file> [--path <dir>] [--space <slug>] [--verbose]` command (`import` is a new parent command in
    index.ts, after `upload`). It writes `<path>/charts/<slug>.yml`, and `--path` defaults to
    ./lightdash like download/upload. Each script becomes a `sql_chart`: version 1, name = title
    (trimmed), description (empty becomes null), sql, spaceSlug, limit 500 (the SQL runner's
    default), chartKind table, and config `{metadata:{version:1}, type:table, columns:{}, display:{}}`.
    Only id/title/description/sql are read, so author email/Auth0 sub, tags and execution stats
    never reach the YAML.
  - Slugs: `generateSlug(title)`, truncated to leave room for a suffix. Repeated slugs get `-2`,
    `-3`, ... in export order. A title with no letters or digits gets `saved-script` instead of
    generateSlug's random slug, so re-imports write the same files. Existing files with the
    same slug are overwritten.
  - Validation runs before anything is written. Anything that is not a JSON array of objects
    with non-empty string id/title/sql (and a string or null description) fails with ParseError
    "<file> is not a db-query-portal saved-scripts export: <reason>...". Exit code 1, and no
    charts/ folder is created. An empty array is valid and writes 0 charts.
  - Contract assumptions: CONTRACTS/ADR 0004 say only "saved scripts become shared saved SQL in
    the Operations Project". The default `--space` is `platform-saved-sql` (the slug the
    acceptance test uses). `--space` is taken as given (nested `a/b` slugs allowed), only
    trimmed. The export shape is the acceptance test's SavedScript fixture.
  - Tested: ran the built CLI (dist/index.js) by hand on a synthetic 3-script export. It wrote 3
    files (stuck-refills-by-status, -2, rx-pending-7-days) and printed "Imported 3 saved
    scripts...". `lightdash lint --path lightdash` found the 3 files valid, and it flags one when
    broken. `{"hello":"world"}`, invalid JSON and a missing file each fail with a clear message,
    exit 1, and leave no output. Feature check 2/2. New unit test importPortalScripts.test.ts
    10/10. cli typecheck, oxlint and oxfmt are clean. `lightdash upload` against a real server
    was not run (no backend).
- 2026-11-08T21:44:11Z supervisor: ldq-cli-import-portal-scripts passed the gate in round 1
- ldq-write-confirmation-route (round 1):
  - New `controllers/v2/FederationWriteController.ts` at `/api/v2/projects/{projectUuid}/write`
    with `POST /confirmations` (operationId createWriteConfirmation; it uses allowApiKeyAuthentication,
    isAuthenticated and unauthorisedInDemo). The next write features should add `POST /` (preview
    and commit) to this controller. Routes and swagger were regenerated by init.sh.
  - `FederationService.createWriteConfirmation(account, projectUuid, statement)`. It checks, in
    this order: blank or non-string statement -> 400 ParameterError; view Project ability (403);
    not a federation project -> 400 NotSupportedError; platform_write not "true" -> 403
    ForbiddenError; connection without identitySigningSecret -> 400. It never calls the engine.
    getAccess now shares the new private getViewableProject and getAttrs helpers, with unchanged
    behaviour (federation-access-route 3/3).
  - New `services/FederationService/writeConfirmationToken.ts` mints the token, using the §3
    envelope (base64url payload, then HMAC-SHA256 base64url, signed with the identity secret).
    The payload keys are, in order: `{v:1, statement_sha256 (hex sha256 of the statement exactly
    as sent, untrimmed), sub (user uuid), project, exp (now + 120 s, capped at 120), nonce (16
    random bytes, base64url)}`.
  - Common: ApiWriteConfirmationRequest, WriteConfirmation {confirmationToken, expiresAt (ISO of
    exp)} and ApiWriteConfirmationResponse, added to the ApiResults union.
  - Contract assumption: CONTRACTS §4.2 names the bound fields but not the payload keys or
    layout. I used the acceptance test's keys, with no iat. The engine (another line) must verify
    exactly this payload. Lightdash keeps no record of used nonces, because single use is the
    engine's job (409 on reuse).
  - Tested: no Docker or backend server, so I drove the real TSOA routes in-process through the
    route harness. Feature check 4/4. A scratch route test, since deleted, confirmed: 200 with
    {confirmationToken, expiresAt}; 400 for a missing or blank statement; 403 with no attribute
    and with platform_write "yes"; 400 with a clear message when the secret is missing. New unit
    test writeConfirmationToken.test.ts 5/5. Backend tsc --noEmit, oxlint and oxfmt are clean.
    Frontend not touched.
- 2026-11-08T21:50:15Z supervisor: ldq-write-confirmation-route passed the gate in round 1
- ldq-write-preview-route (round 1):
  - `POST /api/v2/projects/{projectUuid}/write` (operationId runWrite) is on
    FederationWriteController and calls the new `FederationService.write(account, projectUuid, body)`.
    It only uses getFederationService, never AsyncQueryService.
  - New `services/FederationService/engineWrite.ts`:
    - `parseWriteRequest` checks the body in this order. A blank or missing description gives
      400 before anything else, including the project load. Then statement, then mode, then
      confirmationToken, then ticket (string or null). The statement and token are sent
      byte-for-byte as given, because the confirmation token is bound to sha256 of the exact
      statement. Description and ticket are trimmed, and a blank ticket becomes null.
    - `postEngineWrite` POSTs `{statement, mode, confirmation_token, description, ticket}` to
      `<httpBaseUrl>/v1/write` (trailing slashes stripped) with `Authorization: Bearer
      <identity token>`, with a 60 s timeout. A 2xx JSON object comes back to the client as is.
      An engine 4xx is passed back with its status and with the `error` (or `message`) text as
      a LightdashError named FederationEngineError. An engine 5xx, a non-JSON body or an
      unreachable engine gives 500 UnexpectedServerError.
  - After parsing, `write` checks: view Project (403), federation project (400), platform_write
    "true" (403), identitySigningSecret present (400), httpBaseUrl present (400), and the user
    has an email (403, which should not happen for registered users). It then mints a fresh token
    through FederationIdentityService.mintForUser, which FederationService now builds itself from
    its userAttributesModel. The token has audit `{description, ticket, source: 'write_mode',
    resource_uuid: null}` and the agent flag from isAgentSession() (the live agent execution context).
  - **Mode "commit" is deliberately refused with 400 "Write Mode commit is not available yet"**
    (NotSupportedError in parseWriteRequest). ldq-write-commit-route should replace that branch
    so commit goes the same way. The engine-refusal pass-through (409, 403) is already in
    postEngineWrite. ldq-write-agent-refused should refuse commit when isAgentSession() is true.
  - Common: WriteMode, ApiWriteRequest, WriteResult (the engine's snake_case result as is) and
    ApiWriteResponse, added to the ApiResults union. Routes and swagger were regenerated by init.sh.
  - Trap: the backend unit-test setup stubs global fetch. Tests that hit a real local HTTP server
    must call `vi.unstubAllGlobals()` (engineWrite.test.ts does this).
  - Tested: no Docker or backend server, so I drove the real TSOA routes in-process through the
    route harness against the fake engine. A scratch test, since deleted, confirmed:
    - 200 with the engine result. A trailing-slash base URL works, and a blank ticket is sent as null.
    - 400 for: no description; mode commit; mode force; empty token; a plain Postgres project.
    - Engine 403 comes back as 403 with the engine's message. Engine 500 comes back as 500, and
      an unreachable engine gives 500 "Could not reach the Federation Engine".
    Feature check 3/3, write-confirmation-route 4/4, new engineWrite.test.ts 11/11. Backend tsc
    --noEmit, oxlint and oxfmt are clean.
- 2026-11-08T21:56:28Z supervisor: ldq-write-preview-route passed the gate in round 1
- ldq-write-commit-route (round 1):
  - `parseWriteRequest` (services/FederationService/engineWrite.ts) now takes mode "commit"
    as well as "preview". `ParsedWriteRequest.mode` is common's `WriteMode`. The temporary 400
    "Write Mode commit is not available yet" branch is gone. Commit goes through the same
    `FederationService.write` path: same checks, a fresh identity token with audit source
    write_mode, and `mode: "commit"` in the engine body. Any other mode is still a 400 before
    the engine is called.
  - The engine's refusals reach the client through postEngineWrite's existing 4xx pass-through:
    409 for a reused confirmation and 403 for a guard refusal, each with the engine's message.
    No new code was needed for that.
  - The unit test engineWrite.test.ts now expects commit to be accepted. The write() doc comment is updated.
  - Next: ldq-write-agent-refused must refuse commit when isAgentSession() is true. Put that
    check in FederationService.write after parsing. parseWriteRequest has no agent context.
  - Tested: no Docker or backend server, so I drove the real TSOA route in-process against the
    fake engine through the acceptance harness. Feature check 4/4: commit 200 with the engine
    result, body mode commit, ticket null; engine 409 gives 409; engine 403 gives 403; mode
    force gives 400 with no engine call. write-preview-route 3/3, engineWrite.test.ts 11/11.
    Backend tsc --noEmit, oxlint and oxfmt are clean.
- 2026-11-08T21:59:30Z supervisor: ldq-write-commit-route passed the gate in round 1
- ldq-write-agent-refused (round 1):
  - `FederationService.write` now refuses mode "commit" with 403 "AI agents may preview writes
    but cannot commit them" when `isAgentSession()` is true (a live agentExecutionContext, the
    same signal the identity token's agent flag uses). The check runs right after
    parseWriteRequest, so for an agent commit nothing is loaded from the project and the engine
    is never called. Preview from an agent goes on as before, and its identity token carries
    `agent: true` through mintForUser's default. A person outside an agent context can still commit.
  - Decision: the refusal comes before the view/platform_write checks, so an agent always gets
    the same 403 for commit whatever its permissions. That tells it nothing about the project.
  - Tested: no Docker or backend server, so I drove the real TSOA route in-process against the
    fake engine through the acceptance harness, both inside and outside an agent execution
    context. Feature check 3/3: agent commit 403 with zero engine requests; agent preview 200
    with token agent=true; person commit 200. write-commit-route 4/4 and write-preview-route
    3/3. Backend tsc --noEmit, oxlint and oxfmt are clean.
- 2026-11-08T22:02:32Z supervisor: ldq-write-agent-refused passed the gate in round 1
- ldq-write-mode-toggle (round 1):
  - New `features/investigate/components/WriteModePanel.tsx` exports `WriteModeApi`
    ({ createConfirmation(statement), write(ApiWriteRequest) }) and `WriteModePanel`
    ({ statement, api }), the interface the write-mode-preview/commit acceptance tests use. For
    now the panel (data-testid write-mode-panel) shows the statement in a code block and a
    Preview button that is **always disabled**. `api` is accepted but not used yet.
  - `InvestigateWorkspace` takes an optional `writeApi`. A "Write Mode" Switch shows only on
    the Platform Database source, only with writeApi, and only when `access.platform_write ===
    true`. Unknown access (undefined) never offers it, unlike Run/Explain, which default to
    offered. While Write Mode is on, Run, Explain, the audit Description/ticket fields and the
    run result are hidden, and the panel shows the raw Platform SQL statement (not the
    wrapped SQL box). Leaving the Platform source hides the toggle and the panel.
  - New hook `hooks/useWriteModeApi.ts` POSTs to /api/v2/projects/{uuid}/write/confirmations
    and /api/v2/projects/{uuid}/write. SqlRunner passes it as writeApi.
  - Next (ldq-write-mode-preview): wire Preview in WriteModePanel and add the panel's own
    Description and Linear ticket fields. The workspace hides its own audit fields in Write
    Mode, so the labels won't clash. Commit (COMMIT typed confirmation) comes after that.
  - Tested: no Docker or backend server and no browser tool, so I rendered the real
    InvestigateWorkspace in jsdom. Feature check 2/2. Added 2 InvestigateWorkspace unit tests:
    toggle hidden with no access info, with platform_write it shows, and it is hidden again on
    Prometheus; Write Mode replaces Run/Explain and turning it off brings them back. 12/12.
    platform-explain-only 3/3. Frontend typecheck, oxlint and oxfmt are clean.
- 2026-11-08T22:06:23Z supervisor: ldq-write-mode-toggle passed the gate in round 1
- ldq-write-mode-preview (round 1):
  - `WriteModePanel` now has its own Description (required) and Linear ticket (optional)
    fields and a working Preview. Preview is enabled only when the statement and the
    description are non-blank. On click it calls `api.createConfirmation(statement)` to get a
    fresh token, then `api.write({ statement, mode: 'preview', confirmationToken, description,
    ticket? })`. Both values are trimmed, and a blank ticket is left out. The result
    (data-testid write-mode-result) shows a "Rolled back" badge (or "Committed" when the
    engine returns preview false), "Rows affected: N", and the `returning` rows as a table
    (data-testid write-mode-returning). Refusals show in a red "Write refused" alert.
  - Decision: errors come from an Error's message or from a Lightdash API error body
    `{ error: { message } }`. That body is what `lightdashApi` throws in the real app, so the
    engine's refusal text reaches the user.
  - Decision: a result or refusal belongs to the statement it ran. Once the statement is
    edited it is hidden, so a stale preview never describes different SQL.
  - Next (ldq-write-mode-commit): add the "Type COMMIT to confirm" field and a Commit button in
    the same panel. Reuse the WriteState/handlePreview flow with mode 'commit' and its own
    confirmation token, show the audit_id in WriteResultView, and clear the COMMIT input after
    a commit.
  - Tested: no Docker or browser tool, so I rendered the real panel in jsdom. Feature check 2/2.
    New WriteModePanel.test.tsx 2/2 covers an API error body, the blank ticket being left out,
    a blank statement keeping Preview disabled, and a stale result being hidden.
    InvestigateWorkspace 12/12, write-mode-toggle 2/2. Frontend typecheck, oxlint and oxfmt
    are clean.
- 2026-11-08T22:09:31Z supervisor: ldq-write-mode-preview passed the gate in round 1
- ldq-write-mode-commit (round 1):
  - `WriteModePanel` now has a "Type COMMIT to confirm" field and a red Commit button next to
    Preview. Commit is enabled only when Preview could run (the statement and the description
    are non-blank and nothing is running) and the field holds exactly `COMMIT`, case-sensitive.
    Preview and Commit share one `runWrite(mode)` flow, and each call fetches its own fresh
    confirmation token from `api.createConfirmation(statement)`.
  - Decision: the typed COMMIT is cleared as soon as a commit is sent, whether it then
    succeeds or is refused, so every commit attempt has to be confirmed again.
  - The result view now shows "Audit id: <id>" for both previews and commits, and "Committed"
    when the engine returns preview false. A refused commit uses the existing "Write refused"
    alert, falling back to "The commit failed".
  - Tested: no Docker or browser tool, so I rendered the real panel in jsdom. Feature check 3/3.
    WriteModePanel.test.tsx 3/3; the new test covers a refused commit: the error is shown, the
    confirmation is cleared and Commit is disabled again. write-mode-preview 2/2 and
    write-mode-toggle 2/2. Frontend typecheck, oxlint and oxfmt are clean.
- 2026-11-08T22:11:54Z supervisor: ldq-write-mode-commit passed the gate in round 1
- ldq-audit-route (round 1):
  - `GET /api/v2/projects/{projectUuid}/federation/audit?ticket&user&month&cursor` is a new
    method `listFederationAudit` on the existing `FederationController`. It calls
    `FederationService.listAudit`, which mints a fresh identity token for the user and calls
    `GET {httpBaseUrl}/v1/audit`. It returns `{status:'ok', results:<engine page>}`, and the page
    passes through unchanged.
  - Filters are trimmed, and blank or missing ones are left out, so the engine only ever gets the
    filters that were given. A month that isn't `YYYY-MM` with a month from 01 to 12 is a 400,
    returned before anything is loaded. Without `platform_read` the route returns 403, and
    non-federation projects get NotSupported. Both happen before the engine is called.
  - New common types are `AuditExecution`, `AuditFilters`, `AuditPage` (`{items, nextCursor}`)
    and `ApiAuditPageResponse`, and `AuditPage` is added to `ApiResults`. `nextCursor` is typed
    `string | null`, and the frontend should treat null or a missing value as the last page.
  - Refactor: the engine HTTP call (fetch, bearer token, timeout, 4xx passthrough, 5xx becomes
    500) moved from `engineWrite.ts` to `engineHttp.ts` `requestEngine`. Write and audit both use
    it. `engineAudit.ts` holds `parseAuditFilters` and `getEngineAudit`.
  - Decision: see Contract assumption 12 (the audit browser token uses source `investigate`).
  - Next (ldq-audit-browser-ui): the client is
    `GET /api/v2/projects/{uuid}/federation/audit` with the filters as query params. Don't send
    empty strings. The server drops them anyway.
  - Tested: no Docker, running server or browser, so I drove the real Express app with the
    generated TSOA routes through the acceptance harness. Feature check 4/4. The engine got
    exactly the given query params and a validly signed token (sub, attrs.platform_read). A user
    with only platform_explain got 403, `month=2026-13` got 400, and the engine was called in
    neither case. New engineAudit.test.ts 9/9 covers trimming, bad months, URL encoding, and
    engine 403/503. engineWrite.test.ts 11/11. write-preview-route 3/3, write-commit-route 4/4,
    write-agent-refused 3/3 and federation-access-route 3/3 all pass. Backend and common
    typecheck, oxlint and oxfmt are clean.
- 2026-11-08T22:16:44Z supervisor: ldq-audit-route passed the gate in round 1
- ldq-audit-browser-ui (round 1):
  - New `features/auditBrowser/components/AuditBrowser.tsx` (`{canRead, fetchPage}`). It shows
    Ticket, User and Month text fields with an "Apply filters" button, and a table with the
    columns Time (UTC), User (`executedByEmail`), Description, Ticket (`linearTicketId`), Mode
    (plus a preview badge), Status and Rows. On mount it calls `fetchPage({})`. Apply sends the
    trimmed filters and leaves blank ones out. Without `canRead` it shows an alert naming
    platform_read and never calls `fetchPage`. Fetch errors show the Lightdash error message in
    an alert, and a stale response is dropped when a newer query starts.
  - `features/auditBrowser/hooks/useAuditBrowserApi.ts` calls
    `GET /api/v2/projects/{uuid}/federation/audit` with only the non-blank filters as query
    params.
  - New page `pages/AuditBrowser.tsx` at the route `/projects/:projectUuid/audit` (in
    PROJECT_LAYOUT_ROUTES). It reads `useFederationAccess`. A non-federation project gets "only
    available on Federation Engine projects". Otherwise it renders the browser with
    `canRead = attrs.platform_read`. Investigate mode in the SQL Runner has an "Audit browser"
    link next to the mode switch, shown to everyone in Investigate so that users without
    platform_read can still see why.
  - Next (ldq-audit-browser-pagination): the component keeps the applied filters in the `query`
    state, and the effect refetches whenever it changes. Add a "Next page" button that's shown
    only when `page.nextCursor` is set, and call `fetchPage({...query, cursor})`. Keep the
    cursor out of the filter form. The pagination check currently fails only on the missing
    "Next page" button.
  - Tested: no Docker, running server or browser tool, so I rendered the real component in
    jsdom. Feature check 2/2. New AuditBrowser.test.tsx 3/3 covers trimming and blank filters,
    an API error message, and the hook's URL with and without filters. sql-runner-mode-switch
    2/2. Frontend typecheck, plus oxlint and oxfmt on the changed files, are clean.
- 2026-11-08T22:20:36Z supervisor: ldq-audit-browser-ui passed the gate in round 1
- ldq-audit-browser-pagination (round 1):
  - `AuditBrowser.tsx`: the `query` state is now `request: {filters, cursor?}`. The effect
    calls `fetchPage(filters)` on page 1 and `fetchPage({...filters, cursor})` after that, so
    page 1 gets no `cursor` key at all. A "Next page" button shows only when `page.nextCursor`
    is set, and a "First page" button shows once you're past page 1. Both are disabled while
    a page loads. They keep the *applied* filters and ignore anything typed into the form since.
    "Apply filters" clears the shown page and the cursor, so a cursor from one query is never
    used under another. The hook already forwarded `cursor` as a query param, so it's unchanged.
  - Tested: no Docker, running server or browser tool, so I rendered the real component in
    jsdom. Feature check 1/1. audit-browser 2/2 still passes. AuditBrowser.test.tsx is now 4/4:
    a new case covers Next with the applied filters rather than the edited form, First page,
    and Apply restarting at page 1. Frontend typecheck, oxlint and oxfmt are clean.
- 2026-11-08T22:22:53Z supervisor: ldq-audit-browser-pagination passed the gate in round 1
- ldq-identity-token-not-logged (round 1):
  - The acceptance check already passed on arrival: `requestEngine` never puts the bearer into
    its own messages, and no Federation code logs tokens or the signing secret. One real gap
    remained. The engine's own `error`/`message` text, and a `fetch` failure message, were
    passed through word for word into the Lightdash error response and the error log, so an
    engine that echoed the bearer (e.g. "invalid token <jwt>") would have leaked it.
  - `services/FederationService/engineHttp.ts`: new exported `redactIdentityToken(text, token)`
    replaces the whole token and each dot-separated part of 8+ characters (header, payload,
    signature) with `[redacted]`. Both the engine-error path and the unreachable-engine path
    use it. Write and audit both go through `requestEngine`, so they're both covered.
  - New `engineHttp.test.ts` 4/4: redaction of the token and its parts, and a local HTTP
    server that echoes the token in 403 and 500 errors, so the thrown error carries only
    `[redacted]`.
  - Tested: no running server or browser. The acceptance check drives the real TSOA routes
    (write preview, audit) against the fake engine failing with 500/503, and captures
    console, Logger, stdout and stderr. Feature check 2/2. engineAudit 9/9, engineWrite 11/11.
    Backend typecheck, oxlint and oxfmt are clean.
  - Next session: any new call to the engine should go through `requestEngine` (or use
    `redactIdentityToken`), so engine text never reaches a user or a log unredacted.
- 2026-11-08T22:25:45Z supervisor: ldq-identity-token-not-logged passed the gate in round 1
