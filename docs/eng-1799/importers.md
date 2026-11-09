# Grafana and Perses importers

Three `lightdash import` commands turn what HouseRx has in Grafana (and Perses) into Lightdash content as code
for the Operations Project: dashboards and SQL charts for `lightdash upload`, and Alert Rules, Contact Points and
Notification Routes for `lightdash upload --alerting-only`. Nothing is dropped silently. Every construct the
importers can't carry over becomes a warning with a code (see the [Warning catalogue](#warning-catalogue)), and
anything that needs a person becomes a TODO.

Terms follow the glossary in [`CONTEXT.md`](../../CONTEXT.md). Grafana's own words (panel, datasource,
notification policy, receiver) are used only for the Grafana side of a mapping.

The importers live in `packages/common/src/eng1799/` (conversion) and `packages/cli/src/handlers/import*.ts`
(the commands). Run `lightdash import <command> --help` for the option list as the CLI has it.

## Usage

### `lightdash import grafana-dashboard`

```sh
lightdash import grafana-dashboard <files...> --out <dir> \
  [--space <slug>] [--datasources grafana_data_sources.tf] [--dashboards-tf grafana_dashboards.tf] \
  [--ops-marts ops-marts.yml] [--no-tabs] [--verbose]
```

Converts Grafana dashboard JSON (the dashboard model, or the API export `{dashboard, meta}`) into dashboard and
SQL chart YAML. Several files can be imported at once; variables the dashboards share are merged into one
`lightdash.config.yml` parameter (`parameter-merged`).

| Option | Meaning |
| --- | --- |
| `-o, --out <dir>` | Required. Folder to write `dashboards/`, `charts/`, `reports/<slug>/IMPORT-REPORT.md`, `lightdash.config.yml` (when the dashboards define parameters) and `import-summary.json` into. |
| `-s, --space <slug>` | Space the dashboards and charts go to. Default `operations`. |
| `--datasources <tf>` | `grafana_data_sources.tf`, to resolve Grafana datasource uids to Telemetry Source names. Without it the Federation Engine's default source is used, with a `datasource-unresolved` warning. |
| `--dashboards-tf <tf>` | `grafana_dashboards.tf`. Each dashboard goes to the space named after its Grafana folder; dashboards at the Grafana root go to `--space`. |
| `--ops-marts <yml>` | YAML mapping GitHub and Sentry query types to Ops Mart tables, for example `github: {Pull_Requests: ops_marts.github.pull_requests}`. Unmapped query types become TODO tiles with a `no-ops-mart` warning. |
| `--no-tabs` | Turn collapsed rows into headings with their tiles below, instead of dashboard tabs. |
| `--verbose` | Print more while importing. |

### `lightdash import grafana-alerts`

```sh
lightdash import grafana-alerts --rules <tf...> --contact-points grafana_contact_points.tf \
  --policy grafana_notification_policy.tf --out <dir> \
  [--locals <tf...>] [--folders grafana_folders.tf] [--datasources grafana_data_sources.tf] \
  [--routing-decisions decisions.yml] [--no-routing-fixes] [--verbose]
```

Converts Grafana alerting Terraform into `alert-rules/`, `contact-points/` and `notification-routes/` YAML. The
HCL is evaluated by the importer: `for_each`, `dynamic` blocks, `locals` and references are expanded, and what
can't be resolved is reported as `terraform-unresolved`.

| Option | Meaning |
| --- | --- |
| `--rules <tf...>` | Required. Terraform files with the `resource "grafana_rule_group"` blocks. |
| `--contact-points <tf>` | Required. Terraform file with the `resource "grafana_contact_point"` blocks. |
| `--policy <tf>` | Required. Terraform file with the `resource "grafana_notification_policy"` block. |
| `-o, --out <dir>` | Required. Folder to write `alert-rules/`, `contact-points/`, `notification-routes/`, `ROUTING-FIXES.md`, `IMPORT-REPORT.md` and `import-summary.json` into. |
| `--locals <tf...>` | Terraform files with the `locals` blocks the other files reference. |
| `--folders <tf>` | `grafana_folders.tf`, the Grafana folders the rule groups reference; each Alert Rule goes to the space named after its folder. |
| `--datasources <tf>` | `grafana_data_sources.tf`, to resolve datasource references to Telemetry Source names. |
| `--routing-decisions <yml>` | Routing decisions the import can't make on its own: `severities: {<value>: <contact point slug>}` and `teams: {<team>: <contact point slug>}`. See [Routing fixes](#routing-fixes). |
| `--no-routing-fixes` | Import the Notification Routes as Grafana has them, without fixing routing defects. `ROUTING-FIXES.md` still lists the defects, marked as not applied. |
| `--verbose` | Print more while importing. |

After importing, copy the three folders into the project's `lightdash/` folder, add the secrets the Contact Points
reference (`secretRef`), and run `lightdash upload --alerting-only`.

### `lightdash import perses-dashboard`

```sh
lightdash import perses-dashboard <files...> --out <dir> [--space <slug>] [--no-tabs] [--verbose]
```

Converts Perses dashboards (JSON or YAML, `kind: Dashboard`) into the same dashboard and SQL chart YAML as the
Grafana dashboard importer. A file that isn't a Perses dashboard fails the command with a clear error.

| Option | Meaning |
| --- | --- |
| `-o, --out <dir>` | Required. Folder to write `dashboards/`, `charts/`, `reports/`, `lightdash.config.yml` and `import-summary.json` into. |
| `-s, --space <slug>` | Space the dashboards and charts go to. Default `operations`. |
| `--no-tabs` | Turn collapsed grids into headings with their tiles below, instead of dashboard tabs. |
| `--verbose` | Print more while importing. |

### What every command writes

- **`IMPORT-REPORT.md`**: every warning with its code and the dashboard, panel or rule it came from, and every
  TODO. The dashboard importers write one per dashboard under `reports/<slug>/`; `grafana-alerts` writes one for
  the whole rule set.
- **`import-summary.json`**: the same warnings in machine-readable form, with `total`, `todos` and `byCode`
  (count per warning code). [`importers-warning-counts.json`](importers-warning-counts.json) is the snapshot of
  these counts from importing every fixture.
- **`ROUTING-FIXES.md`** (`grafana-alerts` only): every routing defect found and its fix.

The command prints a one-line summary (for example "Imported 84 alert rules, 6 contact points and the notification
routes (79 warnings, 11 rules to review)") and exits 0 when the import succeeded, even with warnings.

## Mapping

### Dashboards

| Grafana / Perses | Lightdash |
| --- | --- |
| Dashboard | Dashboard YAML in `dashboards/`, in `--space` or the space of its Grafana folder (`--dashboards-tf`). |
| Panel | One SQL chart per panel in `charts/` and a chart Tile for it. Panel types are mapped as [`grafana-panel-mapping.md`](grafana-panel-mapping.md) lists; a chart type SQL charts don't support falls back to the nearest one (`chart-kind-fallback`). `alertlist`, `dashlist` and `news` panels are dropped (`panel-dropped`). |
| Panel options | Carried as far as the chart kind supports (units, thresholds, legend, stacking, value mappings); the rest is listed in `option-dropped`. [`grafana-panel-mapping.md`](grafana-panel-mapping.md) has every option path. |
| Panel targets | The chart's SQL, reading the Telemetry Source through the Federation Engine: `promql()` for Prometheus, `logql()` for Loki, `cloudwatch()` for CloudWatch metrics (MetricStat, metric math), `cloudwatch_logs()` for Logs Insights, plain SQL for Postgres, and the mapped Ops Mart table for GitHub and Sentry. Several targets share one query when their columns match (`panel-targets-not-combined` otherwise). Grafana expressions (math, reduce, threshold) become SQL over the target queries where they can. |
| Legend format | Series naming in the SQL (`{{label}}` becomes the label column). |
| Transformations | `renameByRegex`, `filterFieldsByName`, `filterByValue`, `calculateField`, `reduce` and `convertFieldType` are applied in the chart SQL; `merge` is already covered by combining the targets; `organize` applies to table charts. The others (`configFromData` among them, and `organize` on other chart kinds) are reported as `transformation-unsupported`. |
| Datasource | Telemetry Source name, resolved through `--datasources`; unresolved ones use the engine's default source. |
| Template variables | Lightdash parameters in `lightdash.config.yml`, referenced as `${ld.parameters.<name>}`. A parameter holds one value, so multi-value and All variables are warned about. |
| `$__from`, `$__to`, `$__interval`, `$__rate_interval`, `$__range`, and Postgres macros such as `$__timeFilter(col)` | The reserved time parameters (`${ld.parameters.__from}`, `__to`, `__interval`, `__range`), so every telemetry Tile follows the Dashboard Time Range. Other macros (for example `$__auto`) are left as written with `query-macro-unsupported`. |
| Time range and refresh | The Dashboard Time Range (relative or absolute); refresh moves to the nearest interval Lightdash offers (`refresh-adjusted`). |
| Grid layout (24 columns) | Tile positions scaled to Lightdash's 36 columns. |
| Row | A heading Tile above its panels. A collapsed row becomes a dashboard tab (or a heading with `--no-tabs`). |
| Text panel | Markdown Tile. |
| Links | Panel links go into the chart description and dashboard links into the dashboard description, as markdown links. A link without a URL, or a tag-based dashboard list, is named there without a URL and reported. |
| Annotations | Not imported (`annotations-unsupported`). |
| Untranslatable query | A TODO Tile saying what to write by hand, listed under TODO in `IMPORT-REPORT.md`. |

Perses dashboards go through the same panel mapping: `TimeSeriesChart`, `BarChart`, `StatChart`, `GaugeChart`,
`Table` and `Markdown` panels map like their Grafana counterparts, `PrometheusTimeSeriesQuery` queries become
`promql()` SQL, Perses variables become parameters, `duration`/`refreshInterval` become the Dashboard Time Range,
and Grid layouts scale from 24 to 36 columns (an open titled grid becomes a heading, a collapsed grid a tab).
Other plugins are reported as `perses-plugin-unsupported`.

### Alerting

| Grafana (Terraform) | Lightdash |
| --- | --- |
| `grafana_rule_group` rule | An Alert Rule document in `alert-rules/` with `shadow: true`: every imported rule starts in the Shadow Run (ADR 0003). Query, reducer, condition (threshold or classic condition), `for`, interval, no-data and error states, labels and annotations carry over. Math over several queries becomes one SQL query. A rule whose query or condition can't be translated is still written, valid and paused, with `rule-needs-review`. The description comes from the `summary` annotation, or is generated (`rule-description-generated`). |
| `grafana_contact_point` | A Contact Point document in `contact-points/`: Slack webhooks as `{secretRef: <slug>-webhook}`, incident.io as an `incident_io` integration with its token as a secret reference. Integrations Lightdash has no type for are reported. |
| `grafana_notification_policy` | The `notification_routes` document: the root's default Contact Point, grouping and timers, and one Notification Route per policy with its matchers, Contact Point, `continue`, grouping and timers. |
| Rule `notification_settings` (simplified routing) | The rule gets a `notify=<contact point slug>` label and the tree gets a matching `notify = <slug>` Notification Route, so the rule still reaches only that Contact Point. |

## Warning catalogue

Every code the importers can emit, from `ImportWarningCode` in
[`packages/common/src/eng1799/importWarnings.ts`](../../packages/common/src/eng1799/importWarnings.ts). The counts
are from importing every fixture ([`importers-warning-counts.json`](importers-warning-counts.json)): **D** is
`grafana-dashboard` (all 32 dashboards), **A** is `grafana-alerts` (the full rule set) and **P** is
`perses-dashboard`. A blank count means the fixtures don't produce the code.

### Telemetry Sources and queries

| Code | D | A | P | Meaning |
| --- | ---: | ---: | ---: | --- |
| `datasource-unsupported` | | | | The target's datasource type has no translation; the Tile becomes a TODO. |
| `datasource-unresolved` | 10 | 2 | 6 | The datasource couldn't be resolved to a Telemetry Source; the engine's default source is used, or a TODO is written. |
| `query-empty` | 1 | | | A target has no expression. |
| `panel-targets-not-combined` | 10 | | | A target returns other columns than the panel's first query, so it can't share the chart's result; add it as its own chart. |
| `query-instant-dropped` | | | | A Prometheus target asks for both a range and an instant query; only the range query is imported. |
| `query-limit-invalid` | | | | A Loki `maxLines` isn't a positive whole number; the default limit is used. |
| `query-direction-unsupported` | | | | A Loki direction Lightdash doesn't support; the default direction is used. |
| `query-cloudwatch-unsupported` | | | | A CloudWatch logs query in a language other than Logs Insights. |
| `query-cloudwatch-math-unsupported` | | | | CloudWatch metric math that can't be translated. |
| `query-cloudwatch-math-periods` | | | | Metric math over inputs with different periods; only shared timestamps have a value. |
| `query-region-unsupported` | 141 | 19 | | The query names a region; the region of the Telemetry Source is used. |
| `query-period-auto` | 151 | | | A CloudWatch automatic period; a fixed default period is used. |
| `query-period-invalid` | 47 | | | A CloudWatch period that isn't seconds or a duration; the default is used. |
| `query-statistic-missing` | | | | A CloudWatch query with no statistic; the default statistic is used. |
| `query-statistics-dropped` | 4 | | | Several statistics in one query; only the first is imported. |
| `query-dimension-wildcard` | 35 | | | A `*` dimension value, which a MetricStat can't express; the dimension is left out. |
| `query-dimension-values-dropped` | | 4 | | Several values for one dimension; only the first is imported. |
| `query-match-exact-dropped` | 102 | 8 | | Match exact off; a MetricStat matches the listed dimensions exactly. |
| `query-macro-unsupported` | 2 | 2 | | A Grafana macro with no Lightdash time parameter (for example `$__auto`); the text is kept and needs editing. |
| `no-ops-mart` | 17 | | | A GitHub or Sentry query type with no Ops Mart mapped in `--ops-marts`; the Tile becomes a TODO. |
| `ops-mart-invalid` | | | | The mapped Ops Mart isn't an `ops_marts.<dataset>.<table>` name. |
| `ops-mart-filters-dropped` | | | | The Ops Mart query's filters aren't applied; filter the table in SQL by hand. |
| `expression-unsupported` | 7 | 1 | | A Grafana expression (math, reduce, resample, threshold) that can't be translated. |
| `expression-hysteresis-dropped` | | | | A threshold's recovery threshold; the Alert Rule resolves when the condition is no longer met. |

### Variables and parameters

| Code | D | A | P | Meaning |
| --- | ---: | ---: | ---: | --- |
| `variable-undefined` | 6 | | | The query uses a variable the dashboard doesn't define; the text is kept and needs editing. |
| `variable-unsupported` | | | | A variable type with no Lightdash parameter. |
| `variable-multi-value` | 55 | | | A multi-value or All variable; the parameter holds one value at a time. |
| `variable-format-ignored` | | | | A variable format (`${var:csv}` and so on); the plain value is used. |
| `parameter-default-adjusted` | 9 | | | A variable set to All or auto in Grafana, which has no single Lightdash value; the parameter starts at a concrete value. |
| `parameter-merged` | 5 | | | Two dashboards define the same variable differently; `lightdash.config.yml` has one parameter. |

### Panels, charts and dashboards

| Code | D | A | P | Meaning |
| --- | ---: | ---: | ---: | --- |
| `panel-type-unsupported` | 1 | | | A Grafana panel type with no Lightdash equivalent. |
| `perses-plugin-unsupported` | | | 1 | A Perses panel plugin with no Lightdash equivalent. |
| `panel-dropped` | 3 | | | A panel that is deliberately not imported (`alertlist`, `dashlist`, `news`, or a Perses panel in no layout). |
| `option-dropped` | 3093 | 6 | 1 | Panel or rule options the target can't carry, listed by path. Most of the dashboard total. |
| `chart-kind-fallback` | 133 | | 2 | The panel maps to a chart type SQL charts don't support; the nearest SQL chart type is used. |
| `unit-unsupported` | 170 | | 2 | A unit with no SQL chart number format; values show as plain numbers. |
| `thresholds-unsupported` | 12 | | | Thresholds the chart can't express (for example percentage thresholds on a big number). |
| `legend-unsupported` | 9 | | | A hidden legend; SQL charts show the legend whenever there is more than one series. |
| `stacking-unsupported` | | | | Mixed stacking; SQL charts stack all series or none. |
| `link-unsupported` | | | | A panel link without a URL. |
| `dashboard-link-unsupported` | 1 | | | A dashboard link that can't be carried over (for example a tag-based dashboard list). |
| `annotations-unsupported` | 2 | | | Dashboard annotations, which aren't imported. |
| `transformation-unsupported` | 8 | | | A Grafana transformation with no SQL translation. |
| `time-range-adjusted` | | | | A time range bound moved to one the Dashboard Time Range supports. |
| `time-range-unsupported` | | | | A time range that can't be read; the Dashboard Time Range isn't set. |
| `refresh-adjusted` | 1 | | | A refresh moved to the nearest interval Lightdash offers. |
| `refresh-unsupported` | | | | A refresh that isn't a duration; auto-refresh is off. |

### Terraform and alerting

| Code | D | A | P | Meaning |
| --- | ---: | ---: | ---: | --- |
| `terraform-unsupported` | | | | A Terraform construct the importer doesn't carry (for example more than one `notification_settings` block). |
| `terraform-unresolved` | | 3 | | A reference, `for_each` or `dynamic` block that can't be resolved from the files given. |
| `label-invalid` | | | | A label or annotation key that isn't a valid name; it is not imported. |
| `rule-needs-review` | | 11 | | The Alert Rule is imported paused because its query or condition couldn't be translated; write them by hand, then unpause it. |
| `rule-description-generated` | | 6 | | No `summary` annotation; the description was generated from the title and query. |
| `rule-null-handling-changed` | | 10 | | A classic condition counted null values; the imported count reducer ignores them. |
| `rule-state-changed` | | | | A no-data or error state Lightdash has no equivalent for (for example `exec_err_state = OK`); the nearest state is used. |
| `contact-point-integration-unsupported` | | | | A Contact Point integration other than Slack, incident.io, email or webhook. |
| `contact-point-skipped` | | | | A Contact Point with no integration the importer can import. |
| `routing-needs-decision` | | 7 | | A routing fix that needs a decision in `--routing-decisions` (an unhandled severity or a team with no route). |
| `routing-decision-unused` | | | | A routing decision no imported rule needs. |

## Routing fixes

ADR 0003 ([`docs/adr/0003-big-bang-grafana-cutover.md`](../adr/0003-big-bang-grafana-cutover.md)) retires
Grafana in a single Cutover after a Shadow Run, and says known routing bugs are fixed during migration rather than
reproduced. During the Shadow Run every imported Alert Rule (`shadow: true`) is evaluated in Lightdash without
notifying anyone, and its firings are compared with Grafana's. Because the routing is fixed, that comparison is
against a written list of expected routing differences, not exact parity. `ROUTING-FIXES.md` is that list.

`grafana-alerts` finds the defects by routing every imported Alert Rule's labels through the imported Notification
Route tree (`packages/common/src/eng1799/grafanaRoutingFixes.ts`). Every check is driven by the labels the rules
actually carry, so a fix only changes routing for alerts those rules raise. Every fix keeps the Contact Points an
alert reaches today and only adds to them, which is why fixes use `continue: true` and never remove a route. The
fixes are applied to `notification-routes/` (and to rule labels) unless `--no-routing-fixes` is given; the list is
written either way.

There are four defect classes, one section each in `ROUTING-FIXES.md`:

1. **Unreachable route.** An alert stops at the first matching sibling Notification Route without `continue`, so a
   later sibling that also matches a rule's labels is never reached for it: either an earlier, broader matcher
   catches it first (matcher order) or an earlier route on another label lacks `continue`. Fix: set
   `continue: true` on the earlier route, so the alerts keep their current Contact Point and also reach the
   shadowed one.
2. **Unhandled severities.** A `severity` value rules carry that no route matches on. If `--routing-decisions`
   names a Contact Point for the value (`severities:`), the fix adds a severity route with `continue: true`;
   otherwise the value is listed as needing a decision (`routing-needs-decision`).
3. **Unreached contact point.** An imported Contact Point that no route, the root's default included, names, so no
   alert can reach it. Fix: add a `notify = <contact point slug>` route with `continue: true`. A rule opts in by
   carrying the `notify` label and keeps the rest of its routing. This is the same `notify` label that rules using
   Grafana's simplified routing (`notification_settings`) get.
4. **Default route only.** A rule whose alerts match no route, so they reach only the root's default Contact
   Point. If a route matches on the rule's `team` but needs other labels the rule lacks, the fix adds those labels
   to the rule. If no route matches on its team, a team `--routing-decisions` names (`teams:`) gets a team route
   with `continue: true`; otherwise the proposed route needs a decision (`routing-needs-decision`). A rule with no
   team label stays on the default route.

On today's fixtures this finds exactly the defects ADR 0003 names, plus the unhandled severities:

- pg_cron's rules carry `team = engineering` without the route's `channel = #alerts`, so they fell through to
  #infra-alerts. The fix adds `channel = #alerts` to the rules (default route only).
- `team = Support` rules have no team route and fell through to #infra-alerts. The fix proposes a `team = Support`
  route that needs a decision (default route only).
- `slack-sec` received nothing. The fix adds a `notify = slack-sec` route (unreached contact point).
- Severity values `1`–`4`, `critical` and `low` have no severity route; each needs a decision (unhandled
  severities).
- No route is unreachable for the imported rules.

The fixes were chosen to be **deterministic**: they depend only on the input files and `--routing-decisions`,
never on guesses about intent, and two runs over the same input give byte-identical `ROUTING-FIXES.md` and
`notification-routes/`. Where a fix would need a choice the Terraform doesn't make (which Contact Point a severity
or a team should page), the importer doesn't guess: it writes the proposed route as needing a decision, emits
`routing-needs-decision`, and the decision goes into a `--routing-decisions` file that is re-run through the
importer. A decision no rule needs is reported as `routing-decision-unused`.
