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
