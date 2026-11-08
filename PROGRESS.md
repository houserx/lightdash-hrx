# Line `alerting` (ENG-1799): progress and conventions

This line builds **Alert Rules, Contact Points and Notification Routes** in Lightdash, replacing Grafana alerting (ADR 0001, `docs/eng-1799/CONTRACTS.md` §4.3). It is *not* Lightdash's existing scheduler "Alerts" — never extend those; Alert Rules have their own tables, services and UI.

Read first, every session: `CONTEXT.md` (glossary — use its terms, never its _Avoid_ terms), `docs/adr/0001`–`0004`, `docs/eng-1799/CONTRACTS.md`. The feature yardstick is today's Grafana in the read-only infra snapshot: `/Users/joseph.fahnestock/Locals/Tinkering/eng-1799-factory/refs/infra@bf3093da/terraform-tooling/grafana_{rule_groups_*,lb_rules,contact_points,notification_policy,alert_message_template}.tf`.

## Status

- Session 1 (init, 2026-11-08): harness, 75 features, acceptance tests. **No feature is built yet.** Every check fails on the initial tree for the expected reason (missing module or export).
- Later sessions: take features strictly in the order of the feature list, one at a time. Append a line here per feature you finish (id, date, notes).

## How to run

```bash
bash ./init.sh          # pnpm install --frozen-lockfile (only when manifests change),
                        # then builds formula, common, warehouses, visualization (only when their src changed).
                        # Starts no server. ~45 s cold, <1 s warm.
```

Each feature's `check` is one command from the repo root. Runners (all inside protected folders):

| Package | Runner | Notes |
|---|---|---|
| common | `bash packages/common/src/__acceptance__/alerting/run.sh <file> -t '^<id> '` | vitest, node |
| backend | `bash packages/backend/src/__acceptance__/alerting/support/run.sh <file> -t '^<id> '` | starts a throwaway Postgres (see below), then vitest |
| cli | `bash packages/cli/src/__acceptance__/alerting/run.sh <file> -t '^<id> '` | spawns the CLI from source (`tsx src/index.ts`) against a mock API |
| frontend | `bash packages/frontend/src/__acceptance__/alerting/run.sh <file> -t '^<id> '` | the app's vite config + jsdom; one file per run |

`-t '^<id> '` selects one feature's `describe` block; other features in the same file are skipped. Each check is 2–30 s warm.

**Throwaway Postgres (backend).** `support/run.sh` keeps a cluster data dir in `tmp/alerting-pg/` (gitignored), starts `postgres` on a free `127.0.0.1` port with `unix_socket_directories=''`, exports `PGHOST/PGPORT/PGUSER=postgres`, runs vitest, and always stops the server. Tests call the repo's own `createMigratedDatabase()` (`packages/backend/src/testing/migratedDatabase.ts`), which builds a migrated *template* database once per migration fingerprint (~12 s) and clones it per test (~1 s). Adding a migration changes the fingerprint, so the first run after it rebuilds the template. `LIGHTDASH_LICENSE_KEY` is blanked so only core migrations run (the EE ones need pgvector, which this Postgres lacks) — **so alerting migrations must be core migrations** in `packages/backend/src/database/migrations/`. A lock dir (`tmp/alerting-pg/lock`) serialises runs in one clone.

Your own unit tests: put them next to your code as usual (`*.test.ts`), and run single files (`pnpm -F <pkg> test path/to/file.test.ts`, never with `--`). The frontend vitest suite is red before any change: never run it whole.

Machine notes: `/tmp` is not writable in the sandbox — use the repo's `tmp/`. `psql` is blocked. No Docker, no network to HouseRx, no credentials. Node is v26 (the CLI prints a harmless "optimized for v24" warning).

## Rules for later sessions

- **Never edit the protected folders**: `packages/{backend,frontend,common,cli}/src/__acceptance__/alerting/**`. They define "done". If a test seems wrong, stop and say so in this file; don't work around it.
- Protected files carry `/* eslint-disable */` and `// @ts-nocheck` on purpose (they drive modules that don't exist yet). Package lint, typecheck and format are green with them in place — keep them green with your code.
- Keep the fork rebase-friendly: new code in new files (`packages/*/src/alerting/**`, `packages/frontend/src/features/alerting/**`); edits to upstream files only as registration lines (exports, a type-union member, a route mount, a task registration, a scope entry). **Never touch `packages/backend/src/ee/**`.**
- Migrations: read `packages/backend/src/database/migrations/AGENTS.md` first; create with `pnpm -F backend create-migration <name>`.
- Permissions: follow the `ld-permissions` skill / `packages/common/src/authorization/AGENTS.md` (scopes.ts, role→scope map, ability builders incl. `serviceAccountAbility.ts`, parity test).
- Don't commit generated `packages/backend/src/generated/*`.
- Fixtures are synthetic; secret-shaped values look like `test-secret-not-real`. No PHI anywhere.

## Architecture (chosen by session 1; the tests pin it)

### 1. `@lightdash/common` — pure alerting core (`packages/common/src/alerting/**`, exported from `packages/common/src/index.ts`)

| Export | Contract (see `core/routing/templates/ascode-shadow.accept.ts`) |
|---|---|
| `parsePrometheusDuration(s) → ms` / `formatPrometheusDuration(ms) → s` | `y w d h m s ms` units, combos (`1h30m`); throws on `''`, `5 minutes`, negatives. Formats largest-unit combos, `0s` for 0. |
| `ALERT_REDUCERS`, `reduceAlertSeries(values, reducer)` | `last mean max min sum count`; nulls ignored; empty → `null` (count → 0). |
| `evaluateAlertCondition(value, condition)` | `{operator: '>'|'<'|'>='|'<='|'=='|'!=', threshold}` or `{operator: 'within_range'|'outside_range', min, max}` (exclusive bounds); `null` → false. |
| `splitAlertSeries(rows, {valueColumn='value'})`, `alertLabelsFingerprint(labels)` | Value column `value` (configurable). Columns `time`/`timestamp` order the values and are not labels. A `labels` column (object or JSON string) gives the label map and the `series` column is then ignored; otherwise every other column is a label (stringified). Fingerprint: 16 lowercase hex, label-order independent (no Node crypto — common runs in the browser). |
| `transitionAlertInstance(prev, {conditionMet, at}, {forMs, keepFiringForMs}) → {state, stateSince, ...}` | `normal → pending → firing → resolved → normal`; `for` measured from pending start; `keepFiringFor` from the last time the condition held; `resolved` lasts one evaluation. |
| `buildAlertEvaluatorQueryContext({ruleUuid, projectUuid, description})` | `{sub: 'system:alert-evaluator', sys: true, agent: false, projectUuid, audit: {description, source: 'alert_rule', resource_uuid: ruleUuid}}`; throws on a blank description. Type `AlertRuleQueryContext`. |
| `ALERTING_SCHEDULER_TASKS` | `{ALERTING_TICK: 'alertingTick', ALERT_RULE_EVALUATE: 'alertRuleEvaluate'}`, spread into `SCHEDULER_TASKS` (and so `ALL_TASK_NAMES`). Add payload types to the task payload map. |
| Scopes / CASL | Subjects `AlertRule`, `ContactPoint`, `NotificationRoute`; scopes `view:`/`manage:` for each. Project viewer+ (incl. interactive viewer): view all three. Editor: manage `AlertRule`. Developer, admin: manage all three. Conditions on `{organizationUuid, projectUuid}`. |
| `matchAlertLabelMatchers(labels, matchers)` | `{label, operator: '='|'!='|'=~'|'!~', value}`; regexes anchored (`^(?:v)$`); missing label = `''`; all matchers must hold. |
| `routeAlert(tree, labels) → ResolvedNotificationRoute[]` | Grafana semantics: root matches all; children in order; deepest match wins; a matching node with no matching child is used itself; `continue: true` keeps checking siblings; no child match → root. Children inherit `contactPoint`, `groupBy`, `groupWait`, `groupInterval`, `repeatInterval`. Default timers are **30s / 5m / 4h** (groupWait / groupInterval / repeatInterval). The default `groupBy` isn't pinned by tests; use `['alertname']`. Each result has a unique `id` (route path). |
| `alertGroupKey(route, labels)` | Same key ⇔ same aggregation group: route id + `groupBy` label values; `['...']` = all labels; `[]` = one group per route. |
| `renderAlertTemplate(template, data, {templates?})`, `PORTED_GRAFANA_TEMPLATES` | Go `text/template` subset Grafana uses: fields (`.A.B`, map keys), `range`/`else`/`end`, `if`/`else if`/`else`, `define`/`template`, `len`, `gt lt eq ne ge le`, `index`, parenthesised pipelines, `{{-`/`-}}` trims. Missing map keys render `''`. Unknown template name / parse error → throws naming it. `.Alerts.Firing` / `.Alerts.Resolved` are derived from `Alerts[].Status`. Data shape = Grafana's: `{Receiver, Status, Alerts: [{Status, Labels, Annotations, StartsAt, EndsAt, Fingerprint, GeneratorURL, SilenceURL, DashboardURL, ValueString}], GroupLabels, CommonLabels, CommonAnnotations, ExternalURL}`. `PORTED_GRAFANA_TEMPLATES` holds the 3 infra templates verbatim (`slack.message`, `slack.title`, `__ms_text_alert_fired`, `__ms_text_alert_resolved`, `slack.ms-message`, `test.slack.message`, `test.slack.title`) and is always available. |
| `buildAlertmanagerWebhookPayload({receiver, groupKey, groupLabels, externalURL, alerts})` | Alertmanager webhook v4: `version: '4'`, `status` (firing if any alert firing), `commonLabels`/`commonAnnotations` (intersection), `truncatedAlerts: 0`, firing alerts get `endsAt: '0001-01-01T00:00:00Z'`. |
| `validateAlertingAsCode(doc) → {valid, errors: string[]}` + JSON schemas | `packages/common/src/schemas/json/{alert-rule,contact-point,notification-routes}-as-code-1.0.json` (Ajv 2020 compatible, `strict: false`). Secret fields must be `{secretRef: string}`; errors mention `secretRef`. Unknown `type` → invalid. |
| `compareShadowRun({since, shadow, grafanaHistory, expectedDifferences, toleranceMs = 300000})` | Grafana `/api/v1/rules/history` data frame (`schema.fields` = time, line, labels; `data.values` columns; `line.current` starting with `Alerting` counts, `line.ruleTitle` = rule name). Shadow events `{ruleName, labels, status, at}`, only `firing` counts. Match by rule name within tolerance, one-to-one, events before `since` ignored. Returns `{matched[], missingInLightdash[], extraInLightdash[], unexpectedCount}`; findings `{ruleName, at, labels, expected, reason?}` with `expected` from `expectedDifferences` (`{ruleName, kind: 'missing_in_lightdash'|'extra_in_lightdash', reason}`). |

### 2. Backend (`packages/backend/src/alerting/**`)

Entry `packages/backend/src/alerting/index.ts` exports:

```ts
createAlertingModule(deps: AlertingModuleDeps): AlertingModule
createAlertingRouter(module: AlertingModule): express.Router   // full paths, mount at app root

type AlertingModuleDeps = {
  database: Knex;
  clock: { now(): Date };
  warehouseClients: { getWarehouseClient(args: { projectUuid: string; context: AlertRuleQueryContext }): Promise<Pick<WarehouseClient, 'runQuery'>> };
  secrets: { resolve(name: string): Promise<string | undefined> };
  email: { sendEmail(m: { to: string[]; subject: string; text: string; html?: string }): Promise<void> };
  slackApp: { postMessage(a: { organizationUuid: string; channel: string; text: string; blocks?: unknown[] }): Promise<void> }; // throws if the app isn't installed
  jobQueue: { addJob(taskName: string, payload: object, opts: { jobKey: string; runAt?: Date }): Promise<void> }; // graphile addJob with jobKey
  heartbeat: { url: string; method: 'GET' | 'POST' } | null;
  retry: { maxAttempts: number; initialDelayMs: number };   // exponential backoff
  siteUrl: string;
};
AlertingModule = {
  evaluator: { evaluateRule(ruleUuid, { scheduledAt: Date }): Promise<{ status: 'evaluated' | 'skipped'; reason?: 'paused' | 'overrun' | 'duplicate' | string }> };
  scheduler: { tick(): Promise<{ enqueued: { ruleUuid: string; scheduledAt: string; jobKey: string }[] }> };
  notifier: { flush(): Promise<void> };
  taskHandlers: { alertingTick(payload): Promise<void>; alertRuleEvaluate(payload: { ruleUuid: string; scheduledAt: string }): Promise<void> };
  close?(): Promise<void>;
  // plus whatever services the router uses
};
```

The test harness (`__acceptance__/alerting/support/harness.ts`) is the reference for how deps are faked. Use the injected `clock` for every "now" (never `Date.now()` in alerting logic); real timers only for retry backoff.

**HTTP API** (express router; JSON; success `{status: 'ok', results}`; errors `{status: 'error', error: {name, statusCode, message}}` — the router must translate `LightdashError`s to their status codes **itself**, tests mount it without Lightdash's error handler; parse JSON bodies itself or rely on the app's `express.json()`). Auth from `req.user` (`SessionUser` with `ability`): none → 401; no ability → 403. Base `/api/v2/projects/:projectUuid/alerting`:

| Method, path | Ability | Notes |
|---|---|---|
| `GET /rules?state=&label=k=v&spaceUuid=` | view AlertRule | each rule + `state` (aggregate: firing > error > nodata > pending > normal; never evaluated → normal) |
| `POST /rules` | manage AlertRule | defaults: `interval 1m` (min 30s), `for 0s`, `keepFiringFor 0s`, `timeRange 10m`, `valueColumn value`, `noDataState nodata`, `errorState error`, `paused/shadow/managed false`, `version 1`, `labels {}`, `annotations {}`, `spaceUuid null`; slug from name, unique per project |
| `GET /rules/:ruleUuid` | view | + `state`, `instances[]` (`{fingerprint, labels, annotations, state, value, since, ...}`) |
| `PATCH /rules/:ruleUuid` | manage | partial; bumps `version`; managed → 403 "managed" |
| `DELETE /rules/:ruleUuid` | manage | managed → 403 |
| `GET /rules/:ruleUuid/versions` | view | newest first `{version, rule, createdAt, createdByUserUuid}` |
| `GET /rules/:ruleUuid/history` | view | same entries as `/history?rule=` |
| `GET /rules/:ruleUuid/notifications` | view | send log for the rule |
| `POST /rules/preview` | manage AlertRule | body = rule input; runs the query once; `{error: string|null, series: [{labels, fingerprint, value, conditionMet, state}]}`; saves nothing |
| `GET/POST /contact-points`, `GET/PATCH/DELETE /contact-points/:uuid` | view / manage ContactPoint | integrations below; delete refused (400/409) while the tree uses it; managed → 403 |
| `POST /contact-points/:uuid/test` | manage ContactPoint | synthetic `TestAlert`; `{ok, results: [{type, ok, error?}]}` |
| `GET /notification-routes` → tree or `null`; `PUT /notification-routes` | view / manage NotificationRoute | whole tree; validates contact point slugs, operators, regexes, durations; returns tree + `managed`; managed → 403 |
| `GET /notifications?rule=&contactPoint=` | view AlertRule | newest first `{uuid, ruleUuids[], contactPointUuid, integrationType, status: 'sent'|'failed'|'shadow', alertStatus: 'firing'|'resolved', attempts, error, sentAt}` |
| `GET /state` | view AlertRule | `{instances: [{ruleUuid, ruleName, state, labels, annotations, value, since}]}` — firing and pending only (AI/MCP API) |
| `GET /history?rule=&since=` | view AlertRule | newest first; entries `{type: 'transition', ruleUuid, ruleName, fingerprint, labels, previousState, state, value, at}` or `{type: 'evaluation_skipped', ruleUuid, reason, at}` |
| `POST /shadow-report` | view AlertRule | `{since, grafanaHistory, expectedDifferences}` → `compareShadowRun` over this project's shadow log (event time = when the series started firing); malformed history → 400 |
| `GET /as-code` → `{documents}`; `POST /as-code` `{documents}` | view; manage on each type uploaded | upsert by slug; uploaded resources become `managed`; download emits documents **exactly** as uploaded (round-trip, no added defaults, no secrets) |

Plus `GET /api/v1/alerting/health` (no auth): `{status: 'never_run'|'ok'|'stale', lastCycleAt, lagSeconds}`, stale when lag > 60 s.

**Rule input / document fields** (API is camelCase; YAML identical): `name, description (required, non-blank), spaceUuid (API) | spaceSlug (YAML), labels, annotations {summary, description, runbook_url, ...}, query, valueColumn, reducer, condition, for, keepFiringFor, interval, timeRange, noDataState ('nodata'|'normal'|'alerting'|'keep_last'), errorState ('error'|'alerting'|'keep_last'), paused, shadow`. Documents add `version: 1, type: 'alert_rule'|'contact_point'|'notification_routes', slug`.

**Contact Point integrations**: `slack_webhook {url: {secretRef}, title?, text?, username?, disableResolveMessage?}` (defaults title `{{ template "slack.title" . }}`, text `{{ template "slack.message" . }}`), `slack_app {channel, title?, text?}`, `incident_io {url, token: {secretRef}}` (Alertmanager v4 + `Authorization: Bearer <secret>`), `email {addresses[], subject?, body?}` (via Lightdash's EmailClient), `webhook {url, httpMethod?, authorization?: {secretRef}}` (Alertmanager v4). A missing secret → failed send naming the secret.

**Evaluation semantics** (pinned by `evaluation/scheduling/notifications.accept.ts`):
- Query: substitute `${ld.parameters.__from|__to|__interval}` (ISO UTC; `__interval` per CONTRACTS §2 from `timeRange`/1000, floor 15s), call `warehouseClients.getWarehouseClient({projectUuid, context: buildAlertEvaluatorQueryContext(rule)})` then `runQuery`.
- Instance labels = series labels ∪ rule labels ∪ `{alertname: rule.name}`. Annotations render Grafana's `{{ $labels.x }}`, `{{ $value }}` per instance.
- No rows → `noDataState`: `nodata` → synthetic instance `alertname=DatasourceNoData, rulename=<name>` in state `nodata` (notifies as firing), existing series resolve; `normal` → series resolve; `alerting` → DatasourceNoData `firing`; `keep_last` → nothing changes. Query error → `errorState` similarly with `alertname=DatasourceError` and annotation `error`. Recovery clears them.
- Every transition → `alert_state_history`. Skips are history entries too.
- Scheduling: slot = `floor(now / interval) * interval`; a rule is due once per slot; `tick()` enqueues `alertRuleEvaluate` with `jobKey` containing the rule uuid and slot (`payload.scheduledAt` = slot ISO), then flushes notifications, then records a heartbeat row and calls the heartbeat URL (failure is logged, never thrown). The `alertingTick` task runs `tick()` and re-enqueues itself with `jobKey 'alerting-tick'`, `runAt = now + 15s`.
- Concurrency: one evaluation per rule per slot across workers (row lock / claim row); a second attempt for the same slot → `skipped` (`duplicate`); a newer slot while an older evaluation still runs → `skipped`, reason `overrun`, recorded in history.
- Notifications (Alertmanager dispatcher semantics, driven by `notifier.flush()` and the clock): a new group sends once `now ≥ first firing time + groupWait`; a changed group sends again once `now ≥ last send + groupInterval`; an unchanged firing group re-sends after `repeatInterval`; resolved alerts go out with the next group send (`endsAt` = resolve time) unless `disableResolveMessage`; never duplicate. Retries: 5xx/network retried up to `maxAttempts` with backoff, 4xx not. Every attempt outcome lands in `alert_notifications`.
- Shadow rules: everything as normal, but each would-be send is logged with `status: 'shadow'` and nothing leaves the process.

**Production wiring** (feature `alert-worker-wiring`): construct the module where services are built (e.g. `App`/`SchedulerApp`), adapt `EmailClient`, `SlackClient`, graphile `addJob`, warehouse credentials (`ProjectModel` + `warehouseClientFromCredentials`, passing the query context so the federation client can mint the identity), mount `createAlertingRouter(...)` after session/passport middleware, and pass `alertingModule` in `SchedulerWorker` args so `getFullTaskList()` includes `alertingTick` and `alertRuleEvaluate`; seed the first tick on worker start.

### 3. Frontend (`packages/frontend/src/features/alerting/**`)

- `api.ts`: `getAlertRules(projectUuid, {state?, label?, spaceUuid?})`, `createAlertRule`, `updateAlertRule`, `previewAlertRule`, `getAlertRuleHistory`, `getAlertNotifications(projectUuid, {rule?, contactPoint?})`, `testContactPoint`, `saveNotificationRoutes` (+ the obvious others) over the v2 routes above (use the app's `lightdashApi` with the v2 prefix).
- Presentational components (data in props, actions as callbacks; tests render them inside `<MantineProvider env="test" forceColorScheme="light">` only, so **no react-query, router or context hooks inside them** — containers/pages do the fetching): `components/AlertRulesList` `{rules, spaces, onOpenRule}` (table rows; badges `Firing Pending Normal Resolved No data Error`; `team=infra` label chips; folder name; `Managed in git`; filters: Select `State` with an `All` option, TextInput `Label` (`k=v`), Select `Folder`), `components/AlertRuleDetail` `{rule, history, notifications, onTestRule, onEdit?}` (heading with name, query text, timeline `Normal → Firing`, `Skipped (overrun)`, notifications table rows showing contact point name, status, error; `Test rule` button rendering a row per series `instance=db-1 | 95 | Firing` or the error; no `Edit` button for managed), `components/AlertRuleEditor` `{rule?, spaces, onSubmit}` (labels `Name Description Query Threshold Reducer For Folder` …, `Save`, "Description is required"; managed → `Managed in git`, all fields disabled), `components/ContactPointsList` `{contactPoints, onSendTest, onOpen}` (`Send test notification` per row → "Test notification sent" or the error), `components/ContactPointEditor` `{contactPoint?, onSubmit}` (`Name`, Select `Integration type` → `Slack webhook`, `Webhook URL secret reference`, `Save`), `components/NotificationRoutesEditor` `{tree, contactPoints, onSave}` (`Default route`, matcher text `team = infra`, `Add route` → `Label`, `Value`, Select `Contact point`, `Save`; managed → read-only).
- Pages + routes in `AppRoutes`/`Routes.tsx`: `/projects/:projectUuid/alerting/rules`, `.../rules/new`, `.../rules/:ruleUuid`, `.../contact-points`, `.../notification-routes`.
- Mantine v9 `Select` renders `role=combobox`; the tests pick options by label then `role=option`.

### 4. CLI (`packages/cli`)

- `lightdash download --alerting-only --project <uuid> --path <dir>` → `GET .../alerting/as-code`, writes `<dir>/alert-rules/<slug>.yml`, `<dir>/contact-points/<slug>.yml`, `<dir>/notification-routes/notification-routes.yml`; no chart/dashboard calls.
- `lightdash upload --alerting-only --project <uuid> --path <dir>` reads the same layout, validates locally (`validateAlertingAsCode`; inline secret → non-zero exit naming the file and `secretRef`, nothing sent), then `POST .../alerting/as-code` with contact points, then the tree, then rules.
- `lightdash alerting shadow-report --project <uuid> --since <iso> --grafana-history <json> --expected-differences <yml> [--json] [--fail-on-unexpected]` → `POST .../alerting/shadow-report` with `{since, grafanaHistory, expectedDifferences}`; prints JSON with `--json`, otherwise a human summary naming each rule; `--fail-on-unexpected` exits 1 when `unexpectedCount > 0`.
- The CLI makes `GET /api/v1/health` and `GET /api/v1/projects/<uuid>` first; the mock answers both.

### 5. Docs

`docs/eng-1799/alerting.md` (sections `## Model`, `## Routing semantics`, `## Shadow Run`, `## Cutover`) and `docs/eng-1799/alerting-examples/` (the six Grafana contact points, the tree and ≥3 shadow example rules as uploadable YAML in the CLI layout).

## Contract assumptions (for the integration line)

1. **Evaluator identity seam.** CONTRACTS §4.3 fixes the identity claims but not the Lightdash-side interface. This line passes an `AlertRuleQueryContext` (`@lightdash/common`) to `getWarehouseClient({projectUuid, context})`; the federation line's `FederationWarehouseClient` is expected to mint `sub=system:alert-evaluator, sys=true, audit.source=alert_rule, audit.description=<rule description>, audit.resource_uuid=<rule uuid>` from it. For non-federation projects the context is ignored. `attrs` for the system identity come from config, not from this context.
2. **Alert Rules run in any project** the user can manage, not only the Operations Project; SQL is passed through unchanged apart from the reserved parameters.
3. **Secrets.** `secretRef` names resolve through the injected `secrets.resolve(name)`. Production adapter (assumed): env var `ALERTING_SECRET_<NAME>` with the name upper-snake-cased (e.g. `incident-io-grafana` → `ALERTING_SECRET_INCIDENT_IO_GRAFANA`).
4. **Heartbeat config** (assumed env): `ALERTING_HEARTBEAT_URL`, `ALERTING_HEARTBEAT_METHOD` (`GET`|`POST`, default `POST`).
5. **API style.** The alerting HTTP API is a plain express router (route mount), not TSOA controllers, to stay rebase-friendly and testable without the full app. The MCP line consumes `GET /api/v2/projects/{uuid}/alerting/state` and `/history` with the shapes above.
6. **Grafana `$values.<ref>`** in ported annotations maps to `$value` (one query, one reducer per rule).
7. **Routing bugs (ADR 0003)** — `team=Support`, unlabelled pg_cron `team=engineering`, `slack-sec` — are fixed in the as-code tree during migration and listed as expected differences for the Shadow Run; their target channels are a human decision not made here.

## Feature log

(append: `- <id> — <date> — <one line>`)
- 2026-11-08T16:40:53Z supervisor: initialized: 75 features, run 20261108-093244
