# Telemetry charts in Lightdash (ENG-1799 viz)

This page covers the chart side of ENG-1799 in HouseRx's Lightdash fork:

- two **native** chart types, `log_stream` and `trace_waterfall`;
- the **HouseRx chart registry** (`chart-registry/`), six data-app viz entries, and how to build and host it;
- small additions to built-in charts: cartesian thresholds, table value mappings and Grafana units;
- the **Grafana panel mapping**, which says where each Grafana panel lands in Lightdash;
- the **contract assumptions** this line made where `docs/eng-1799/CONTRACTS.md` left a gap.

The spec is `CONTEXT.md`, `docs/adr/0001-0004` and [`CONTRACTS.md`](CONTRACTS.md). In Lightdash terms, a dashboard
holds **Tiles**. "Panel" on this page only ever means Grafana's concept.

## Native or registry: the ee/ typecheck measurement

ADR scope item 1 asked whether log stream and trace waterfall could be native chart types without touching any
`ee/` code (Q14: `packages/*/src/ee/**` is never modified). On 2026-11-08 the init session measured it on a scratch
copy. It added `LOG_STREAM`/`TRACE_WATERFALL` to `ChartKind` and `ChartType` and config types to the `ChartConfig`
union, then ran the common, warehouses, backend and frontend typechecks:

- With only `ChartConfig` extended, one `ee/` file failed to typecheck:
  `packages/backend/src/ee/services/ai/utils/chartAsCode.ts` (TS2322, `ChartConfig` no longer assignable to
  `ChartAsCodeConfig`).
- Adding both config types to the non-ee union `ChartAsCodeConfig`
  (`packages/common/src/types/contentAsCode/charts.ts`), which chart-as-code needs anyway, fixed it. After that **no
  file under any `ee/` directory fails the typecheck**.
- The enum members alone also break the protected test
  `packages/backend/src/ee/services/AiAgentToolsService/AiAgentToolsService.documents.test.ts` unless every
  `ChartType` member has a `ChartConfig`/`ChartAsCodeConfig` member, so the members and the unions land together.

**Decision: both types are native.** The regression gate keeps it true: `pnpm -F common typecheck`,
`pnpm -F warehouses typecheck`, `pnpm -F backend typecheck`, `pnpm -F frontend typecheck` and
`pnpm -F visualization typecheck` stay green with no `ee/` change.

Where the code lives:

| Layer         | What                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| common        | `ChartType.LOG_STREAM`, `ChartType.TRACE_WATERFALL`; config types in `packages/common/src/eng1799/` (`logStream.ts`, `traceWaterfall.ts`)          |
| backend       | a `chart_types` migration adding `log_stream` and `trace_waterfall`; no other backend code                                                         |
| visualization | `renderChart` returns `{kind: 'logStream', model}` and `{kind: 'traceWaterfall', model}` (`packages/visualization/src/render.ts`)                  |
| frontend      | `LogStreamView`, `TraceWaterfallView` and their config panels, mounted in `LightdashVisualization` and the chart type gallery                      |
| chart-as-code | `$defs.LogStreamChart` and `$defs.TraceWaterfallChart` in `chart-as-code-1.0.json`, so both types round-trip through `lightdash download`/`upload` |

## Log stream (`log_stream`)

A log stream shows one row per log line, like Grafana's logs panel. It is meant for Loki-style results: a timestamp,
a line, an optional level and a labels object.

**Config** (`LogStreamChart`, exactly these eight properties, all optional):

| Property           | Default | Meaning                                 |
| ------------------ | ------- | --------------------------------------- |
| `lineFieldId`      | by name | the log text                            |
| `timestampFieldId` | by name | the line's time                         |
| `levelFieldId`     | by name | the level column                        |
| `labelsFieldId`    | by name | a JSON object of labels                 |
| `wrapLines`        | `false` | wrap long lines instead of scrolling    |
| `newestFirst`      | `true`  | sort order                              |
| `showLabels`       | `false` | show `key=value` labels under each line |
| `levelColors`      | Grafana | per-level colour overrides              |

With no field ids set, columns bind by name: a field id equal to `timestamp`, `line`, `level` or `labels`, or ending
in `_<name>`.

**Levels.** Raw levels are trimmed and matched case-insensitively. Aliases fold in (`emerg`/`alert`/`crit`/`fatal` →
critical, `err`/`eror` → error, `warn` → warning, `information`/`informational`/`notice` → info, `dbug` → debug), and
anything else is `unknown`. With no level column, the level comes from label `level`, then `detected_level`. The
colours are Grafana's classic ones: critical `#705DA0`, error `#E24D42`, warning `#EAB839`, info `#7EB26D`, debug
`#1F78C1`, trace `#6ED0E0`, unknown `#8E8E8E`.

**View.** Rows are virtualised, so large results scroll smoothly. Each row has a level colour bar, the timestamp and
the line, and expands to show its details. A filter box matches the line text and shows "N of M lines". "Download
CSV" exports the shown lines as `timestamp,level,line,labels`, with labels as JSON. Full-result exports use the
backend CSV path, which already writes json columns as JSON. The config panel has the field pickers, the "Wrap
lines", "Newest first" and "Show labels" switches, and a colour input per level.

## Trace waterfall (`trace_waterfall`)

A trace waterfall draws the spans of one trace as bars on a shared time axis, nested under their parents, like
Grafana's traces panel. It is meant for Tempo-style span rows.

**Config** (`TraceWaterfallChart`): optional field ids `traceIdFieldId`, `spanIdFieldId`, `parentSpanIdFieldId`,
`serviceFieldId`, `nameFieldId`, `startFieldId`, `durationMsFieldId`, `statusFieldId`, `attributesFieldId`. Unset
ids bind by name: `trace_id`, `span_id`, `parent_span_id`, `service`, `name`, `start`, `duration_ms`, `status`,
`attributes`.

**Model.**

- Traces come in row order of first appearance. Spans are in depth-first order, children sorted by start.
- The trace window runs from the earliest root start to the latest root end.
- A span whose parent is not in the results is an **orphan**. It is drawn as a root and flagged.
- A child that runs outside its parent's window (clock skew) is **clamped** into it and flagged. The reported duration
  is kept for the drawer.
- Each service gets one colour across the whole result, so a service keeps its colour when you switch traces.

**View.** One row per span with an indented name and a bar positioned in % of the trace window. There is a time axis
from "0 ms", and a service legend. Error spans (`error` or `STATUS_CODE_ERROR`) are marked. Spans with children have
"Collapse"/"Expand" buttons. Clicking a span name opens a drawer with name, service, status, duration, span id, every
attribute, and a clock-skew note when clamped. With several traces in the results, a "Trace" picker chooses one; the
first trace is shown by default. The config panel has one picker per field.

## Built-in chart additions

- **Cartesian thresholds.** `CartesianChart.thresholds` takes Grafana-style steps plus a style (`line`, `dashed`,
  `area`, `line+area`, `dashed+area`). Lines draw at each step; areas shade each band in its step colour. The
  cartesian config has a thresholds editor.
- **Table value mappings.** `ColumnProperties.valueMappings` takes Grafana's mappings (`value`, `range`, `regex`,
  `special`). Matching cells show the mapped text; raw values still drive sorting and export. The column config has a
  value mappings editor.
- **Grafana units.** `grafanaUnitToCustomFormat(unit, {decimals})` turns a Grafana unit id (`ms`, `percentunit`,
  `bytes`, `reqps`, ...) into a Lightdash custom format.

The shared helpers are in `packages/common/src/eng1799/` (`thresholds.ts`, `valueMappings.ts`, `grafanaUnits.ts`).

## The HouseRx chart registry

`chart-registry/` is a pnpm workspace package that builds data-app viz entries into a static site that Lightdash's
`ChartRegistryClient` reads. It covers the Grafana visualizations Lightdash has no built-in chart for.

| Slug             | Fields                                         | Options                                                                                |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `heatmap`        | `time`, `bucket`, `value`                      | `colorScale`                                                                           |
| `state-timeline` | `time`, `series`, `state`                      | `valueMappings`                                                                        |
| `stat-sparkline` | `value` (required), `time` (optional)          | `unit`, `decimals`, `reducer`, `thresholds`, `valueMappings`, `graphMode`, `colorMode` |
| `bar-gauge`      | `name`, `value`                                | `orientation`, `displayMode`, `min`, `max`, `thresholds`, `unit`                       |
| `histogram`      | `value`                                        | `bucketCount`                                                                          |
| `status-grid`    | `series`, `value` (latest row per series wins) | `thresholds`, `valueMappings`, `columns`                                               |

`thresholds` and `valueMappings` are text options holding Grafana's own JSON, so the dashboard importer can copy a
panel's settings verbatim. Units use Grafana's unit ids.

**Layout.** A chart is a folder `chart-registry/src/charts/<slug>/` with `registry.json` (name, description,
version, publishedAt, changelog, tags, icon, vizSchema, preview rows) and `index.ts`. Shared code is in
`chart-registry/src/shared/` (the viz-context protocol and helpers). Adding a chart means adding a folder; the build
script does not change. Every entry is tagged `houserx` and has `preview.rows`.

### Build

```sh
pnpm -F chart-registry build
```

This runs `tsx scripts/build.ts`. It wipes `chart-registry/dist/` and writes:

```
chart-registry/dist/
  index.json                       # stable channel: every chart's latest version
  index-next.json                  # next channel: the same charts
  charts/<slug>/<version>/
    entry.json                     # the version snapshot
    source.tar                     # src/... the entry was bundled from
    dist.tar                       # dist/index.html + dist/assets/* (IIFE bundle, CSP-safe)
    screenshot-*.png               # when the chart ships screenshots
```

The build validates every entry with the backend's own parsers (`parseChartRegistryVersionSnapshot`,
`parseChartRegistryIndexTolerant`) and fails if anything would be dropped. Tars are deterministic, so rebuilding an
unchanged chart gives the same digests. **Published versions are immutable**: bump `version` and `publishedAt` in
`registry.json` for any change to a chart. `chart-registry/dist/` is gitignored.

### Host the registry

Hosting is static files; there is no server code. Copy `chart-registry/dist/` as is to any https static host (a
bucket behind a CDN or an internal web server). Then point Lightdash at it:

| Variable                                        | Value                                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIGHTDASH_CHART_REGISTRY_URL`                  | the base URL that serves `index.json` (a trailing `/` is trimmed). Unset uses the official Lightdash library; an empty value disables the chart library. |
| `LIGHTDASH_CHART_REGISTRY_CHANNEL`              | `stable` (default) reads `index.json`; `next` reads `index-next.json`                                                                                    |
| `LIGHTDASH_CHART_REGISTRY_ALLOW_PRIVATE_HOSTS`  | `true` for an internal mirror on a private address. Transport stays https-only and the connection stays pinned.                                          |
| `LIGHTDASH_CHART_REGISTRY_AUTHORIZATION_HEADER` | a full `Authorization` header value, if the host needs one                                                                                               |
| `LIGHTDASH_CHART_REGISTRY_ALLOW_INSECURE`       | local development only: allows http and loopback and skips pinning. Never in a deployed environment.                                                     |

What the host must do:

- Serve over **https** with a public certificate. Plain http only works with `ALLOW_INSECURE`, and
  `ALLOW_PRIVATE_HOSTS` alone still requires https.
- Serve `index.json` and `index-next.json` at the base URL, and every file under `charts/` at its relative path.
  Keep the index under 8 MiB and each artifact under 50 MiB (the client's limits).
- Serve screenshots as `image/png`, `image/jpeg`, `image/webp` or `image/gif`, or as `application/octet-stream` (the
  client sniffs the bytes). Any other content type, SVG included, is refused. Tars and JSON can use their usual types;
  their digests are checked against `entry.json`.
- Never overwrite a published `charts/<slug>/<version>/` folder. Upload new versions next to old ones, and upload
  the index files last so the index never points at missing files.

The chart library UI and installs also need the `ChartTypeRegistry` feature flag and the app runtime's S3 store;
those are part of the Lightdash deploy, not the registry host. Setting up the bucket and the variable in HouseRx's
environments is a later content task and is not done by this line.

**Try it locally.** Build, serve `chart-registry/dist/` over http on a loopback port, and start the backend with
`LIGHTDASH_CHART_REGISTRY_URL=http://127.0.0.1:<port>` and `LIGHTDASH_CHART_REGISTRY_ALLOW_INSECURE=true`. The
acceptance test `chart-registry/tests/acceptance/client-install.test.ts` does the same against the real client.

## Grafana panel mapping

The full mapping is [grafana-panel-mapping.md](grafana-panel-mapping.md). It has one row per Grafana panel type and
one row per panel option path used by HouseRx's 32 dashboards. Its source of truth is the typed module
`packages/common/src/eng1799/grafanaPanelMapping.ts` (`getGrafanaPanelMapping`, `getGrafanaPanelOptionMapping`),
which the dashboard importer reads.

In short:

- `timeseries`, `graph` and `barchart` become cartesian charts; `gauge`, `piechart`, `table` and `table-old` become
  the matching built-in charts.
- `logs` becomes a native `log_stream` chart.
- `stat` becomes the `stat-sparkline` registry entry and `bargauge` the `bar-gauge` entry.
- `text` becomes a markdown Tile and `row` a heading Tile.
- `alertlist`, `dashlist` and `news` are dropped, with reasons.

No panel in today's dashboards needs `heatmap`, `state-timeline`, `histogram` or `status-grid`. They are in the
registry for the Grafana visualizations of the same names, for hand-built charts and for future imports.

## Contract assumptions

Where `CONTRACTS.md` left a gap, this line took the narrowest compatible reading. The integration line should
reconcile these:

1. Both types are native: no `ee/` file breaks once `ChartAsCodeConfig` includes them (measurement above).
2. CONTRACTS §1 "plus `level` when present": with no level column, the level comes from label `level`, then
   `detected_level`, then `unknown`.
3. `labels` and `attributes` arrive as objects (pg parses `json`, OID 114) or as JSON text; both are accepted. `start`
   and `timestamp` arrive as Date or ISO strings.
4. When results hold several traces, the first trace in row order is shown, with a Trace picker.
5. The log stream's CSV export is client-side over the loaded lines, after the filter. Full-result exports keep using
   the backend CSV path, which already writes json columns as JSON.
6. Registry `thresholds` and `valueMappings` options take Grafana's JSON shapes as text, so the importer can copy them.
   `index-next.json` lists the same charts as `index.json`.
7. Lightdash byte formats need an explicit compact unit, so Grafana's auto-scaled `bytes`/`Bps` map to the
   `bytes_iec`/`bytes_si` family only, and values stay in raw bytes. Byte rates lose their "/s". These gaps are listed
   in `packages/common/src/eng1799/grafanaUnits.ts`.
8. The `bar-gauge` entry's `min`/`max` default to 0/100, because the viz schema needs a numeric default and can't say
   "auto from data". The importer should copy a panel's min/max when it sets them.
9. The `heatmap` entry draws bucket values as given. Prometheus `_bucket` series are cumulative, so the query should
   return per-bucket counts or rates.
