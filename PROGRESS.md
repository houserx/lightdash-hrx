# ENG-1799 line `importers`: Grafana and Perses importers

This line builds the CLI commands that turn today's Grafana content (32 dashboards, about 85 Alert Rules, six Contact
Points and the notification policy) and Perses dashboards into Lightdash content as code. The pure conversion logic
lives in `packages/common` (no network, no Lightdash API, no filesystem). The CLI commands live in `packages/cli`.

Read first: `CONTEXT.md` (glossary: say Tile, Telemetry Source, Alert Rule, Contact Point, Notification Route,
Dashboard Time Range, Shadow Run), `docs/adr/0001-0004`, `docs/eng-1799/CONTRACTS.md`, then the earlier lines' notes
this base integrates: `PROGRESS-ldq.md`, `PROGRESS-alerting.md` and `PROGRESS-viz.md`.

The feature list is `features.json`, kept by the supervisor. Take features strictly in list order. Every feature's
`check` is one acceptance test file.

## How to run

```sh
bash ./init.sh          # pnpm install --frozen-lockfile, then build formula, common, warehouses and
                        # visualization when their sources changed. Warm: about 1.5 s. No servers.

# One acceptance file (never a whole folder; parallelism is capped at 2 inside run.sh):
bash packages/common/src/__acceptance__/importers/run.sh query-prometheus.test.ts
bash packages/cli/src/__acceptance__/importers/run.sh dashboard-command.test.ts

# The CLI from source, as the checks run it (no CLI build needed):
node --import tsx packages/cli/src/index.ts import grafana-dashboard \
    packages/cli/src/__acceptance__/importers/fixtures/grafana_config/rds/pg_cron.json --out tmp/try
```

- The CLI checks spawn `node --import tsx packages/cli/src/index.ts ...`. The CLI loads `@lightdash/common` from
  **`packages/common/dist`**, so **run `bash ./init.sh` after changing common**: it rebuilds common when its sources
  change. The test process itself aliases `@lightdash/common` to `packages/common/src`.
- Checks write only under the repo's `tmp/importers-acceptance/` and remove what they create.
- `init.sh` is this line's own: it runs `scripts/eng-1799/init-importers.sh`. The integration base's runner for every
  line's init (viz, ldq, mcp, alerting, engine; it builds the Rust engine too) moved to `scripts/eng-1799/init-all.sh`.
- Regression check (set by the supervisor later): typecheck `common`, `backend`, `frontend` and `cli`. Run
  `pnpm -F common typecheck` and `pnpm -F cli typecheck` at most once per round, after your edits.

## Protected folders (you cannot edit them)

- `packages/cli/src/__acceptance__/importers/**`: the CLI checks, their helpers (`support.ts`, `alertsupport.ts`,
  `transformsupport.ts`, `roundtripsupport.ts`) and the **fixtures** (`fixtures/FIXTURES.md` says where each came
  from and what was scrubbed).
- `packages/common/src/__acceptance__/importers/**`: the pure query-translation checks and the SQL-folding helpers.
- Never touch any `ee/` directory.

Both folders are excluded from their package's `tsconfig.json` (and the CLI's `tsconfig.build.json`), so the
typecheck and the build ignore them, like the viz line's acceptance folder.

## How the checks read SQL

The checks never compare SQL text. `packages/common/src/__acceptance__/importers/support.ts` does what Lightdash and
the Federation Engine do: it substitutes `${ld.parameters.<name>}` with a quoted string literal (`'value'`, the way
`safeReplaceParameters` substitutes string parameters), folds `'a' || 'b'` into one literal (the engine
constant-folds table-function arguments, PROGRESS-engine "Arguments are constant-folded at plan time"), and then reads
the arguments of each `promql(...)`, `cloudwatch(...)`, ... call. So:

- **Time parameters**: `${ld.parameters.__from}`, `__to`, `__interval` and `__range` (CONTRACTS §2). Values in the
  checks are `2026-01-01T00:00:00Z`, `2026-01-01T06:00:00Z`, `1m` and `6h`.
- **A parameter inside a query string is concatenated**:
  `promql('rate(x[' || ${ld.parameters.__interval} || '])', ${ld.parameters.__from}, ...)`. Inside
  `platform_query('...')` the inner SQL must quote it itself: `... BETWEEN ''' || ${ld.parameters.__from} || ''' AND ...`.
- Reuse `buildTelemetrySql` and the CloudWatch helpers in `packages/common/src/utils/telemetrySql.ts` (ldq) where
  they fit. Their argument order is the contract's.
- A chart is **time-range-aware** when its SQL contains both `${ld.parameters.__from}` and `${ld.parameters.__to}`.

## Architecture (chosen here; the checks pin the parts marked **pinned**)

### `packages/common/src/eng1799/` (pure, exported from the package index with one line each)

| File | What |
|---|---|
| `grafanaQuery.ts` (**pinned path and exports**) | `translateGrafanaTarget(target, ctx)` and `translateGrafanaPanelQueries(panel, ctx)`, both returning `{ sql: string \| null, todo: string \| null, warnings: ImportWarning[] }`. |
| suggested: `importWarnings.ts` | `ImportWarning = { code, message, dashboard?, panel?, rule?, path? }` and the code catalogue below. |
| suggested: `grafanaVariables.ts`, `grafanaTransformations.ts`, `grafanaDashboardImport.ts` | variables to parameters; transformations to SQL or chart config; `convertGrafanaDashboard(json, options)` returning the dashboard doc, chart docs, warnings and the report. |
| suggested: `terraformHcl.ts` | an HCL subset parser and evaluator (see "Terraform" below). |
| suggested: `grafanaAlertImport.ts`, `grafanaRoutingFixes.ts` | rules, Contact Points and the tree; defect detection and fixes. |
| suggested: `persesDashboardImport.ts` | Perses through the same panel mapping and query translation. |

`ctx` for the query functions (**pinned**):

```ts
{
  datasources?: Array<{ uid: string; name: string; type: string }>; // from grafana_data_sources.tf
  variables?: GrafanaTemplatingVariable[];                           // dashboard templating.list
  opsMarts?: { github?: Record<queryType, table>; sentry?: Record<queryType, table> };
}
```

- **Telemetry Source name** = the Grafana datasource name lower-cased with runs of non-alphanumerics turned into
  `-` (`Prometheus-Production` → `prometheus-production`, `Cloudwatch Staging` → `cloudwatch-staging`). It is the last
  argument of the table function. With no resolvable datasource, leave the source argument out (engine default) and
  warn `datasource-unresolved`. The datasource comes from the target, else the panel, else a lookup by uid or by the
  legacy name string, else a datasource variable's `current` (text, or value looked up by uid).
- A panel's visible targets are combined with `UNION ALL`. Hidden targets are only inputs to expressions.
- Prometheus range → `promql`, `instant: true` → `promql_instant(q, __to)`. Loki: log selector → `logql` (limit from
  `maxLines`, else 1000, direction `backward`); metric query → `logql_metric`. CloudWatch Metrics → `cloudwatch` with a
  MetricStat (`Id` lower-case first letter, `Period` in seconds, `Stat`, `Label`), code-mode `expression` or
  `sqlExpression` (metricQueryType 1) → `Expression`. CloudWatch Logs → `cloudwatch_logs(groups, query, ...)`.
  Postgres → `platform_query` with macros rewritten. GitHub and Sentry → `SELECT ... FROM <mapped mart>`, else a TODO
  with `no-ops-mart`.
- `legendFormat` other than `__auto` or empty becomes the `series` column, built with `label(labels, '<key>')`.

### `packages/cli/src/handlers/` and registration

Add `importGrafanaDashboard.ts`, `importGrafanaAlerts.ts` and `importPersesDashboard.ts`, and register them under the
existing `lightdash import` command in `packages/cli/src/index.ts` (next to `portal-scripts`, around line 1430). These
commands need no Lightdash login or project. They read files, call common, and write YAML (js-yaml, stable key order,
no timestamps, so two runs are byte-identical).

**Options (pinned by the checks):**

| Command | Options |
|---|---|
| `import grafana-dashboard <file.json...>` | `--out <dir>` (required), `--space <slug>` (default `operations`), `--dashboards-tf <grafana_dashboards.tf>` (space from the Grafana folder, slug via `generateSlug(folder title)`), `--datasources <grafana_data_sources.tf>`, `--ops-marts <file.yml>` (`github:`/`sentry:` maps from query type to table), `--no-tabs` |
| `import grafana-alerts` | `--rules <tf...>`, `--contact-points <tf>`, `--policy <tf>`, `--out <dir>`, `--locals <tf...>`, `--folders <grafana_folders.tf>`, `--datasources <tf>`, `--routing-decisions <file.yml>`, `--no-routing-fixes` |
| `import perses-dashboard <file.json\|yaml...>` | `--out <dir>`, plus `--space` like above |

Input files may be a Grafana dashboard JSON or the API export `{dashboard, meta}`. Bad input (unparseable, not a
dashboard, missing) exits non-zero with the file name in the message. On success the command prints counts such as
`1 dashboard`, `2 charts`, `85 alert rules`, `6 contact points`.

**Output layout (pinned):**

```
grafana-dashboard / perses-dashboard:      grafana-alerts:
  dashboards/<dashboard slug>.yml            alert-rules/<slug>.yml
  charts/<chart slug>.yml                    contact-points/<slug>.yml
  reports/<dashboard slug>/IMPORT-REPORT.md  notification-routes/notification-routes.yml
  lightdash.config.yml (only if parameters)  ROUTING-FIXES.md
  import-summary.json                        IMPORT-REPORT.md
                                             import-summary.json
```

`import-summary.json` = `{ command, warnings: { total, byCode: { <code>: n } }, todos, files: [relative paths] }`.

### Dashboards

- **SQL charts, not saved charts.** Each chart panel becomes a `contentType: sql_chart` file (`version: 1`, `name` =
  panel title or a readable fallback, `description`, `slug` unique across the run, `sql`, `spaceSlug`, `limit`,
  `chartKind` = `config.type`, and `config.metadata.version: 1`, which `VizBaseConfig` requires). Its tile is
  `type: sql_chart` with `properties: { chartName, chartSlug, title }` and a `tileSlug`.
- **Chart kinds** (from `getGrafanaPanelMapping`): timeseries/graph → `line` (bars → `vertical_bar`), barchart →
  `vertical_bar`, piechart → `pie`, table/table-old → `table` (table config needs `columns`), stat/gauge →
  `big_number`, logs → `table`, bargauge → any kind. Where the mapping wanted a chart type SQL charts can't be
  (gauge, `stat-sparkline`, `bar-gauge`, `log_stream`), add `chart-kind-fallback` naming that type. Dropped types
  (alertlist, dashlist, news) give `panel-dropped` with the mapping's reason. Options the mapping marks dropped give
  `option-dropped` with the option path. `timeFrom`/`timeShift` are warned.
- **Layout**: `x = round(gx * 36/24)`, `w = max(1, round(gw * 36/24))`. y and h use one linear scale, so a row starts
  where the one above ends. No overlaps. Expanded rows → full-width `heading` tiles (`properties.text`). Collapsed
  rows → tabs (first tab for the rest, `order` 0..n, every tile gets `tabSlug`). With `--no-tabs` → headings. Text →
  `markdown` tiles (code mode as a fenced block with its language).
- **Links**: panel and field links are appended to the chart `description` as `[title](url)`. Dashboard links go
  into the dashboard `description`.
- **Dashboard Time Range**: `timeRange: { from, to, refreshInterval, tileTimeDimensions: {} }`. The refresh is one of
  10s, 30s, 1m, 5m, 15m, 30m, 1h or null. Anything else moves to the nearest value with `refresh-adjusted`.
- **Variables** → `lightdash.config.yml` `parameters.<var name>` (custom and interval: `options`; query and textbox:
  `allow_custom_values: true`; label from the variable label), plus dashboard
  `parameters.<name> = { parameterName, value }`. Constants are inlined, datasource variables pick the source,
  multi-value and All give `variable-multi-value`.
- **Thresholds and units**: stat steps → big number `display.conditionalFormatting` (`greaterThanOrEqual`, hex
  colours via `resolveGrafanaColor`; the base step is skipped). `percentunit` → `percent` format on the cartesian
  display. Units with no SQL chart format, threshold lines, and value mappings on tables are warnings naming the
  option.
- **Legend/stacking**: `display.legend.position`, stack normal → `true`/`stack`, percent → `stack100`.
- **Annotations**: one `annotations-unsupported` per enabled non-built-in annotation.
- **TODO tiles**: when nothing translates, a markdown tile at the panel's position, titled after the panel, whose
  content says TODO and why.
- **IMPORT-REPORT.md**: one line per warning (a markdown table row) holding the code, the panel or rule name and the
  message, so the checks can grep the line for a panel. A dashboard without warnings says "No warnings".

### Alerts

- **Terraform**: parse the HCL subset the infra files use. That is blocks, attributes, `#` and `//` comments,
  heredocs (`<<-EOT` strips indentation), strings with `${...}` interpolation, lists, objects (`=` and `:`),
  `locals`, `for_each = toset(...)` or a map with `each.key` and `each.value`, `dynamic "rule"` with
  `for_each = [for x in ... : ... if ...]` and `content`, `jsonencode`, `jsondecode` (unresolvable: keep symbolic),
  `merge`, `tolist`, `toset`, `sensitive`, conditionals, arithmetic, indexing, and references to
  `grafana_data_source.<name>.uid` / `data.grafana_data_source.<x>.uid` (resolved by name via `--datasources`), to
  `grafana_folder.this["X"].uid` (folder title `X`) and to `grafana_contact_point.<r>.name`. Unknown references stay
  symbolic and give a warning. They never crash.
- **Rule** → `alert_rule`: `slug` = `generateSlug(name)`, made unique across the run. `spaceSlug` =
  `generateSlug(folder title)`. `for`, `interval` (`interval_seconds`) and `timeRange` (the query's
  `relative_time_range.from`) are Prometheus durations (`2m`, `15m`). No data: NoData→`nodata`, OK→`normal`,
  Alerting→`alerting`, KeepLast→`keep_last`. Error: Error→`error`, Alerting→`alerting`, KeepLast→`keep_last`, OK→the
  closest, with a warning. Also `paused`, `labels`, `annotations`, and **`shadow: true` always**. Reduce and
  threshold or classic conditions become `reducer` (last, mean, max, min, sum, count) and `condition` (`>`/`<` or
  `within_range`/`outside_range` with min and max). Math becomes SQL. Anything else: emit the rule `paused: true` with
  `rule-needs-review`.
- **Description** = the `summary` annotation. If it is missing or blank, generate one from the title and the query,
  with `rule-description-generated`.
- **Contact Points**: Slack → `slack_webhook` with `url: { secretRef: <slug>-webhook }`, plus title, text and
  `disableResolveMessage`. A webhook to `api.incident.io` → `incident_io` with the URL and `token: { secretRef }`.
  Never write a secret value, a `local.*` reference or `secret_string`.
- **Tree**: root = the policy's contact point, `group_by`, timers. Children in order with matchers
  (`label`/`operator`/`value`), `continue`, timers and nested policies.
- **notification_settings** (Grafana simplified routing): set the label `notify: <contact point slug>` on the rule,
  and put a route `notify = <slug>` (no continue) ahead of the policies, so the rule reaches only that Contact Point.
  Always applied, even with `--no-routing-fixes`.

### Routing fixes (Q21 B; pinned by the `routing-*` checks)

Detect with `routeAlert` (common) over the imported rules' labels plus `alertname`. Write `ROUTING-FIXES.md` with
one section per class, naming matchers as `label = value`, Contact Points by slug, and the affected rules by name.
Apply the fixes unless `--no-routing-fixes`:

1. **Unreachable route**: a route whose matchers a rule satisfies, but an earlier sibling without `continue` takes
   the rule first. Fix: if the hidden route is strictly more specific, move it ahead of the sibling; otherwise set
   `continue: true` on the sibling.
2. **Unhandled severity**: a `severity` value on some rule that no route matches. With `--routing-decisions`
   `severities: { "<value>": <contact point slug> }`, add a `severity = <value>` route with `continue: true` at the
   top. Otherwise list it as needing a decision, with `routing-needs-decision`.
3. **Unreached contact point**: no route and no rule reaches it. Fix: add a `notify = <slug>` route.
4. **Default route only**: a rule that reaches only the root. If its `team` matches a route's `team = X` matcher but
   it lacks that route's other equality matchers, add those labels to the rule (pg_cron gets `channel = #alerts`).
   If no route has its team, `teams: { <team>: <slug> }` in `--routing-decisions` adds a team route. Otherwise list
   it with `routing-needs-decision`. Either way ROUTING-FIXES.md names the proposed route (`team = Support`).

Today's fixtures must show ADR 0003's bugs: pg_cron's `team=engineering`, `team=Support`, `slack-sec`, and no route
on severity at all.

### Perses

Panels keyed by id, `Grid` layouts with `$ref: '#/spec/panels/<id>'`. TimeSeriesChart → line, BarChart →
vertical_bar, StatChart and GaugeChart → big_number (with `chart-kind-fallback`), Table → table, Markdown → markdown
tile. Any other plugin → TODO tile plus `perses-plugin-unsupported`. `PrometheusTimeSeriesQuery` → promql (datasource
`name` is the Telemetry Source). `ListVariable` (static values → options; label values → custom values) and
`TextVariable` → parameters. `duration` → `now-<duration>`, `refreshInterval` → refresh. A collapsed grid → tab, a
titled open grid → heading.

### Warning catalogue (codes the checks pin)

`datasource-unsupported`, `datasource-unresolved`, `no-ops-mart`, `expression-unsupported`, `variable-multi-value`,
`transformation-unsupported`, `panel-dropped`, `option-dropped`, `chart-kind-fallback`, `annotations-unsupported`,
`refresh-adjusted`, `rule-description-generated`, `rule-needs-review`, `routing-needs-decision`,
`perses-plugin-unsupported`. Add more as needed: lower-case and dashed. `docs/eng-1799/importers.md` must list
every code that appears in `docs/eng-1799/importers-warning-counts.json`.

**Warning snapshot**: `docs/eng-1799/importers-warning-counts.json` is written by the build session (not
generated by the test) as
`{"grafana-dashboard": {total, todos, byCode}, "grafana-alerts": {...}, "perses-dashboard": {...}}`, using the
options in `roundtripsupport.ts`. Update it whenever a change moves the counts on purpose.

## Contract assumptions

1. **SQL charts instead of saved charts.** The goal asks for SQL-chart-as-code. SQL chart configs support only line,
   vertical_bar, pie, table and big_number (`AllVizChartConfig`), but the panel mapping targets saved-chart types
   (gauge, `log_stream`, registry entries). We use the closest SQL chart kind and warn `chart-kind-fallback`. An
   integration line could add native SQL chart configs later.
2. **CloudWatch metric math** needs several MetricDataQueries, but CONTRACTS §1.1 passes one. The check accepts
   either a JSON list in one `cloudwatch()` call (inputs with `ReturnData: false`) or one call per input with the math
   in SQL. The second stays within the contract.
3. **Parameters inside query strings** depend on the engine constant-folding `||` in table-function arguments. The
   engine notes say it does.
4. **Telemetry Source names** are derived from Grafana datasource names. They match the CONTRACTS §1.4 examples
   (`prometheus-production`, `loki-production`, `cloudwatch-production`). No other mapping exists.
5. **Ops Marts**: no GitHub or Sentry mart list exists in this clone (the dbt line's runbook mapping is not here), so
   the mapping is an input (`--ops-marts`). Without it the panels are TODO tiles.
6. **Dashboard links** have no tile, so they go into the dashboard description. Panel links go into the chart
   description shown on the tile.
7. **`notify` label** for simplified routing and for reaching otherwise unreached Contact Points. This is a
   convention of this line.
8. **Variables become project parameters** in `lightdash.config.yml`, named after the Grafana variable. If two
   dashboards disagree on one name, the importer must resolve it deterministically and warn.
9. `$__rate_interval` maps to `__interval`, since no reserved rate interval exists.
10. `perses-dashboard` takes `--out` like the Grafana command. The goal's signature shows none.
11. `platform_query` tiles are Audited Queries (CONTRACTS §1.2) that need an `audit.description` at run time. This
    line only writes the SQL. Supplying the audit description for tile runs is the ldq line's job.
12. Root `init.sh` is this line's own (the goal fixes its contents). The previous all-lines runner is
    `scripts/eng-1799/init-all.sh`.

## Fixture facts (from the infra snapshot, counts only)

- Panel types: 143 timeseries, 123 stat, 44 row (4 collapsed), 13 graph, 12 logs, 9 gauge, 7 text, 6 table,
  4 piechart, 2 bargauge, and 1 each of table-old, barchart, alertlist, dashlist, news, plus one panel with no type.
- Targets: 262 CloudWatch (15 Logs Insights, 5 Metrics Insights builder, 2 code-mode SQL), 107 Prometheus, 32 via a
  `$datasource` variable, 22 `__expr__` (14 math, 8 reduce), 15 GitHub (Pull_Requests, Workflow_Usage, Contributors),
  8 Loki, 3 Postgres, 2 Sentry (statsV2).
- Variables: 27 query, 22 datasource, 8 custom, 3 constant, 2 interval, 1 textbox. Transformations: renameByRegex 18,
  filterFieldsByName 13, filterByValue 6, organize 4, calculateField 4, configFromData 3, reduce 2,
  convertFieldType 1, merge 1. There are 2 non-built-in annotations, 1 dashboard link and 20 panels with links.
- Rules: 85 once expanded (see `alerts-full-ruleset.test.ts`). 9 use `notification_settings`. pg_cron's
  `folder_uid` is a literal uid with no folder resource.

## Conventions

- New code goes in new files. Upstream edits stay to registration lines (the `import` subcommands, the common index
  exports).
- Conversion is pure and deterministic: sort what Grafana leaves unordered, and never write timestamps or random ids.
- Every unsupported construct is a structured warning in the report and the summary, never a silent drop.
- Never print or copy PHI or secrets. Fixtures are scrubbed; keep any new fixture synthetic.
- One acceptance file at a time, and typecheck once per round.

## Progress log

- 2026-11-08 init session: read the repo and the goal; copied and scrubbed the fixtures; wrote 61 features and their
  acceptance tests (13 common, 48 CLI); wrote `init.sh` (runs `scripts/eng-1799/init-importers.sh`); excluded the
  two acceptance folders from the cli/common tsconfigs. `bash ./init.sh` exits 0. All 61 checks fail on this tree
  for the expected reasons (unknown CLI commands, missing `grafanaQuery.ts`, missing docs).

## Integration base notes (kept from the base's PROGRESS.md)

The build lines ran in parallel, each with its own progress notes. They are kept per line:
`PROGRESS-engine.md`, `PROGRESS-mcp.md`, `PROGRESS-ldq.md`, `PROGRESS-viz.md`, `PROGRESS-alerting.md`.
Each one has a "Contract assumptions" section that the integration line reconciles.

- `formatPrometheusDuration` is exported by both `packages/common/src/utils/timeRange.ts` (ldq) and
  `packages/common/src/alerting/durations.ts` (alerting). They differ for durations of a week or more
  (`7d` vs `1w`). The package root re-exports ldq's to resolve the clash.
- Alerting's `alerting/queryParameters.ts` builds the CONTRACTS §2 reserved time parameters (`__interval`,
  `__range`, ...) separately from ldq's `utils/timeRange.ts`. The two should agree on every value the engine sees.
- 2026-11-09T01:14:28Z supervisor: initialized: 61 features, run 20261108-192705
- 2026-11-09T01:46:23Z supervisor: initialized: 61 features, run 20261108-203649

### imp-query-prometheus (2026-11-08)

- Added `packages/common/src/eng1799/grafanaQuery.ts` (pinned path) and `eng1799/importWarnings.ts`
  (`ImportWarning`, `ImportWarningCode`); both exported from the common index with one line each.
- `translateGrafanaTarget(target, ctx)`: resolves the datasource (target, else `ctx.panelDatasource`; object by uid,
  type from the ref or the lookup; legacy string by name then uid), Telemetry Source = `telemetrySourceName(name)`.
  Prometheus range → `buildTelemetrySql({kind:'promql'})` (ldq); `instant: true` without `range: true` →
  `promql_instant(q, ${ld.parameters.__to}[, source])` (CONTRACTS §1.1 `promql_instant(query, at[, source])`, built
  locally since `buildTelemetrySql` has no instant kind). Both range and instant → range plus `query-instant-dropped`.
  Empty expr → `sql: null`, TODO, `query-empty`. Unknown uid with a known type → no source arg plus
  `datasource-unresolved`; no type at all → TODO plus `datasource-unresolved`; any non-Prometheus type is for now a
  TODO plus `datasource-unsupported` (the Loki/CloudWatch/Postgres/... features replace that `default` branch).
- `translateGrafanaPanelQueries(panel, ctx)`: placeholder for imp-query-panel-targets. Skips hidden targets, passes
  `panel.datasource` down, keeps the first translated target and warns `panel-targets-not-combined` for each further
  one (no silent drop). The next feature should replace this with UNION ALL and drop that code.
- Not done here (later features): `$datasource` variables, `$__rate_interval`/time macros, legendFormat.
- Tested: `query-prometheus.test.ts` 5/5; called the built `dist/cjs` exports from node and saw the expected
  promql/promql_instant SQL, the empty-expr TODO and the staging source from the panel datasource. Typecheck (common)
  clean; oxlint clean; oxfmt applied.
- 2026-11-09T01:48:55Z supervisor: imp-query-prometheus passed the gate in round 1

### imp-query-loki (2026-11-08)

- `grafanaQuery.ts`: new `case 'loki'` → `translateLokiTarget`. A log query (expr starts with a `{` stream selector,
  exported as `isLogqlLogQuery`) → `buildTelemetrySql({kind:'logql'})` with limit = target `maxLines` (default 1000,
  invalid → `query-limit-invalid`) and direction = target `direction` (default 'backward'; anything else, e.g.
  Grafana's `scan` → `query-direction-unsupported`). Everything else is a metric query →
  `logql_metric(q, __from, __to, __interval[, source])`.
- Instant metric (`queryType: 'instant'` or `instant: true`): CONTRACTS §1.1 has no instant LogQL function, so it is
  `logql_metric(q, __to, __to, __interval[, source])` (one value at `__to`), built locally. Instant on a log query
  is ignored (Loki has no instant log query). Empty expr → TODO + `query-empty`.
- Added the warning codes `query-instant-dropped` (already used by Prometheus), `query-limit-invalid`,
  `query-direction-unsupported` to `ImportWarningCode`.
- Not done here: `$__auto`/`$__interval`/variables inside the LogQL expr (macro features), legendFormat.
- Tested: `query-loki.test.ts` 5/5, `query-prometheus.test.ts` still 5/5; built common and called
  `translateGrafanaTarget` from node with a pipeline log query, maxLines/forward, count_over_time, rate, topk,
  an instant metric query, an empty expr and maxLines -3; saw the expected SQL and warnings. tsc clean, oxlint
  clean, oxfmt applied.
- 2026-11-09T01:50:54Z supervisor: imp-query-loki passed the gate in round 1

### imp-query-cloudwatch-metric-stat (2026-11-08)

- `grafanaQuery.ts`: new `case 'cloudwatch'` → `translateCloudWatchTarget`. A Metrics-mode target with
  `metricQueryType` 0 (or unset) and an empty `expression` becomes
  `buildTelemetrySql({kind:'cloudwatch'})` (ldq) with a MetricStat MetricDataQuery: Namespace, MetricName,
  Dimensions (target order), Period (seconds), Stat, `ReturnData: true`, `Label` from `label` else `alias`.
- `Id`: target `id` if it matches `^[a-z][a-zA-Z0-9_]*$`, else refId with non-word chars → `_` and the first
  letter lower-cased (`A` → `a`), else `m1`.
- Period: number or digit string = seconds; durations via ldq `parseTimeRangeDuration` (`5m` → 300); empty/`auto`
  → 300 + `query-period-auto`; anything else (incl. `$var`) → 300 + `query-period-invalid`.
- Warnings (new codes in `importWarnings.ts`): `query-region-unsupported` (region other than `default`; the
  MetricDataQuery has no region, the source's region applies), `query-statistics-dropped` (legacy `statistics`
  list; first kept), `query-statistic-missing` (→ Average), `query-dimension-wildcard` (`*` or empty value: the
  dimension is left out of the MetricStat), `query-dimension-values-dropped` (array of values; first kept),
  `query-match-exact-dropped` (`matchExact: false`).
- Placeholders for later features: Logs mode, metric math/code expressions and Metrics Insights
  (`metricQueryType` 1) are a TODO + `query-cloudwatch-unsupported`. imp-query-cloudwatch-expressions and
  imp-query-cloudwatch-logs should replace that branch (the expressions test wants top-level `Period` on an
  Expression query). Missing namespace/metric → TODO + `query-empty`.
- Tested: `query-cloudwatch-metrics.test.ts` 5/5, prometheus and loki still 5/5; rebuilt common via init.sh and
  called the built `dist/cjs` `translateGrafanaTarget` from node with the ALB two-dimension target, periods
  60/5m/1h/86400/3600(number)/''/bogus, the us-west-2 + statistics + wildcard target (4 warnings), a Logs target
  and an empty namespace. tsc clean, oxlint clean, oxfmt applied.
- 2026-11-09T01:53:28Z supervisor: imp-query-cloudwatch-metric-stat passed the gate in round 1

### imp-query-panel-targets (2026-11-08)

- `grafanaQuery.ts` `translateGrafanaPanelQueries`: the visible targets that translate become one result set,
  `(SELECT ...)\nUNION ALL\n(SELECT ...)` (one target stays a bare SELECT). Hidden targets are skipped; targets
  that don't translate are left out with their warnings (panel `todo` stays null); when none translates the
  panel is a TODO joining the targets' TODOs. No visible target → TODO + `query-empty` (unchanged).
- Result shapes (CONTRACTS §1.1): translators now return an internal `shape` (`series` for promql,
  promql_instant, logql_metric, cloudwatch; `log-lines` for logql). Only targets with the first translated
  target's shape are unioned; others get `panel-targets-not-combined` (code kept, new meaning: different
  columns). A translator without a `shape` (future platform_query, cloudwatch_logs) never unions with
  anything — later features that add translators must set `shape` (add `'logs-insights'` etc. to
  `ResultShape`) if they want panel combining. `translateGrafanaTarget` strips `shape` from its public result.
- Dispatch is now a `TARGET_TRANSLATORS` Map (type → translator); later datasource features add an entry.
  An unsupported type is checked before source resolution, so it gets only `datasource-unsupported` (no
  misleading "engine's default source is used" `datasource-unresolved`).
- Not done here: series names can collide across unioned targets with no legendFormat (e.g. two `sum(...)`
  both `{}`); imp-query-legend-format should consider defaulting the series to the refId/expr when unioning.
- Tested: `query-panel-targets.test.ts` 3/3; prometheus, loki, cloudwatch-metrics still 5/5. Rebuilt common via
  init.sh and called the built `dist/cjs` `translateGrafanaPanelQueries` from node: two visible + one hidden
  Prometheus → two promql SELECTs joined by UNION ALL, no `c`; Prometheus + elasticsearch → the promql query
  plus `datasource-unsupported`; only influxdb → sql null, TODO naming influxdb; Prometheus + Loki log +
  CloudWatch → promql UNION ALL cloudwatch plus `panel-targets-not-combined` for the log target; all hidden →
  TODO. tsc clean, oxlint clean, oxfmt applied.
- 2026-11-09T01:56:28Z supervisor: imp-query-panel-targets passed the gate in round 1

### imp-query-datasources (2026-11-08)

- The resolution itself (`resolveDatasource`/`isUsableRef`/`translateTarget` in `grafanaQuery.ts`) was already
  built by imp-query-prometheus and imp-query-panel-targets; `query-datasources.test.ts` was 6/6 on arrival.
  Order: the target's ref if usable, else the panel's. Mixed (`-- Mixed --`, type `datasource`) is not usable.
  An object ref is looked up by uid; a string ref by name, then uid. Type comes from the ref, else the list.
  Outcomes: no type → TODO + `datasource-unresolved`; type with no translator → TODO + `datasource-unsupported`;
  translator but not in the list → the engine default source (no last argument) + `datasource-unresolved`.
- Changed here (two small gaps): the legacy string `'-- Mixed --'` now falls through to the panel the way the object
  form does (before, it was a name lookup that failed and gave a TODO). An object ref whose `uid` holds the datasource
  name (seen in dashboards migrated from the name string) now resolves by name when no uid matches.
- Not here: datasource variables (`${datasource}`, `$DS_X`) belong to imp-query-variables. For now they give
  the default source + `datasource-unresolved` when the ref has a type, and a TODO when it has none.
- Tested: rebuilt common via init.sh. Called the built `dist/cjs` translators from node: a panel inheriting
  Prometheus-Staging (an absent and a null target datasource) → both `'prometheus-staging'`; unknown uid → 4-arg
  promql + `datasource-unresolved`; elasticsearch → TODO + `datasource-unsupported`; a mixed panel with
  Prometheus, Loki and CloudWatch → all three unioned; legacy name, uid-only, name-in-uid and legacy-mixed-string
  cases. Acceptance: datasources 6/6; prometheus, loki and cloudwatch-metrics 5/5; panel-targets 3/3. tsc clean,
  oxlint clean (run from packages/common with `-c .oxlintrc.json`), oxfmt applied. `npx` fails here with
  EBADDEVENGINES (node 26 vs 24), so call `node_modules/.bin/*` directly.
- 2026-11-09T01:58:29Z supervisor: imp-query-datasources passed the gate in round 1

### imp-query-time-macros (2026-11-08)

- `queryExpressionSql` in `grafanaQuery.ts` turns a PromQL/LogQL expression into a SQL string expression:
  `$__interval`, `${__interval}`, `[[__interval]]` and `$__rate_interval` → `${ld.parameters.__interval}`;
  `$__range` → `${ld.parameters.__range}`, concatenated with `||` into the literal
  (`'rate(x[' || ${ld.parameters.__interval} || '])'`). That works because Lightdash substitutes string
  parameters as quoted literals (backend `QueryBuilder/parameters`), so the engine gets `'rate(x[' || '1m' || '])'`.
  A query without macros is still one plain literal, as before.
- Any other `__` macro (`$__range_s`, `$__interval_ms`, `$__from`, `$__to`, a format option like
  `${__interval:text}`) stays in the query text as written and gets the new warning code
  `query-macro-unsupported` naming each one. The SQL is kept (not a TODO); the query will fail at run time
  until edited. Decision: the spec says "warnings", so no TODO.
- The promql/promql_instant/logql/logql_metric SQL is now built by a local `tableFunctionSql` in
  `grafanaQuery.ts` (buildTelemetrySql always quotes the query as one literal). CloudWatch still uses
  buildTelemetrySql. Later translators taking a free-text query (cloudwatch_logs, traceql) can reuse
  `queryExpressionSql` the same way.
- Trap: `$__rate_interval` maps to `__interval` (Grafana widens it to ≥ 4× scrape interval). With the 15s
  floor of `__interval`, `rate(x[15s])` on a 15s scrape can be empty on short ranges. Not decided here.
- User variables (`$job`, `$__all`, `$__auto_interval_*`) are imp-query-variables. `$__auto_interval_x` is
  currently caught by the `__` pattern and warned as unsupported; imp-query-variables should resolve
  interval variables before (or instead of) this step.
- Tested: rebuilt common via init.sh, called the built `dist/cjs` `translateGrafanaTarget` from node:
  rate(x[$__interval]), rate(x[${__interval}]) and rate(x[$__rate_interval]) → `${ld.parameters.__interval}`,
  folding to `rate(x[1m])` with __interval=1m; increase(x[$__range]) (range and instant) →
  `${ld.parameters.__range}`; `$__range_s`/`$__interval_ms` → warning naming both; a Loki log query with a
  macro also maps. Acceptance: time-macros 5/5; prometheus 5/5, loki 5/5, cloudwatch-metrics 5/5,
  panel-targets 3/3, datasources 6/6. tsc clean, oxlint clean, oxfmt applied.
- 2026-11-09T02:01:44Z supervisor: imp-query-time-macros passed the gate in round 1

### imp-query-variables (2026-11-08)

- `queryExpressionSql` in `grafanaQuery.ts` now resolves every reference matching `$name`, `${name}`,
  `${name:fmt}`, `[[name]]` or `[[name:fmt]]` (names start with a letter or `_`, so PromQL's `$1` in label_replace
  is left alone), using `ctx.variables` (the dashboard's `templating.list`):
  - `__` names: the time macros as before; `$__auto_interval_<var>` (an interval variable's auto option) now maps to
    `${ld.parameters.__interval}` instead of the `query-macro-unsupported` warning.
  - custom, query, textbox, interval → the parameter of the same name, `${ld.parameters.<var>}`, concatenated into
    the literal like the time macros. Multi-value / Include All / array current / `$__all` → `variable-multi-value`
    warning. A `:format` on a user variable → `variable-format-ignored` (the plain value is used).
  - constant → inlined (its `query`, else its current value).
  - undefined → kept as written + `variable-undefined` naming it. Other types (datasource or adhoc used inside query
    text) → kept + `variable-unsupported`.
- Datasource variables: `resolveDatasourceVariable` runs before `resolveDatasource` in `translateTarget`. A ref
  (target or panel; object `uid` or legacy string) that is exactly one variable of type `datasource` becomes the
  datasource it picks: its current value (uid or name), else its current text, else the only datasource of the
  variable's `query` type. Not found or not a datasource variable (e.g. `${DS_PROMETHEUS}` export inputs) → unchanged,
  so the existing `datasource-unresolved` path applies. A multi-value datasource variable warns `variable-multi-value`.
- CloudWatch now builds its SQL with the local `tableFunctionSql` and runs the MetricDataQuery JSON through
  `queryExpressionSql`, so `$env` in a dimension value or label becomes a parameter and constants are inlined
  (JSON-escaped). CloudWatch dynamic labels (`${LABEL}`, `${MAX}`…) are in `CLOUDWATCH_DYNAMIC_LABELS` and kept
  without a warning. Output without variables is identical to the old buildTelemetrySql output.
- Translators take `(target, source, variables, warnings)` now. New warning codes are added to `ImportWarningCode`.
- For imp-dashboard-variables: an interval variable's parameter can hold `$__auto_interval_<var>` as a value in
  Grafana; the dashboard-level feature should drop the auto option from the parameter's options/default. A parameter
  value is substituted raw inside the PromQL/JSON string, so a value with `"` breaks the query (as in Grafana).
- Tested: rebuilt common via init.sh, called the built `dist/cjs` `translateGrafanaTarget` from node: `$env`,
  `[[env]]` → `${ld.parameters.env}`; constant cluster inlined as `prod-eks`; multi/All `$pod` → parameter +
  `variable-multi-value`; `$agg` → parameter, `$__auto_interval_agg` → `__interval`, `$1` untouched; CloudWatch with
  `uid: '${datasource}'` and legacy `'$datasource'` → `'cloudwatch-staging'`, dimension `$env` parameterised, `${LABEL}`
  kept silently; `$nope` → `variable-undefined`. Acceptance: query-variables 6/6; time-macros 5/5, prometheus 5/5,
  loki 5/5, cloudwatch-metrics 5/5, panel-targets 3/3, datasources 6/6. tsc clean, oxlint clean, oxfmt applied.
- 2026-11-09T02:06:03Z supervisor: imp-query-variables passed the gate in round 1

### imp-query-legend-format (2026-11-08)

- `grafanaQuery.ts`: a Prometheus target (range or instant) or a Loki metric target with a `legendFormat` now
  selects `"timestamp", "value", labels, <name> AS series` instead of `*`, so the column order (CONTRACTS §1.1)
  and UNION ALL across targets stay intact. `<name>` is the legend split on Grafana's `{{\s*(.+?)\s*}}`: each
  `{{label}}` → `COALESCE(label(labels, 'label'), '')` (Grafana renders a missing label as empty), text between →
  a string literal, joined with `||`. `timestamp`/`value` are quoted as the engine's own tests do.
- Dashboard variables in the legend text (`$env`) resolve like in the query (parameter / inlined constant /
  warnings, prefixed "The legend of …"). For this, `queryExpressionSql` was split into `emptyFindings` +
  `referencesSql` (no behaviour change); `tableFunctionSql` takes an optional `series` expression.
- `__auto`, empty, whitespace-only or missing legend → `SELECT *` (engine's `series` kept). Loki log queries and
  CloudWatch ignore legendFormat (CloudWatch already carries its `label` in the MetricDataQuery).
- Tested: rebuilt common via init.sh, called the built `dist/cjs` `translateGrafanaTarget` from node:
  `{{status}} responses` → `COALESCE(label(labels, 'status'), '') || ' responses' AS series FROM promql(...)`;
  `__auto`/''/undefined → `SELECT * FROM promql(...)`; instant with `{{ pod }} in $env ($nope)` → parameter env +
  `variable-undefined`; Loki metric `{{level}}'s` quoted correctly; Loki log query unchanged; a panel mixing a
  legend target and a plain one UNIONs with matching columns. Acceptance: legend-format 2/2; prometheus 5/5,
  loki 5/5, cloudwatch-metrics 5/5, panel-targets 3/3, datasources 6/6, time-macros 5/5, variables 6/6. tsc clean,
  oxlint clean, oxfmt applied.
- 2026-11-09T02:08:54Z supervisor: imp-query-legend-format passed the gate in round 1

### imp-query-cloudwatch-expressions (2026-11-08)

- `grafanaQuery.ts`: `cloudWatchMetricsKind` classifies a Metrics-mode target: `metricQueryType` 1 → its
  `sqlExpression`; type 0/unset with `metricEditorMode` 1 or a non-empty `expression` → the expression; else a
  MetricStat. Expressions become `{Id, Expression, Period, ReturnData: true[, Label]}` (no MetricStat, top-level
  Period) in one `cloudwatch()` call; empty text → TODO + `query-empty`; other `metricQueryType` values and
  non-Metrics modes (Logs) stay TODO + `query-cloudwatch-unsupported` (imp-query-cloudwatch-logs replaces the Logs part).
- Panel metric math (option (b) of the check, within CONTRACTS §1.1): `translateGrafanaPanelQueries` passes a
  `PanelScope` (all panel targets, hidden included) to translators. A code-mode expression whose identifiers name
  other targets' ids (`cloudWatchQueryId`) becomes one `cloudwatch()` per referenced MetricStat input, JOINed on
  `timestamp`, with the arithmetic in SQL (`100 * "errors"."value" / "invocations"."value" AS "value"`), the first
  input's `labels`, and the target's label (variables resolved) or id as `series`. Only numbers, `+ - * /` and
  parentheses are evaluated; functions (`METRICS()`, `SUM`, `FILL`…), unknown names, `^`, unbalanced parentheses or a
  non-MetricStat input → TODO + `query-cloudwatch-math-unsupported`. Inputs with different periods →
  `query-cloudwatch-math-periods`. Hidden inputs' warnings are added; visible inputs report their own.
  An expression referencing no panel target (SEARCH, Metrics Insights) goes to CloudWatch unchanged.
- `translateGrafanaTarget` (no panel) never does math: it sends the expression as is.
- **Integration trap**: the engine's `federation-engine/src/cloudwatch.rs` parses the *Grafana target* JSON
  (its contract assumption A19: `namespace`, `metricName`, `expression`…), and rejects `metricQueryType` 1, while
  this line (since imp-query-cloudwatch-metric-stat) emits the AWS `MetricDataQuery` shape that CONTRACTS §1.1
  names. The integration line has to pick one shape. Recorded, not changed here.
- Tested: rebuilt common via init.sh, drove the built `dist/cjs` translator from node: code-mode Metrics Insights
  expression → `Expression` with `Period` 300, no MetricStat; metricQueryType 1 → `sqlExpression` as Expression;
  panel with hidden `errors`/`invocations` and `100 * errors / invocations` → two cloudwatch() calls joined, math in
  SQL, series 'Error rate'; `SUM(METRICS())` → TODO + warning; differing periods → warning; `$env` in the label →
  parameter; SEARCH alone → Expression; Logs mode still TODO. Acceptance: cloudwatch-expressions 3/3;
  cloudwatch-metrics 5/5, panel-targets 3/3, datasources 6/6, variables 6/6, time-macros 5/5, prometheus 5/5,
  loki 5/5, legend-format 2/2. tsc clean, oxlint clean, oxfmt applied.
- 2026-11-09T02:13:18Z supervisor: imp-query-cloudwatch-expressions passed the gate in round 1

### imp-query-cloudwatch-logs (2026-11-08)

- `grafanaQuery.ts`: a CloudWatch target with `queryMode: 'Logs'` goes to `translateCloudWatchLogsTarget` and becomes
  `SELECT * FROM cloudwatch_logs('<group>,<group>', '<Logs Insights query>', ${ld.parameters.__from},
  ${ld.parameters.__to}[, '<source>'])` (CONTRACTS §1.1). Log groups come from `logGroups` (`name`, else the name
  parsed from the `arn`), else the legacy `logGroupNames`; blanks dropped, repeats kept once, joined with `,`.
  Variables resolve in both the log groups and the query (same `queryExpressionSql` as PromQL/LogQL).
- TODO + warning cases: no log group → `query-cloudwatch-log-groups-missing` ("…has no log group…"); empty
  `expression` → `query-empty`; `queryLanguage` other than `CWLI` (OpenSearch SQL / PPL) →
  `query-cloudwatch-unsupported`. A non-default `region` → `query-region-unsupported` (as Metrics mode).
- New `ResultShape` `'log-events'` (`timestamp, message, fields`), so Logs targets UNION with each other only, never
  with series or Loki log lines (`panel-targets-not-combined`). `statsGroups` is ignored: the engine returns stats
  rows through the same columns. Annotations mode stays TODO + `query-cloudwatch-unsupported`.
- Tested: rebuilt common via init.sh, drove the built `dist/cjs` translator from node: two `logGroups` (one by ARN
  only) → `cloudwatch_logs('/aws/lambda/fills-a,/aws/lambda/fills-b', …, 'cloudwatch-production')`; legacy
  `logGroupNames` + `$env` in the query + region us-west-2 → parameter concatenated + region warning; no group → TODO
  naming the missing log group; PPL → TODO; a panel with two Logs targets → UNION ALL. Acceptance:
  cloudwatch-logs 3/3; cloudwatch-metrics 5/5, cloudwatch-expressions 3/3, panel-targets 3/3, datasources 6/6,
  variables 6/6. tsc clean, oxlint clean, oxfmt applied.
- 2026-11-09T02:15:35Z supervisor: imp-query-cloudwatch-logs passed the gate in round 1

### imp-query-postgres (2026-11-08)

- `grafanaQuery.ts`: datasource types `grafana-postgresql-datasource` and legacy `postgres` go to
  `translatePostgresTarget`: `rawSql` becomes `SELECT * FROM platform_query('<sql>')` (one argument, no source:
  CONTRACTS §1.1 has one Platform Database). No shape is set, so Postgres targets never UNION with other targets.
  Empty `rawSql` (e.g. a legacy builder target without SQL) → TODO + `query-empty`.
- Macros are expanded the way Grafana expands them, over placeholders `'${__from}'`/`'${__to}'` that the existing
  reference pass turns into `' || ${ld.parameters.__from} || '` (new `ReferenceOptions.macroParameters`):
  `$__timeFilter(c)` → `c BETWEEN '<from>' AND '<to>'`; `$__timeFrom()`/`$__timeTo()` → quoted bounds;
  `$__time(c)` → `c AS "time"`; `$__timeEpoch(c)`; `$__timeGroup(c, iv[, fill])`/`$__timeGroupAlias` →
  `to_timestamp(floor(extract(epoch from c) / S) * S)` [AS "time"], where S is seconds computed here for a literal
  duration (`5m`, `'1h'`) or `extract(epoch from '<iv>'::interval)` for `$__interval`/a variable. **Decision**: the
  bucket is a timestamptz, not Grafana's epoch-seconds number, since Lightdash does not convert epochs. A fill
  argument is dropped with `query-macro-fill-dropped`.
  Grafana's global `$__from`/`$__to` are epoch **milliseconds** → `(extract(epoch from '<from>'::timestamptz) *
  1000)::bigint`; `${__from:date}`/`:date:iso` → the bare ISO text; `:date:seconds` → epoch seconds; `$__interval_ms`
  → ms of `__interval`. Other formats, `$__unixEpoch*` macros and unknown macros stay as written with
  `query-macro-unsupported` naming them. Dashboard variables resolve as for PromQL (bare text, as Grafana does).
- Tested: init.sh, drove the built `dist/cjs` translator from node with seven targets (plain SQL, timeFilter,
  timeGroupAlias with `$__interval`, timeGroup '5m' with fill + `$env`, `$__from`/`${__to:date:iso}`/
  `$__interval_ms`, `$__unixEpochGroupAlias`, empty SQL, legacy `postgres` type by name). Then ran the generated SQL
  on a throwaway local Postgres 18 (127.0.0.1:54329, synthetic `cron.job_run_details`), letting Postgres fold the
  parameter concatenation as the engine would: all queries ran, with 1m/15s/1h/1d intervals bucketing correctly
  (1h → 6 rows, 1d → 1). Server stopped. Acceptance: query-postgres 5/5; time-macros 5/5, variables 6/6,
  datasources 6/6, panel-targets 3/3, prometheus 5/5. tsc clean, oxlint clean, oxfmt applied.
- Leftover: `work/importers/tmp/pgcheck/` (throwaway cluster data dir, stopped) could not be deleted (rm denied);
  safe to remove.
- 2026-11-09T02:21:19Z supervisor: imp-query-postgres passed the gate in round 1

### imp-query-ops-marts (2026-11-08)

- `grafanaQuery.ts`: datasource types `grafana-github-datasource` and `grafana-sentry-datasource` are handled
  before the telemetry translators (`OPS_MART_DATASOURCES` → `translateOpsMartTarget`), since they read the
  engine's `ops_marts` catalog, not a Telemetry Source. The target's `queryType` is looked up in
  `ctx.opsMarts.github|sentry`. If it maps to a table, the SQL is `SELECT * FROM <table>`, with no shape, so it never UNIONs.
  If not (no mapping, a type the mapping lacks, or no queryType), the result is a TODO naming the datasource, the
  query type and the missing Ops Mart, plus a `no-ops-mart` warning.
- **Decisions** (the spec does not say): a mapped table must match `ops_marts(.<ident>){1,2}`
  (CONTRACTS §1.1 names `ops_marts.<dataset>.<table>`; the §3 allowlist example has 2 segments). Anything else
  becomes a TODO + `ops-mart-invalid`, so a mapping file can never inject SQL. The mart's columns are unknown,
  so the target's own filters (owner, repository, options, projectIds, …) are not applied. Instead an
  `ops-mart-filters-dropped` warning names those fields. No time filter is added, for the same reason. Codes
  were added to `ImportWarningCode`.
- Tested: init.sh rebuilt common, then I drove the built `dist/cjs` translator from node. GitHub Pull_Requests without a
  mapping → TODO "…needs an Ops Mart: map github.Pull_Requests…" + no-ops-mart. With the mapping →
  `SELECT * FROM ops_marts.github.pull_requests` + filters-dropped. Workflow_Usage → TODO + no-ops-mart. A table
  name like `x; drop table y` → TODO + ops-mart-invalid. In a mixed panel after a Prometheus target, the mart is
  left out with panel-targets-not-combined. Acceptance: query-ops-marts 3/3; datasources 6/6, panel-targets 3/3.
  tsc clean, oxlint clean (run from packages/common), oxfmt applied.
- Next: imp-dashboard-datasources reads `--ops-marts ops-marts.yml` (YAML `github: {Pull_Requests: table}`) into
  `opsMarts`; imp-dashboard-todo-tiles expects the TODO text to mention the Ops Mart (it does).
- 2026-11-09T02:23:41Z supervisor: imp-query-ops-marts passed the gate in round 1

### imp-query-expressions (2026-11-08)

- `grafanaQuery.ts`: a target whose datasource is Grafana's expressions datasource (`type: '__expr__'`, uid
  `__expr__` or legacy `-100`) goes to `translateExpressionTarget` before datasource resolution. Inputs are the
  panel's targets by refId (hidden ones included, `A`/`$A`/`${A}`), translated as usual. An input that is itself an
  expression is translated recursively, and a cycle is caught. A hidden input's warnings are passed on, as for
  CloudWatch math. New `ResultShape` `'number'` = `value, labels, series` (no timestamp) for reduced results.
  - `math`: numbers, `$refs`, `+ - * / %`, parens, unary +/-, abs/ceil/floor/round/log(→ln). The token
    sequence is validated. Inputs JOIN on `timestamp` (series inputs) and on `series_name(labels)` equal OR either
    side `'{}'`. **Decision**: this approximates Grafana's label-subset join; `labels` is json/Utf8, so it is compared
    through `series_name`. The result's labels come from the first input with labels, and `series` = series_name(labels), or
    the refId when unlabeled. All number inputs → number shape; no inputs → constant.
  - `reduce`: mean→avg, min, max, sum, count→count(*), last→`last_value(v ORDER BY "timestamp")` (DataFusion
    syntax), `GROUP BY labels, series`. `settings.mode: replaceNN` → `COALESCE("value", n)`. Strict and dropNN both
    use SQL aggregates (they skip NULL), with no warning.
  - `threshold` (exactly one condition; gt, lt, within/outside_range[_included], range bounds min/max of the params)
    → `CASE WHEN value IS NULL THEN NULL WHEN cond THEN 1.0 ELSE 0.0 END`, keeping the input's shape.
    `unloadEvaluator` → `expression-hysteresis-dropped`.
  - `classic_conditions` with **one** condition (reducer avg/min/max/sum/count/count_non_null/last; gt/lt/
    within/outside_range) → reduce per series, then `max(<1/0>)` as one number labelled `'{}'` (fires if any
    series does). **Decision**: step 4 only names multi-condition classic as untranslatable, so a single one is translated.
  - resample, sql, multi-condition classic, unknown types, unsupported math (`**`, `&&`, comparisons, is_nan, …),
    missing or failing inputs, cycles, and an expression translated without its panel (`translateGrafanaTarget`)
    → `TODO: translate the Grafana <type> expression (target X) by hand` + `expression-unsupported`.
  - New codes in `ImportWarningCode`: `expression-unsupported`, `expression-hysteresis-dropped`.
- Tested: ran init.sh, then drove the built `dist/cjs` translator from node (script in work/importers/tmp/exprcheck) with
  12 panels: math `$A / ${B} * 100` (by-code over total), reduce max, reduce last with replaceNN, threshold with a
  hysteresis, a reduce→threshold chain, single classic, resample, sql, multi classic, bad math (`&&`, `is_nan`,
  `**`), a self-reference, and visible A plus math (UNION ALL). The output was as described above. I could not
  run the SQL: starting a throwaway Postgres was denied by the sandbox this session. Acceptance: query-expressions 5/5;
  panel-targets 3/3, cloudwatch-expressions 3/3, prometheus 5/5, datasources 6/6, ops-marts 3/3. tsc clean,
  oxlint clean, oxfmt applied.
- Next: imp-alert-rule-conditions / imp-alert-rule-math can reuse `translateExpressionTarget` semantics. Alert rules
  need classic conditions and hysteresis as rule state, not SQL. The generated SQL has not run on the engine yet
  (`last_value(... ORDER BY ...)` is DataFusion aggregate syntax).
- 2026-11-09T02:29:54Z supervisor: imp-query-expressions passed the gate in round 1

### imp-cli-grafana-dashboard (2026-11-08)

- New pure module `packages/common/src/eng1799/grafanaDashboardImport.ts` (exported from the common index):
  - `readGrafanaDashboardJson(json)` → `{dashboard, folderTitle?}` or `{error}`. Accepts a dashboard or the API
    export `{dashboard, meta}` (`meta.folderTitle` is kept for imp-dashboard-spaces). A dashboard needs a non-blank
    `title` and a `panels` array; legacy pre-5.0 `rows` gets its own message.
  - `convertGrafanaDashboard(input, {spaceSlug, query?, takenDashboardSlugs?, takenChartSlugs?})` →
    `{dashboard, charts, warnings, todos}`. `query` is the datasources/opsMarts context (the variables come from
    `templating.list`). The taken-slug sets are shared across a run, so slugs stay unique (`-2`, `-3`, ...).
    Slugs are never random: a title with no letters falls back to a fixed slug.
  - `renderGrafanaImportReport(result)` → the minimal IMPORT-REPORT.md: a title, counts, a `| code | panel |
    message |` table (or "No warnings."), and a TODO list (or "No TODOs.").
- **Deliberately minimal parts that later features own** (replace them, don't stack on them):
  - Chart kind (`chartKindForPanel`): CARTESIAN → line, barchart/bargauge → vertical_bar, PIE → pie,
    GAUGE/stat → big_number, else table. No `chart-kind-fallback` yet (imp-dashboard-panel-kinds).
  - Layout: gridPos is copied as is, clamped to the 36-column grid (no 1.5 scaling yet: imp-dashboard-layout).
  - Rows: a row panel is skipped and a collapsed row's nested panels are flattened in place (no headings or tabs
    yet: imp-dashboard-rows/collapsed-rows).
  - Text: a markdown tile with `options.content` only (imp-dashboard-text handles html/code/legacy content).
  - Dropped types → `panel-dropped` with the mapping's reason. Unknown type → TODO tile + `panel-type-unsupported`
    (a new code; imp-docs must list it).
  - A panel with no SQL → a markdown TODO tile at its gridPos holding the translator's TODO text
    (imp-dashboard-todo-tiles refines it). `todos` counts TODO tiles only; dropped panels are not TODOs.
  - No time range, parameters/lightdash.config.yml, links or thresholds yet.
- CLI: `packages/cli/src/handlers/importGrafanaDashboard.ts`, registered in `index.ts` as
  `import grafana-dashboard <files...>` with `-o, --out <dir>` (required), `-s, --space <slug>` (default
  `operations`) and `--verbose`. The other pinned options (`--datasources`, `--ops-marts`, `--dashboards-tf`,
  `--no-tabs`) are not added yet; their features add them. All files are read and checked before anything is
  written. A failure throws `ParseError` with the file path in the message: "<file> is not valid JSON: ...",
  "<file> is not a Grafana dashboard: <reason>", or "Could not read the Grafana dashboard <file>: ENOENT ...".
  The output is dashboards/, charts/, reports/<slug>/IMPORT-REPORT.md, and import-summary.json (byCode sorted;
  `files` lists every file written before the summary). YAML is dumped after a JSON round trip, because the
  as-code types require `uuid: undefined` / `display: undefined`, which js-yaml can't dump. The run prints
  `Imported N dashboard(s) and M chart(s) into <out> (W warnings, T TODOs)`.
- Tested as a user: ran init.sh, then the CLI from source. `import --help` lists grafana-dashboard. A synthetic
  service-health.json (2 prom panels, an elasticsearch panel and a news panel) wrote the dashboard, 2 charts, the
  report (4 warnings, 1 TODO) and the summary. `lightdash lint --path out` said all files are valid. The fixture
  golden-signals.json gave 4 charts plus a text tile, and 18 warnings. A broken JSON file, `{"hello":"world"}` and a
  missing file each exited 1 naming the file, with no output written. Leaving out --out gives commander's
  required-option error. Acceptance: dashboard-command 4/4. tsc clean (common, cli), oxlint clean, oxfmt applied.
- 2026-11-09T02:35:46Z supervisor: imp-cli-grafana-dashboard passed the gate in round 1
