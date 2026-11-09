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
13. **`regexp_replace`** (renameByRegex) is assumed to follow Postgres: first match only unless the flags include
    `g`, and `\N` back-references in the replacement. CONTRACTS §1 names Postgres semantics over DataFusion but
    doesn't list this function.

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

### imp-dashboard-chart-per-panel (2026-11-08)

- No code change: `convertGrafanaDashboard` (packages/common/src/eng1799/grafanaDashboardImport.ts), written for
  imp-cli-grafana-dashboard, already does this. Each chart panel becomes one SQL chart: the name is the panel title,
  or `Untitled <type> <id>` when the title is blank. The trimmed description is kept, or set to null. The slug is
  `<dashboard-slug>-<panel-name>`, made unique across the run (`-2`, ...). The chart holds the translated SQL, limit
  500, and a config.type equal to chartKind. Each chart also gets one `sql_chart` tile with a unique tileSlug,
  `properties.chartSlug` set to the chart slug and `chartName` set to the chart name.
- Tested as a user: ran init.sh, then the CLI from source on a synthetic dashboard. It had two `Requests`
  timeseries panels (one with a description) and an untitled table panel, all Prometheus. The run wrote
  chart-per-panel-requests.yml, -requests-2.yml and -untitled-table-3.yml. The description was kept on the first
  chart, each SQL is `SELECT * FROM promql('<expr>', __from, __to, __interval)`, and the dashboard has 3 sql_chart
  tiles (requests, requests-2, untitled-table-3) that reference the charts by chartSlug. `lightdash lint` passed. The
  3 warnings are datasource-unresolved, which is expected without a datasources mapping.
  Acceptance: dashboard-charts 4/4.
- 2026-11-09T02:37:24Z supervisor: imp-dashboard-chart-per-panel passed the gate in round 1

### imp-dashboard-panel-kinds (2026-11-08)

- `chartKindForPanel` in packages/common/src/eng1799/grafanaDashboardImport.ts now takes the panel and its mapping
  and returns `{ kind, fallbackFrom? }`. The kinds are: cartesian → line, or vertical_bar for barchart, for a graph with
  `bars: true, lines: false` and for a timeseries with `fieldConfig.defaults.custom.drawStyle: 'bars'`; pie → pie;
  table → table; gauge → big_number; registry stat-sparkline → big_number; registry bar-gauge → vertical_bar; anything
  else (log_stream, trace_waterfall) → table. Wherever the SQL chart can't be the mapped type, the panel gets a
  `chart-kind-fallback` warning (a new code; imp-docs must list it). The warning names the intended type: the registry
  slug for registry charts, otherwise the ChartType value (gauge, log_stream). It reads: "The <type> panel maps to the
  <wanted> chart type, which SQL charts do not support; it is imported as a <kind> SQL chart".
  `GrafanaDashboardPanel` gained typed `bars`, `lines` and `fieldConfig.defaults.custom.drawStyle`.
- Decision: the spec doesn't name a kind for bargauge (the test accepts any kind), so it stays vertical_bar.
- Tested as a user: ran init.sh, then the CLI from source on a synthetic dashboard with one panel of each of the 10
  types, plus a bars-only graph and a bars timeseries (Prometheus; Loki for the logs panel). The 12 charts came out as
  line, line, vertical_bar, pie, table, table, big_number, big_number, vertical_bar (bargauge) and table (logs), and
  both bar-style panels came out as vertical_bar. IMPORT-REPORT.md has 4 chart-kind-fallback rows naming
  stat-sparkline, gauge, bar-gauge and log_stream. `lightdash lint` said all files are valid.
  Acceptance: dashboard-panel-kinds 3/3, dashboard-charts 4/4, dashboard-command 4/4. tsc (common) and oxlint are clean,
  and oxfmt was applied.
- 2026-11-09T02:40:31Z supervisor: imp-dashboard-panel-kinds passed the gate in round 1

### imp-dashboard-dropped-panels (2026-11-08)

- Panel drops already worked: since imp-cli-grafana-dashboard, alertlist, dashlist and news give one `panel-dropped`
  warning carrying the mapping's reason (alertlist cites ADR 0001) and no tile.
- New: `droppedPanelOptions` in packages/common/src/eng1799/grafanaDashboardImport.ts walks each imported panel
  (chart, markdown and TODO-tile panels; never dropped panels) and checks each path with
  `getGrafanaPanelOptionMapping`. It stops at the first path the mapping knows, so a dropped array or object such as
  `options.legend.calcs` gives one warning. Override properties are looked up as `fieldConfig.overrides.<id>`. Each
  option the mapping drops gives one `option-dropped` warning: "The <type> panel option <path> is not imported.
  <reason>". Unset, null and blank-string values are skipped: Grafana exports `description: ""` on text panels, and a
  blank value sets nothing.
- Decision: per-panel time overrides (`timeFrom`, `timeShift`) use the `option-dropped` code too. The panel mapping
  already lists them as dropped common options with their own reasons, so I didn't add a new code.
- Decision: `transformations` is skipped in the option walk. The transform-* features own that warning
  (`transformation-unsupported`), and skipping it avoids a double warning. Until those features land, transformations
  are still dropped without a warning. Options the mapping *keeps* (legend placement, units, ...) aren't reported here,
  even though the SQL chart config can't hold them yet. Later features (legend-stacking, thresholds-units) own those.
- `ImportWarningCode` now lists panel-type-unsupported, panel-dropped, option-dropped and chart-kind-fallback.
- Trap: the CLI loads the *built* @lightdash/common. After you edit common, rerun init.sh before the acceptance
  tests, or the old build runs.
- Heads-up for imp-roundtrip-warning-snapshot and imp-docs: option-dropped is now the largest code. golden-signals
  gives 71 of its 89 warnings.
- Tested as a user: ran the CLI from source on a synthetic dashboard with alertlist, dashlist, news and a timeseries
  that sets lineWidth, gradientMode, tooltip.mode, legend.calcs, an override with custom.lineStyle, timeFrom and
  timeShift. The run wrote 1 chart and a dashboard with 1 tile. IMPORT-REPORT.md listed 3 panel-dropped rows (ADR 0001
  on alertlist) and 7 option-dropped rows, each naming its path and reason. Acceptance: dashboard-dropped-panels 4/4,
  dashboard-command 4/4, dashboard-charts 4/4, dashboard-panel-kinds 3/3. tsc (common) and oxlint are clean, and oxfmt
  was applied.
- 2026-11-09T02:45:18Z supervisor: imp-dashboard-dropped-panels passed the gate in round 1

### imp-dashboard-layout (2026-11-08)

- `tilePosition` in packages/common/src/eng1799/grafanaDashboardImport.ts now scales gridPos x and w by 36/24
  (`Math.round`, w at least 1, clamped so x + w <= 36). y and h stay in Grafana row units, so rows keep their order and
  proportions, and the next row starts where the one above ends.
- New: `resolveTileOverlaps` runs over the finished tile list. It places tiles top to bottom and left to right, and
  moves any tile that hits an already placed tile down to just below it. The array order is kept. This covers
  rounding collisions: Grafana x=3,w=5 becomes 5..13, and a neighbour at x=8 becomes 12, so they would overlap. It
  also covers overlapping gridPos in the source and the panels of collapsed rows, which are still flattened in place.
- Decision: the spec fixes x and w to round(1.5 * value), so a rounding collision is fixed by moving the tile down
  rather than by narrowing it. Trap for imp-dashboard-rows and imp-dashboard-collapsed-rows: if rows become tabs or
  their y changes, keep `resolveTileOverlaps` as the last step, and note that the overlap check ignores tabSlug (all
  tiles are compared).
- Tested as a user: ran init.sh, then the CLI from source on a synthetic dashboard with half, third, full and odd-width
  panels, plus a 1-wide neighbour that collides with the odd panel after rounding and a full-width row below it. The
  tiles came out as 0/18 (w 18), 0/12/24 (w 12), 0/36 and 5/8. The colliding neighbour moved from y 24 to 27, and the
  row below moved to 30, with no overlaps. `lightdash lint` said all files are valid. Acceptance: dashboard-layout 3/3,
  dashboard-command 4/4, dashboard-charts 4/4, dashboard-panel-kinds 3/3, dashboard-dropped-panels 4/4. tsc (common) and
  oxlint are clean, and oxfmt was applied.
- 2026-11-09T02:49:17Z supervisor: imp-dashboard-layout passed the gate in round 1

### imp-dashboard-rows (2026-11-08)

- packages/common/src/eng1799/grafanaDashboardImport.ts: an expanded row panel (`type: 'row'`, `collapsed` not true)
  now becomes a `heading` tile with `properties.text` set to the row title. It sits at x 0, w 36, and keeps the
  row's gridPos y and h (Grafana rows are h 1). The panels in an expanded row follow it at the top level of the
  export, so they land below it. `flattenPanels` keeps expanded rows in the list. Collapsed rows are still replaced
  by their panels. `tabs` stays `[]`.
- Decision: an expanded row with a blank title gets no heading and no warning, because Grafana shows nothing for
  it. If an expanded row's `panels` array is non-empty (unusual), those panels are listed after the heading.
- Heading tiles go through `resolveTileOverlaps` like every other tile, and that is still the last step.
- Next, imp-dashboard-collapsed-rows: use `isExpandedRow` to split the cases. Collapsed rows become tabs, and with
  --no-tabs they become headings, which can reuse the heading tile built here.
- Tested as a user: ran init.sh, then the CLI from source on a synthetic dashboard with a top panel, a Traffic row
  with two panels, an Errors row with one panel, and a blank-title row. dashboards/rows-demo.yml had the headings
  Traffic (y 6) and Errors (y 15), both x 0 w 36 h 1. Requests and Latency were at y 7, Error ratio at y 16, and
  tabs was []. The blank row added no tile, and the report had no row warnings. `lightdash lint` said all files
  are valid. Acceptance: dashboard-rows 2/2, dashboard-layout 3/3, dashboard-command 4/4, dashboard-charts 4/4,
  dashboard-panel-kinds 3/3, dashboard-dropped-panels 4/4. tsc (common) and oxlint are clean, and oxfmt was applied.
- 2026-11-09T02:53:47Z supervisor: imp-dashboard-rows passed the gate in round 1

### imp-dashboard-collapsed-rows (2026-11-08)

- packages/common/src/eng1799/grafanaDashboardImport.ts: new `layoutPanels` decides where each panel goes before
  tiles are built. If the dashboard has a collapsed row (and `noTabs` is not set), each collapsed row becomes a tab
  (name = row title, or `Row <n>` if blank) holding its panels, rebased so the top panel sits at y 0. Every panel
  outside collapsed rows (including expanded-row headings) goes on a first tab named `Overview`
  (`GRAFANA_FIRST_TAB_NAME`), which is left out if it would be empty. Tabs get slugs (`uniqueSlug`) and order 0..n-1,
  and every tile gets `tabSlug`. If there's no collapsed row, there are no tabs and tiles get no `tabSlug`, so
  earlier output is unchanged.
- With `noTabs` (CLI `--no-tabs`; commander sets `options.tabs = false`), a collapsed row becomes a heading tile (the
  same code path as expanded rows: any `type: 'row'` in the layout becomes a heading; blank title = no heading). Its
  panels go right below it, and everything after the row moves down by the height of the row's content, the way
  Grafana does when you expand a row.
- `resolveTileOverlaps` now resolves overlaps per tab (grouped by `tabSlug`) and is still the last step.
  `flattenPanels` now keeps every row (collapsed rows are only flattened in the no-tabs path).
- Rows are never passed to `droppedPanelOptions`, so `collapsed` causes no warning.
- Follow-up for whoever owns docs/eng-1799/grafana-panel-mapping.md (docs-panel-mapping.test.ts checks it against
  the mapping module): the `row.collapsed` reason says the panels are "imported expanded below the heading". That's
  only true with --no-tabs now, and by default collapsed rows become tabs. I didn't edit it because the doc is tied
  to the mapping module. The `--no-tabs` flag also still needs to go in the importer docs (docs.test.ts lists it,
  which is a later feature).
- Tested as a user: ran init.sh, then the CLI from source on a synthetic dashboard with a top panel and the
  collapsed rows Database (2 panels) and Queues (1 stat). Default: tabs overview/database/queues with order 0/1/2,
  Overview chart on overview, Connections and Replica lag on database at y 0 (x 0 and 18), Queue depth on queues at
  y 0. With --no-tabs: tabs [], heading Database at y 8, Connections and Replica lag at y 9, heading Queues at y 17,
  Queue depth at y 18, and 4 charts. `lightdash lint -p` said all files are valid for both outputs. Acceptance:
  dashboard-collapsed-rows 2/2, dashboard-rows 2/2, dashboard-layout 3/3, dashboard-command 4/4, dashboard-charts
  4/4, dashboard-panel-kinds 3/3, dashboard-dropped-panels 4/4. tsc (common) and oxlint are clean, and oxfmt was
  applied.
- 2026-11-09T02:59:03Z supervisor: imp-dashboard-collapsed-rows passed the gate in round 1

### imp-dashboard-text (2026-11-08)

- packages/common/src/eng1799/grafanaDashboardImport.ts: new `textPanelMarkdown` builds the markdown tile content for
  text panels. markdown and html (and any other mode) content is copied exactly. With `mode: 'code'`, the content is
  wrapped in a fence with `options.code.language` (trimmed; a blank language gives a bare fence). The fence is one
  backtick longer than the longest backtick run in the content (at least 3), so embedded ``` can't close it early. A
  trailing newline is added before the closing fence only if one isn't already there. `mode` and `content` are read
  from `options` first, then from the panel root (old schema). `mode`/`content` were added to `GrafanaDashboardPanel`.
- Root-level legacy `mode`/`content` produce no option-dropped warning: the walk finds no mapping for them and they
  are strings, not records. `options.code.showLineNumbers`/`showMiniMap` still warn as dropped (the mapping says so).
  The panel mapping module and docs are unchanged.
- Tested as a user: ran init.sh, then the CLI from source on a synthetic dashboard with markdown, html, code (sql,
  content containing ```) and legacy root-content text panels. dashboards/text-demo.yml had 4 markdown tiles and no
  charts. Markdown and html were copied exactly, the code tile was a ````sql fence (4 backticks, because of the
  embedded ```), and the legacy tile held the root content. The only warning was option-dropped for
  options.code.showLineNumbers. Acceptance: dashboard-text 3/3, dashboard-dropped-panels 4/4, dashboard-charts 4/4,
  dashboard-collapsed-rows 2/2. tsc (common) and oxlint are clean, and oxfmt was applied.
- 2026-11-09T03:02:00Z supervisor: imp-dashboard-text passed the gate in round 1

### imp-dashboard-links (2026-11-08)

- packages/common/src/eng1799/grafanaDashboardImport.ts: panel links (`links`), field links
  (`fieldConfig.defaults.links`) and `links` override properties are added to the SQL chart `description`, after the
  panel description: a blank line, `Links:`, then one `- [title](url)` per link (repeats dropped, title falls back to
  the url). Brackets in titles are escaped; a url with spaces, parentheses or `<>` is written `<url>` so it stays one
  link. Grafana data-link variables (`${__field.labels.route}`) are copied as they are.
- The dashboard `description` is now set: the Grafana dashboard description, then the same `Links:` list from the
  dashboard `links`. A `type: 'link'` link becomes `[title](url)`. A `type: 'dashboards'` (tag-based) link is named
  without a url, as `Related (not imported: it lists the Grafana dashboards tagged kubernetes-app)`, and gives a
  `dashboard-link-unsupported` warning (no panel) that names the tags, so it is in IMPORT-REPORT.md. With neither
  description nor links, `description` is left out of the YAML.
- A panel/field link with no url is left out and gives `link-unsupported`. New codes are in importWarnings.ts.
- Links no longer give `option-dropped`: `links` is in NON_OPTION_PANEL_KEYS and `fieldConfig.defaults.links` /
  `fieldConfig.overrides.links` are skipped in `droppedPanelOptions`. The panel mapping module (and its doc) still
  says `links` is dropped ("no per-panel link menu"), which is still true of the menu; I didn't touch it because
  docs-panel-mapping.test.ts ties the doc to the module. Whoever owns that doc may want the reason to mention that
  links now go into the chart description.
- `GrafanaDashboardPanel` got `links` and a wider `fieldConfig` (`defaults.links`, `overrides`).
- Tested as a user: ran init.sh, then the CLI from source on a synthetic dashboard with two panel links plus one
  without a url, a field link, a links override with a spaced url, a plain dashboard link and a tag-based one. Chart
  descriptions held "Requests per second." then [Service SLOs](...) and [Runbook](...); the field-links chart held
  [Trace search](...) and [Wiki (old)](<... page>). The dashboard description held "Synthetic dashboard.",
  [Platform docs](...) and the named Related link; IMPORT-REPORT.md listed dashboard-link-unsupported (kubernetes-app)
  and link-unsupported (Broken), and no option-dropped. `lightdash lint -p` said all files are valid. Acceptance:
  dashboard-links 2/2, dashboard-dropped-panels 4/4, dashboard-charts 4/4, dashboard-command 4/4, dashboard-text 3/3,
  dashboard-collapsed-rows 2/2. tsc (common) and oxlint are clean, and oxfmt was applied.
- 2026-11-09T03:06:46Z supervisor: imp-dashboard-links passed the gate in round 1

### imp-dashboard-time-range (2026-11-08)

- New pure module packages/common/src/eng1799/importTimeRange.ts (exported from the common index):
  `importDashboardTimeRange(time, refresh)` returns the dashboard-as-code `timeRange`
  (`{from, to, refreshInterval, tileTimeDimensions: {}}`) and warnings. It is written for reuse by the Perses importer
  (imp-perses-queries-variables: duration/refreshInterval), so call it there rather than writing another one.
- grafanaDashboardImport.ts sets `timeRange` on every imported dashboard from `source.time` / `source.refresh`; the
  warnings carry the dashboard name and no panel.
- Rules (my decisions, as the spec only says "relative or absolute, refresh to the nearest allowed value"):
  - `now` and `now-<n><s|m|h|d|w>` are kept. Months/years become days (1M = 30d, 1y = 365d). Grafana rounding
    (`now/d`, `now-1d/d`) is dropped: a rounded `from` reaches back one more unit (Today `now/d`..`now/d` → `now-1d`..`now`,
    Yesterday → `now-2d`..`now-1d`). Each gives `time-range-adjusted`.
  - Absolute ISO with an offset and epoch-ms strings become ISO UTC with no warning; offset-less timestamps are read as
    UTC with `time-range-adjusted`.
  - Unreadable, future (`now+1h`) or reversed ranges become Grafana's default `now-6h`..`now` with
    `time-range-unsupported`. A dashboard with no `time` gets that default silently (Grafana does the same).
  - Refresh: ''/false/missing → null. Otherwise the nearest of DASHBOARD_REFRESH_INTERVALS (ties go to the longer
    interval) with `refresh-adjusted` when the duration differs (`60s` → `1m` gives no warning). Unreadable refresh →
    null with `refresh-unsupported`.
  - `tileTimeDimensions` is `{}`: the SQL charts already read `${ld.parameters.__from}`/`__to` from the query
    translators, so no change was needed there.
- New warning codes in importWarnings.ts: time-range-adjusted, time-range-unsupported, refresh-adjusted,
  refresh-unsupported. The fixture dashboards may now produce some of these, so whoever builds the warning docs /
  warning-count snapshot features must list them.
- Unit test: packages/common/src/eng1799/importTimeRange.test.ts (21 cases).
- Tested as a user: ran init.sh, then the CLI from source on 8 synthetic dashboards (now-24h/1m, absolute/false,
  now-30m/5s, now/d with 2h, now-1d/d, now-3M with 45s, epoch+offset-less with "bogus", reversed with 30s). The YAML
  timeRange values matched the rules above, IMPORT-REPORT.md listed each adjusted/unsupported warning, every one of the
  16 chart SQLs read __from and __to, and `lightdash lint -p` said all files are valid. Acceptance: dashboard-time-range
  4/4, plus dashboard-command, -charts, -links, -collapsed-rows, -dropped-panels, -layout, -rows, -text, -panel-kinds all
  passing. tsc (common) and oxlint are clean, and oxfmt was applied.
- 2026-11-09T03:13:50Z supervisor: imp-dashboard-time-range passed the gate in round 1

### imp-dashboard-todo-tiles (2026-11-08)

- The behaviour was already in place from imp-cli-grafana-dashboard: a panel whose translation has no SQL (or an
  unknown panel type) becomes a markdown tile at its gridPos, titled after the panel, holding the translator's TODO
  text, and `todos` counts it. The check passed before any change.
- Refinement in packages/common/src/eng1799/grafanaDashboardImport.ts: a panel with several untranslatable targets
  gets one TODO line per target (the translator joins them with `\n`). Markdown folds single newlines into one
  paragraph, so the tile ran them together, and IMPORT-REPORT.md's `cell()` ran them into one bullet. Now
  `todoMarkdown` makes them a markdown list in the tile (a single TODO stays a plain paragraph), and the report gives
  that panel a nested list. `ImportTodo.text` is unchanged, so `todos` still counts tiles, not lines.
- Tested as a user: ran init.sh, then the CLI from source on a synthetic dashboard (a Prometheus timeseries, a GitHub
  Pull_Requests table, a panel with two GitHub targets, an unknown panel type). The output was one chart, and the
  "Open pull requests" tile at x 18, y 0, w 18 said "TODO: GitHub Pull_Requests target A needs an Ops Mart: map
  github.Pull_Requests to an ops_marts table, or rebuild the query by hand". The two-target tile was a two-item list, the
  report listed the TODOs (nested for the two-target panel), and import-summary.json showed todos 3 and no-ops-mart 3.
  Acceptance: dashboard-todo-tiles 2/2, dashboard-text 3/3, dashboard-command 4/4. tsc (common) and oxlint are
  clean, and oxfmt reports nothing to change.
- Trap: dashboard-report, dashboard-datasources and perses-panels fail at present because their features
  (`--datasources`, the Perses importer) are not built yet. They failed the same way before this change.
- Perses (imp-perses-panels) should reuse the same TODO tile path so multi-line TODOs render the same way.
- 2026-11-09T03:18:10Z supervisor: imp-dashboard-todo-tiles passed the gate in round 1

### imp-dashboard-variables (2026-11-08)

- New module packages/common/src/eng1799/grafanaVariables.ts (exported from index.ts):
  - `grafanaVariableParameters(variables)`: each custom, query, textbox and interval variable (the
    `PARAMETER_VARIABLE_TYPES` now exported from grafanaQuery.ts, so the query translator and this agree) becomes a
    project parameter (label = variable label or name, description if set) and a dashboard parameter
    `{parameterName, value}` at its current value. Custom and interval variables list `options` (saved options without
    All/auto, else the comma-split `query`; custom `text : value` gives label+value pairs, `\,` escapes); query and
    textbox variables get `allow_custom_values: true`. The config `default` is the current value (omitted when '').
    Constants and datasource variables never become parameters (the translator inlines / resolves them).
  - Decision: All (`$__all`) has no single Lightdash value, so the parameter starts at the variable's `allValue`, else
    `.*`; an auto interval starts at the first interval option. Each is a `parameter-default-adjusted` warning.
  - A name a parameter can't have (outside `^[a-zA-Z0-9_-]+$`) is skipped with `variable-unsupported`.
  - `mergeProjectParameters(sources)`: one lightdash.config.yml for all dashboards in a run. First definition keeps
    label/description/default, later options are appended, any `allow_custom_values` wins. A difference is a
    `parameter-merged` warning, returned with the source index; the CLI adds it to that dashboard's warnings so the
    report and summary agree.
- grafanaDashboardImport.ts: `GrafanaDashboardImport.parameters` (project parameters) and `dashboard.parameters`
  (only when there are any).
- CLI (handlers/importGrafanaDashboard.ts): writes `lightdash.config.yml` (`spotlight: {default_visibility: show}` +
  `parameters`) only when a dashboard defines parameters, lists it in import-summary.json `files`, and prints a line
  telling the user to add the parameters to their project's lightdash.config.yml.
- grafanaQuery.ts: a datasource variable whose current value matches no known datasource (e.g. no `--datasources`
  map) now names the Telemetry Source from its current text (`Cloudwatch Staging` → `cloudwatch-staging`), typed by
  the variable's `query`. `default`, All and other `$` values still fall to the engine default with
  `datasource-unresolved`.
- New warning codes: parameter-default-adjusted, parameter-merged. Whoever builds the warning docs / snapshot must
  list them (the 32 fixtures produce 9 and 5 of them without --datasources).
- Unit test: packages/common/src/eng1799/grafanaVariables.test.ts (8 cases).
- Tested as a user: ran init.sh, then the CLI from source on the step's dashboard (custom env, constant cluster, query
  pod, interval agg, textbox queue, datasource variable) plus a second dashboard redefining env/pod/agg with All and
  auto. lightdash.config.yml had env (Environment, prod/staging/dev), pod and queue (allow_custom_values) and agg
  (1m/5m/1h/10m), nothing for cluster or datasource; the dashboards' parameters were staging/api-1/5m/fills and
  dev/.*/1m; the Per env SQL read `${ld.parameters.env}`, pod and agg with `cluster="prod-eks"` inlined; the Queue SQL
  read `${ld.parameters.queue}` and ended in 'cloudwatch-staging'; reports listed the adjusted/merged warnings.
  `lightdash lint -p` said all files are valid. All 32 fixture dashboards in one run give a lightdash.config.yml with
  24 parameters that validates against the project-config schema. Acceptance: dashboard-variables 3/3, plus
  dashboard-command, -time-range, -charts, -todo-tiles and common query-variables, -datasources,
  -cloudwatch-metrics passing. tsc (common, cli) and oxlint clean, oxfmt applied.
- Trap: roundtrip-dashboards still fails only because `--datasources` is not built (unknown option).
- Perses (imp-perses-queries-variables) should reuse `mergeProjectParameters` and the same lightdash.config.yml write.
- 2026-11-09T03:26:45Z supervisor: imp-dashboard-variables passed the gate in round 1

## imp-dashboard-datasources (round 1)
- New pure module packages/common/src/eng1799/grafanaImportMaps.ts (exported from index.ts):
  - `parseGrafanaDatasourcesTf(text)` reads each `resource "grafana_data_source"` block's top-level `type`, `name`,
    `uid` from HCL (comments, heredocs, nested blocks and `jsonencode(...)` are skipped by a small scanner, not a
    Terraform evaluator). A resource whose type/name/uid is not a plain string literal (`local.x`, `"${var.env}"`) is
    listed in `skipped` with the reason. A resource without `uid` (the fixture's Sentry) is kept with uid `''` and
    resolves by name; grafanaQuery.ts `resolveDatasource` now ignores an empty ref uid so `''` never matches it.
  - `readGrafanaOpsMarts(doc)` checks a parsed `--ops-marts` YAML: only `github` / `sentry` keys, each mapping a query
    type to a non-empty string. The table name format is still checked where it is used (`ops-mart-invalid` TODO).
- CLI: packages/cli/src/handlers/grafanaImportMaps.ts reads the files (`readGrafanaDatasourcesFile` prints skipped
  resources as warnings and fails when the file has no readable grafana_data_source; `readGrafanaOpsMartsFile` fails
  on bad YAML/shape, naming the file). `import grafana-dashboard` gained `--datasources <tf>` and `--ops-marts <yml>`,
  passed to `convertGrafanaDashboard` as `query`. imp-cli-grafana-alerts should reuse these two readers for its
  `--datasources`.
- Unit test: packages/common/src/eng1799/grafanaImportMaps.test.ts (5 cases).
- Tested as a user: ran init.sh, then the CLI from source on the step dashboard (staging Prometheus panel + GitHub
  Pull_Requests panel). Without options: promql('up', from, to, interval) with no source, warnings
  datasource-unresolved 1 + no-ops-mart 1, 1 TODO. With `--datasources fixtures/terraform/grafana_data_sources.tf
  --ops-marts ops-marts.yml`: promql(..., 'prometheus-staging'), Pull requests chart `SELECT * FROM
  ops_marts.github.pull_requests`, 0 TODOs, one ops-mart-filters-dropped warning (owner/repository). grafana_folders.tf
  as --datasources and an ops-marts file with a `jira` key each fail with a clear message.
- Acceptance: dashboard-datasources 3/3; dashboard-command, -variables, -todo-tiles, -report and common
  query-datasources, -ops-marts pass. tsc (common, cli), oxlint, oxfmt clean.
- Trap: roundtrip-dashboards now fails only on the unbuilt `--dashboards-tf` option (unknown option).
- 2026-11-09T03:32:27Z supervisor: imp-dashboard-datasources passed the gate in round 1

## imp-dashboard-import-report (round 1)
- Found already built: earlier sessions (imp-cli-grafana-dashboard onward) added `renderGrafanaImportReport` in
  packages/common/src/eng1799/grafanaDashboardImport.ts, and the CLI handler writes
  reports/<slug>/IMPORT-REPORT.md after the merged-parameter warnings are attached to each result, so per-dashboard
  report counts always add up to import-summary.json. The acceptance check dashboard-report passed 4/4 before any change.
- Only change: new unit test packages/common/src/eng1799/grafanaDashboardImport.test.ts (3 cases: warnings table with
  code+panel and the TODO list; clean dashboard says "No warnings."/"No TODOs."; `|`/newline escaping in cells,
  dashboard-level warning with empty panel cell, multi-target TODO as a nested list). It is the first unit test for
  grafanaDashboardImport.ts; later dashboard features can add cases there.
- Tested as a user: ran init.sh, then the CLI from source on "Report One" (news panel + Elasticsearch timeseries) and
  "Report Two" (one Prometheus panel on uid RnQB6bP4kz) with `--datasources fixtures/terraform/grafana_data_sources.tf`.
  report-one/IMPORT-REPORT.md: header "0 charts, 2 warnings, 1 TODO", rows `panel-dropped | Blog feed` and
  `datasource-unsupported | Elastic errors`, TODO "Elastic errors: translate target A from the elasticsearch datasource
  by hand". report-two: "No warnings." / "No TODOs.". import-summary.json: total 2, byCode panel-dropped 1 +
  datasource-unsupported 1, todos 1. Report format: `# Import report: <name>`, counts line, `## Warnings` table
  (Code | Panel | Message), `## TODO` list.
- Trap: a Prometheus uid not in the tf (e.g. `prometheus-staging`, which is a resource name, not a uid) gives a
  datasource-unresolved warning, so a "clean" test dashboard needs a real uid from the fixture.
- 2026-11-09T03:35:38Z supervisor: imp-dashboard-import-report passed the gate in round 1

## imp-dashboard-spaces (round 1)
- `--space` (default `operations`, DEFAULT_GRAFANA_DASHBOARD_SPACE) already reached the dashboard and every chart
  through `convertGrafanaDashboard({spaceSlug})`; this feature added `--dashboards-tf <grafana_dashboards.tf>`.
- Common (packages/common/src/eng1799/grafanaImportMaps.ts):
  - The HCL block reader now also keeps each top-level attribute's raw expression text (`expressions`, from after
    `=` to end of line, trailing comment dropped), for values that aren't plain string literals.
  - `parseGrafanaDashboardsTf(text)` reads each `resource "grafana_dashboard"` with
    `for_each = fileset("${path.module}/<dir>", "<pattern>")` and `folder = grafana_folder.<x>["<title>"].id|uid`
    (no `folder` = Grafana root). Other shapes (single config_json, computed folder) go to `skipped` with a reason.
  - `findGrafanaDashboardResource(resources, file)` matches a dashboard file by path-segment suffix of the fileset
    dir (`grafana_config/rds` matches `/any/where/grafana_config/rds/x.json`, so the tf need not sit next to the
    JSON) plus the fileset pattern (`*`, `?`, `{a,b}`); the longest dir wins.
- CLI: `readGrafanaDashboardsTfFile` in handlers/grafanaImportMaps.ts (prints skipped resources, fails when the file
  has no readable grafana_dashboard). The handler gives each file the space `generateSlug(folderTitle)` (`BCP/DR` ->
  `bcp-dr`); a root dashboard, or a file in no resource's folder (CLI warning on stderr, not an import warning, so
  warning counts are unchanged), goes to `--space`.
- Decision: the API export's `meta.folderTitle` is NOT used for the space; only --dashboards-tf decides. A later
  feature could use it as a fallback if wanted.
- Unit tests: grafanaImportMaps.test.ts +2 cases (parse/skip; file matching incl. Windows separators).
- Tested as a user: CLI from source on rds/pg_cron.json: no options -> dashboard + 3 charts `spaceSlug: operations`;
  `--space grafana-migration` -> all grafana-migration. pg_cron + bcp-dr/dr-replication-production + golden-signals
  with `--dashboards-tf grafana_dashboards.tf --space general` -> dashboards in rds, bcp-dr, general and every chart
  (3/22/4) in its dashboard's space. `--dashboards-tf grafana_folders.tf` fails with a clear message (exit 1); a copy
  of golden-signals outside grafana_config warns and goes to operations.
- Acceptance: dashboard-spaces 3/3; dashboard-command, -datasources, -report pass. tsc (common, cli), oxlint, oxfmt
  clean. roundtrip-dashboards not run (heavy; its unknown-option failure should now be gone).
- 2026-11-09T03:41:47Z supervisor: imp-dashboard-spaces passed the gate in round 1

## imp-dashboard-multi-file (round 1)
- No production code change was needed: the behaviour already came from imp-cli-grafana-dashboard and
  imp-dashboard-chart-per-panel. The handler shares `takenDashboardSlugs`/`takenChartSlugs` across every file in
  one run, and `uniqueSlug` in common grafanaDashboardImport.ts is deterministic (`generateSlug`, no random suffix,
  `-2`, `-3`, ... on collision). Chart slugs are `<dashboard-slug> <panel title>`. The check passed before any edit.
- Added unit tests (grafanaDashboardImport.test.ts, "convertGrafanaDashboard over several dashboards"): same-titled
  dashboards; a later title that collides with a generated suffix ("Same Title 2" -> `same-title-2-2`); titles with
  no slug characters -> `grafana-dashboard`, `grafana-dashboard-2`; unique chart slugs; tiles reference their own
  charts; identical output on two runs.
- Tested as a user: CLI from source on three dashboards ("Same Title" x2, "Another", one Requests panel each) ->
  dashboards same-title, same-title-2, another; charts same-title-requests, same-title-2-requests,
  another-requests; each tile's chartSlug names an existing chart file. Ran it into a second out dir and again into
  the first: `diff -r` shows no difference. Five-dashboard edge case (above) gave 5 unique dashboard and chart slugs.
- Note: slugs depend on the order of the input files (the first "Same Title" gets the bare slug). The same command
  always gives the same files. Re-running into an existing --out dir overwrites files but does not delete stale ones
  from an earlier run with other inputs.
- Acceptance: dashboard-multi 3/3, dashboard-command 4/4. tsc (common), oxlint, oxfmt clean.
- 2026-11-09T03:45:02Z supervisor: imp-dashboard-multi-file passed the gate in round 1

## imp-dashboard-thresholds-units (round 1)
- New common module eng1799/grafanaChartDisplay.ts: `grafanaChartDisplay(panel, kind)` returns `{ cartesian?,
  bigNumber?, warnings }`; the converter (`chartConfig(kind, display)` in grafanaDashboardImport.ts) puts
  `cartesian` on line/vertical_bar config.display and `bigNumber` on big_number config.display. Also
  `grafanaColorToHex` (palette names via grafanaThresholds' resolveGrafanaColor, #rgb, #rrggbb(aa), rgb()/rgba()).
- Units: only units with the same meaning map, on line/bar charts, to `display.yAxis[0].format`: percentunit ->
  `percent`, currencyUSD/GBP/EUR/JPY/DKK -> usd/gbp/eur/jpy/dkk. `none` or no unit: nothing. Every other unit
  (ms, percent (0-100; Lightdash percent would show 90 as 9000%), short, bytes...), any unit on big_number/pie/table,
  and units set in field overrides -> `unit-unsupported` warning. Decision: `short` is NOT mapped to Format.SI (not
  verified to render the same); a later feature may revisit.
- Thresholds: big_number gets one `conditionalFormatting` rule per step after the base step, operator
  `greaterThanOrEqual` (Grafana's step applies at >= its value; the feature text says "greaterThan", the check
  matches /greaterThan/), sorted highest first because the first matching rule wins; colours lowercase #rrggbb.
  Base step colour gets no rule. colorMode `none` -> no rules, no warning. Percentage-mode steps, or a step colour
  with no hex (`text`, `transparent`) -> `thresholds-unsupported`. Line/bar with thresholdsStyle.mode not `off` (and
  a value step), or a legacy graph `thresholds` array -> `thresholds-unsupported`. Table/pie thresholds untouched.
- New warning codes in importWarnings.ts: `unit-unsupported`, `thresholds-unsupported` (imp-docs must catalogue
  them; imp-roundtrip-warning-snapshot counts will include them).
- Unit tests: grafanaChartDisplay.test.ts (6 cases).
- Tested as a user: CLI from source on a synthetic dashboard (stat green/orange 1/red 5 unit percent; timeseries CPU
  percentunit with line thresholds; timeseries Latency ms). Error ratio chart YAML: two greaterThanOrEqual rules,
  5 #f2495c then 1 #ff9830. CPU: `display.yAxis: [{format: percent}]`. Latency: no display. IMPORT-REPORT.md:
  unit-unsupported for Error ratio (percent on big_number) and Latency (ms), thresholds-unsupported for CPU.
- Acceptance: dashboard-thresholds-units 3/3, dashboard-panel-kinds 3/3, dashboard-report 4/4. tsc (common),
  oxlint, oxfmt clean.
- 2026-11-09T03:50:30Z supervisor: imp-dashboard-thresholds-units passed the gate in round 1

## imp-dashboard-legend-stacking (round 1)
- eng1799/grafanaChartDisplay.ts now also sets, on line/vertical_bar `config.display`: `legend` (`{position:
  'right'|'bottom', align: 'start'}` from `options.legend.placement`, or legacy `legend.rightSide`) and `stack`
  (StackType: `stack` for normal, `stack100` for percent). Sources, first wins: barchart `options.stacking`,
  timeseries `fieldConfig.defaults.custom.stacking.mode`, legacy graph `stack: true` (+ `percentage: true` ->
  `stack100`). `none`/unset -> no stack key.
- New warnings: `legend-unsupported` (legend hidden via showLegend false / displayMode hidden / legacy legend.show
  false; SQL charts show a legend whenever there is more than one series), `stacking-unsupported` (per-series
  stacking in field overrides `custom.stacking` or legacy `seriesOverrides[].stack`). Added to importWarnings.ts;
  imp-docs must catalogue them, the warning-count snapshot will include them.
- Value mappings on table/pie SQL charts -> `option-dropped` naming `fieldConfig.defaults.mappings` (and
  `fieldConfig.overrides.mappings` when an override sets them). Display warnings now carry `path`; the converter
  skips a display warning whose path droppedPanelOptions already reported (no duplicates for panel types whose
  mapping already marks mappings as dropped).
- Trap: the SQL chart renderer (CartesianChartDataModel.getSpec) reads `display.stack` but ignores
  `display.legend` today (legend shown iff >1 series, default position). The legend is stored per the type
  contract; rendering it is outside this line. grafanaPanelMapping.ts notes still say "Lightdash has no 100%
  stacking" (true for the saved-chart path, not SQL charts); left as is.
- Trap: the CLI loads built @lightdash/common; re-run `bash ./init.sh` after editing common before the check.
- Unit tests: grafanaChartDisplay.test.ts +3 cases (legend/stack mapping, hidden legend + per-series stacking
  warnings, table mappings warnings).
- Tested as a user: CLI from source on a synthetic 4-panel dashboard (the feature's panels). Chart YAML: stacked
  timeseries -> display {legend right/start, stack: stack}; barchart -> vertical_bar {legend bottom, stack:
  stack100}; legacy graph -> line {stack: stack} + legend-unsupported warning; table -> IMPORT-REPORT row
  "option-dropped | Status table | The table panel option fieldConfig.defaults.mappings is not imported...".
- Acceptance: dashboard-legend-stacking 4/4; thresholds-units, panel-kinds, report, dropped-panels, charts all
  pass. tsc (common), oxlint, oxfmt clean.
- 2026-11-09T03:55:07Z supervisor: imp-dashboard-legend-stacking passed the gate in round 1

## imp-dashboard-annotations (round 1)
- grafanaDashboardImport.ts: new `annotationWarnings(source.annotations)` -> one dashboard-level
  `annotations-unsupported` warning per entry of `annotations.list` that is not built in (`builtIn` falsy) and not
  disabled (`enable !== false`). Message names the query and its datasource type: `The annotation query "Deploy
  markers" (prometheus) is not imported: Lightdash dashboards have no annotations`. Missing name -> "Unnamed annotation".
  Hidden (`hide: true`) but enabled queries still warn (Grafana still runs them).
- New code `annotations-unsupported` in importWarnings.ts (imp-docs must catalogue it; warning-count snapshot will
  include it). Warning has no panel, so the IMPORT-REPORT panel cell is blank, like dashboard-link-unsupported.
- Unit tests: grafanaDashboardImport.test.ts +2 cases (built-in and disabled skipped; built-in alone quiet).
- Tested as a user: CLI from source (node --import tsx packages/cli/src/index.ts import grafana-dashboard) on two
  synthetic dashboards (scratch dir since removed). With built-in + "Platform releases" + "Deploy markers": IMPORT-REPORT.md lists
  two annotations-unsupported rows naming each, import-summary byCode annotations-unsupported: 2. Built-in only: no
  annotation mention in report or summary.
- Acceptance: dashboard-annotations 2/2, dashboard-report 4/4. tsc (common), oxlint, oxfmt clean.
- 2026-11-09T03:57:56Z supervisor: imp-dashboard-annotations passed the gate in round 1

## imp-transform-rename-organize (round 1)
- New module `packages/common/src/eng1799/grafanaTransformations.ts`: `applyGrafanaTransformations(transformations,
  {sql, shape}, kind)` -> `{sql, columns, warnings}`. It goes through the panel's transformations in order and skips
  `disabled: true`. Unknown ids are left alone for now: imp-transform-convert-config owns the "unknown transformation
  -> transformation-unsupported" warning. Add the next transformations (filter, calculate, reduce, merge, convert)
  as new `case`s there.
- `renameByRegex`: wraps the SQL as `SELECT <other cols>, regexp_replace(series, '<pattern>', '<repl>'[, 'gi']) AS
  series FROM (<sql>) AS renamed`. This works only for results that have a `series` column (shape `series`:
  timestamp, value, labels; or shape `number`: value, labels). `/pattern/flags` is parsed, and only `g` and `i` are
  kept. The JS replacement is converted to Postgres style: `$1` -> `\1`, `$&` -> `\&`, `$$` -> `$`, and a backslash
  is escaped. An empty regex is a no-op. Any other shape (platform_query, logs) -> `transformation-unsupported`.
- `organize` (tables only): every column named in renameByName, excludeByName or indexByName gets
  `{reference, label, visible, frozen: false, order?}` in `config.columns`, with keys sorted so output is
  deterministic. Columns it doesn't name are left out of the config. On a non-table chart kind ->
  `transformation-unsupported` (unless it names no column).
- `translateGrafanaPanelQueries` now also returns `shape` (type `GrafanaResultShape` is exported, renamed from the
  internal `ResultShape`). `chartConfig` takes the table columns. New warning code `transformation-unsupported` is
  in importWarnings.ts; imp-docs must catalogue it.
- Contract assumptions: the engine's `regexp_replace(str, pattern, replacement[, flags])` follows Postgres: it
  replaces the first match unless the flags include `g`, and the replacement uses `\N` back-references. Grafana
  regexes are JS; the common subset (classes, groups, lookahead) is copied as is.
- Trap: grafanaPanelMapping.ts and docs/eng-1799/grafana-panel-mapping.md still list `transformations` as
  "dropped" (not reported, since NON_OPTION_PANEL_KEYS skips it). imp-docs should update that line.
- Trap: the shell is zsh, so an unquoted `$F` file list doesn't word-split; use an array. Lint with
  `node_modules/.pnpm/node_modules/.bin/oxlint -c .oxlintrc.json` from packages/common.
- Unit tests: grafanaTransformations.test.ts (6 cases).
- Tested as a user: ran the CLI from source on a synthetic dashboard (timeseries with renameByRegex, Postgres
  table with organize). The timeseries SQL wraps promql in regexp_replace(series, '(perc_success.*)',
  'perc_success'). In the table config, jobname has label Job and order 1, status is visible false, and runs has
  order 0. IMPORT-REPORT has no transformation line. Adding organize to the timeseries gives one
  transformation-unsupported row, and import-summary counts it. Scratch dir removed.
- Acceptance: transform-rename-organize 3/3; dashboard-charts, panel-kinds, report, legend-stacking pass. tsc
  (common), oxlint, oxfmt clean.
- 2026-11-09T04:03:54Z supervisor: imp-transform-rename-organize passed the gate in round 1

## imp-transform-filter (round 1)
- grafanaTransformations.ts: new `filterFieldsByName` and `filterByValue` cases. They share a `SqlRewrite` result
  (`{sql}` | `{unsupported}` | null) with renameByRegex, through a small `rewrite` helper in the switch.
- They apply only when the result has no known shape (`translated.shape === undefined`: Postgres or Ops Mart queries,
  whose Grafana field names are the SQL column names). A shaped result (series/number/log) is reported as
  `transformation-unsupported`, because Grafana's fields there are series, not columns.
- filterFieldsByName with `include.names` -> `SELECT "a", "b"\nFROM (<sql>) AS filtered`. Identifiers are double-quoted
  and deduplicated. A pattern, `byVariable` or `exclude.names` needs the query's columns, which the importer doesn't
  know for a hand-written query, so it is reported. The decision: no parsing of the raw SQL select list (the spec
  allows "select or be reported"). An empty include is a no-op.
- filterByValue -> `SELECT *\nFROM (<sql>) AS filtered\nWHERE <cond>`. Matchers: equal(=), notEqual(<>), greater,
  greaterOrEqual, lower, lowerOrEqual, range (exclusive `> from AND < to`, as Grafana does), regex
  (`CAST(col AS VARCHAR) ~ '...'`), isNull, isNotNull. `match: all` joins with AND, anything else with OR. A numeric
  string value is emitted as a number (Grafana compares loosely). Any filter with an unknown matcher or no fieldName
  -> the whole transformation is reported, and the SQL is left as it is.
- Null semantics (decision): Grafana's matchers are false on null, but SQL `NOT (NULL)` drops the row. So exclude writes
  `NOT COALESCE(cond, FALSE)`. The exception is when the condition can't be NULL (only null checks, or `any` with an
  isNull on every compared column), which gives the plain `NOT (range_days = 0 OR range_days IS NULL)` of the spec
  step.
- Contract assumptions: DataFusion (CONTRACTS: Postgres dialect) supports `~`, `CAST(.. AS VARCHAR)`, COALESCE and
  quoted identifiers.
- Trap: the acceptance pattern case also passed before this change, because the report already names every panel
  (datasource-unresolved rows). The unit tests check the real warning.
- Unit tests: grafanaTransformations.test.ts +5 cases (11 total).
- Tested as a user: ran the CLI from source on a synthetic 3-panel Postgres dashboard (scratch dir since removed).
  "Some fields" SQL: SELECT "created_at", "title" FROM (platform_query(...)) AS filtered. "Non-zero ranges": WHERE NOT
  ("range_days" = 0 OR "range_days" IS NULL). "Pattern fields": SQL left as it is, with one transformation-unsupported
  row in IMPORT-REPORT.md naming the panel, also counted in import-summary byCode.
- Acceptance: transform-filter 3/3, transform-rename-organize 3/3. tsc (common), oxlint, oxfmt clean.
- 2026-11-09T04:08:44Z supervisor: imp-transform-filter passed the gate in round 1

## imp-transform-calculate-reduce-merge (round 1)
- grafanaTransformations.ts: new `calculateField`, `reduce` and `merge` cases, and an exported `mergesGrafanaTargets`.
  `applyGrafanaTransformations` now tracks the result shape: a `SqlRewrite` may return a new `shape` (key present =
  changed; `undefined` = named columns), and every case reads the current shape, not the translated one.
- calculateField: binary mode only -> `SELECT *, (<l> <op> <r>) AS "<alias>"\nFROM (<sql>) AS calculated` (only the new
  column with `replaceFields`). Operands: field name (quoted identifier), number or numeric string, and Grafana 11
  `{matcher: {id: byName}}` / `{fixed}`. Operators + - * / % ^ (power()). Alias defaults to Grafana's `l op r`.
  Other modes (reduceRow is Grafana's default when mode is absent), shaped results, missing operands -> reported.
- Decision: division is written `1.0 * "errors" / "total"`, because Grafana divides in floating point and SQL would
  truncate two integer columns to 0. The spec step's `(errors / total) AS ratio` is still visible as a substring.
- reduce: shaped series/number results: seriesToRows (default) -> `SELECT series AS "Field", <agg> AS "<Label>" ...
  GROUP BY series` (shape becomes named columns); reduceFields with one reducer -> number shape (`value, labels,
  series`, GROUP BY labels, series). Reducers: mean, min, max, sum (Total), count, range, distinctCount, first/last
  (series only; ORDER BY "timestamp", as the expressions reducer does). A named-column (Postgres/Ops Mart) query reduces
  only by `count` in seriesToRows -> `SELECT count(*) AS "Count"` (every field's count is the row count; one row
  instead of Grafana's one row per numeric field). Any other reducer, labelsToFields/includeTimeField, log shapes ->
  reported.
- merge: grafanaQuery.ts `translateGrafanaPanelQueries` reads `panel.transformations`; with an enabled merge, targets
  with no known shape (Postgres, Ops Marts) are combined by UNION ALL like same-shaped targets, so no
  panel-targets-not-combined warning. The merge case itself is a no-op. Contract assumption: UNION ALL is positional,
  so merged targets must return the same columns in the same order (Grafana merge's usual use); not checked, since the
  importer doesn't parse the raw SQL. Mixed shapes still warn panel-targets-not-combined.
- Next session (imp-transform-convert-config): `merge`, `calculateField`, `reduce` are now known ids; keep them out of
  the unknown-transformation warning.
- Unit tests: grafanaTransformations.test.ts +7 cases (18 total).
- Tested as a user: ran the CLI from source on a synthetic 5-panel Postgres dashboard (scratch dir since removed).
  Error ratio: `SELECT *, (1.0 * "errors" / "total") AS "ratio" FROM (platform_query(...)) AS calculated`. Run count
  (stat -> big_number): `SELECT count(*) AS "Count" FROM (...) AS reduced`. Merged: two platform_query() selects joined
  by UNION ALL, report has only datasource-unresolved rows for it. Unmerged (same, no merge): still one query plus
  panel-targets-not-combined. Sum reduce: SQL unchanged, one transformation-unsupported row; import-summary counts it.
- Acceptance: transform-calculate-reduce-merge 3/3; transform-filter, transform-rename-organize, dashboard-charts,
  dashboard-report, common query-panel-targets and query-postgres pass. tsc (common), oxlint, oxfmt clean.
- 2026-11-09T04:15:38Z supervisor: imp-transform-calculate-reduce-merge passed the gate in round 1

## imp-transform-convert-config (round 1)
- grafanaTransformations.ts: new `convertFieldType` case, an explicit `configFromData` warning, and the `default`
  case now warns: every enabled transformation id the module doesn't know is a transformation-unsupported warning
  naming it ("The <id> transformation is not imported: the importer has no translation for it; ..."); a missing id
  is named `(unnamed)`. Disabled transformations are still skipped silently.
- convertFieldType (named-column queries only): `SELECT * REPLACE (CAST("f" AS DOUBLE) AS "f", ...)\nFROM (<sql>) AS
  converted`, keeping column order. Types: number -> DOUBLE, string -> VARCHAR, boolean -> BOOLEAN. time (date
  format / epoch ms ambiguity), enum, other, a conversion with no targetField, or a shaped (series/number/log) result
  -> reported. Empty conversions -> no-op.
- Decision: `* REPLACE` is DataFusion/Generic-dialect syntax. Checked: federation-engine leaves
  datafusion.sql_parser.dialect at its default (generic), and sqlparser 0.62's GenericDialect has
  supports_select_wildcard_replace = true. Not executed against a running engine (no cargo build this session).
- Decision: plain CAST, as the spec says; Grafana turns unparsable numbers into null, CAST errors instead. If that
  bites on real dashboards, TRY_CAST is the drop-in change (acceptance regex `cast \(` would still match).
- Trap for later sessions: a new transformation id in a fixture now changes warning counts (roundtrip warning
  snapshot). Fixture ids today: renameByRegex, filterFieldsByName, filterByValue, organize, calculateField,
  configFromData (3), reduce, merge, convertFieldType - all handled.
- Unit tests: grafanaTransformations.test.ts: replaced "leaves unknown as they are" with 3 cases (20 total).
- Tested as a user: CLI from source on a synthetic 3-panel Postgres dashboard (scratch dir removed). Throttles SQL:
  `SELECT * REPLACE (CAST("throttled" AS DOUBLE) AS "throttled") FROM (SELECT * FROM platform_query(...)) AS
  converted`. IMPORT-REPORT.md: one transformation-unsupported row for "Config from data", one for "Matrix" naming
  groupingToMatrix; import-summary byCode transformation-unsupported = 2.
- Acceptance: transform-convert-config 2/2; transform-calculate-reduce-merge, transform-filter,
  transform-rename-organize, dashboard-report, -charts, -panel-kinds, -multi, -command, -todo-tiles pass.
  tsc (common), oxlint, oxfmt clean. Note: the CLI loads built common, so run init.sh after editing common.
- 2026-11-09T04:20:50Z supervisor: imp-transform-convert-config passed the gate in round 1

## imp-cli-grafana-alerts (round 1)
- New `packages/common/src/eng1799/terraformHcl.ts` (exported): a real HCL parser (`parseHcl(text, file)` -> body of
  attributes + blocks with labels and line numbers; `HclSyntaxError` message is `<file>:<line>:<col>: ...`) and a
  never-throwing evaluator (`evaluateHcl(expr, sourceText, {variables, resolve})`). Parses all 17 fixture .tf files.
  Supports strings with `${}`, heredocs (`<<-` strips common indent), tuples/objects (`=`/`:`), traversal, calls,
  unary/binary ops, conditionals, `for` (list/object, `if`, grouping `...`), ~40 functions (jsonencode/jsondecode,
  merge, tolist/toset (sorted), contains, lookup, format, ...). Not supported (syntax error): `%{}` directives, splats.
  What can't be known (data sources, secrets, `var.*`, unknown functions, missing keys) is an `HclUnknown` holding
  the source text; `jsonencode` writes unknowns as null so a model with an unresolved uid stays readable.
- New `packages/common/src/eng1799/grafanaAlertImport.ts` (exported): `convertGrafanaAlerting({rules, contactPoints,
  policy, locals?, folders?, datasources?})` -> `{alertRules, contactPoints, notificationRoutes, warnings}`, plus
  `renderGrafanaAlertsImportReport` and `renderGrafanaRoutingFixes`. `TerraformContext` parses every file once,
  indexes `resource` blocks and `locals` across all files, and resolves `local.x` (lazy, cycle-safe),
  `grafana_data_source.<resource>.uid` (via --datasources, matched by telemetrySourceName(name) == telemetrySourceName(resource label)),
  and `<type>.<name>.<attr>` of any resource without for_each (that is how `grafana_contact_point.x.name` resolves).
  Throws `GrafanaAlertingImportError` (message names the file) for no policy / unresolvable root contact point.
- What this feature converts (minimal, later features extend it):
  - Rule: slug unique (`api-down`, `api-down-2`; never random), name, description = summary else generated +
    `rule-description-generated`, labels (invalid names -> `label-invalid`), annotations, query = the single
    non-`__expr__` data block through `translateGrafanaTarget`, reducer/condition only for reduce(last|mean|max|min|
    sum|count)+threshold gt/lt, or threshold gt/lt straight on the query (reducer last). `paused` = is_paused, and
    anything else (several queries, classic_conditions, ranges, math, unreadable model) -> `paused: true`,
    `PLACEHOLDER_ALERT_QUERY` / `{>, 0}` where untranslated, and one `rule-needs-review` naming the reasons.
    Always `shadow: true`. NOT yet read (silently, on purpose; their features own them): folder_uid/spaceSlug,
    for, interval_seconds, relative_time_range, no_data_state, exec_err_state, notification_settings.
  - Grafana rule groups with `for_each` and `dynamic` blocks are NOT expanded: `terraform-unsupported` warning and
    the group (for_each) / dynamic rules are skipped. imp-alerts-hcl: bind `each.key/each.value` via
    `variables` in `TerraformContext.evaluate` and remove those two warnings. Also `grafana_folder.this["X"].uid`
    currently resolves to unknown (resource has for_each).
  - Contact point: slack -> slack_webhook `{secretRef: <slug>-webhook}` + title/text/disableResolveMessage;
    webhook to api.incident.io -> incident_io with `{secretRef: <slug>-token}`; other webhook -> webhook
    (authorization secretRef `<slug>-authorization` if authorization_credentials); email; anything else ->
    `contact-point-integration-unsupported`; no integration left -> `contact-point-skipped`. Unread attributes
    (e.g. slack `username`) -> one `option-dropped` per integration. Never writes secret values or `local.*`.
  - Routes: root contact point/group_by/timers, children in order with matchers (match -> operator), continue,
    timers, nested policies; route `path` like `grafana_notification_policy.p.policy[0].policy[1]` in warnings.
    Invalid durations and unknown attributes (mute timings...) -> `option-dropped`.
  - ROUTING-FIXES.md says routing defects are not checked yet (routing features replace it). IMPORT-REPORT.md:
    `| Code | Rule or resource | Message |`, one row per warning. import-summary.json `todos` = number of
    rule-needs-review warnings (decision: a rule to review is the alerting counterpart of a dashboard TODO).
- New warning codes in importWarnings.ts: terraform-unsupported, terraform-unresolved, label-invalid,
  rule-needs-review, rule-description-generated, contact-point-integration-unsupported, contact-point-skipped.
- CLI: `packages/cli/src/handlers/importGrafanaAlerts.ts`, registered as `lightdash import grafana-alerts` with all
  options (--rules, --contact-points, --policy, -o/--out required; --locals, --datasources (reuses
  readGrafanaDatasourcesFile), --folders, --routing-decisions, --no-routing-fixes). Every file is read and parsed
  before anything is written; a missing or invalid file exits 1 naming the file. --folders is parsed and indexed
  but not yet used; --routing-decisions is only checked to be a YAML mapping; with either it or
  --no-routing-fixes the CLI prints that routing fixes are not implemented yet. Output folder names come from
  alertingAsCode.ts constants (same layout `upload --alerting-only` reads). Prints
  `Imported N alert rules, M contact points and the notification routes into <out> (W warnings, R rules to review)`.
- Unit tests: terraformHcl.test.ts (13), grafanaAlertImport.test.ts (5).
- Tested as a user: synthetic rule group (API down: reduce last + lt 1), the 5 synthetic contact points with
  jsondecode'd secret locals, a 2-child policy -> 1 rule (promql_instant(..., 'prometheus-production'), last < 1,
  shadow), 5 contact point files, routes tree; all 7 documents valid for validateAlertingAsCode; routeAlert
  {team=infra, severity=critical} -> pager then slack-alerts. Unterminated .tf -> exit 1 "Invalid Terraform in
  .../broken.tf:2:10: unterminated string"; missing file -> exit 1 naming it; contact points file as --policy ->
  exit 1 naming it. Full fixture set (all rule groups, locals, folders, datasources): no crash, 15 rules (for_each/
  dynamic groups skipped with 9 terraform-unsupported), 6 contact points, 22 documents all valid, no secret values.
- Acceptance: alerts-command 3/3; dashboard-command 4/4. tsc (common, cli) clean; oxlint clean on new files;
  oxfmt applied. Pre-existing: oxlint flags packages/common/src/index.ts duplicate `formatPrometheusDuration`
  export (present before this session; see integration notes).
- 2026-11-09T04:35:46Z supervisor: imp-cli-grafana-alerts passed the gate in round 1
