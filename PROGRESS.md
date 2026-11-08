# ENG-1799 line `viz`: progress and handbook

This line builds telemetry chart types for HouseRx's Lightdash fork: two **native** chart types (`log_stream`,
`trace_waterfall`), the **HouseRx chart registry** (`chart-registry/`, six data-app viz entries), the **Grafana panel
mapping** (doc and typed module), and small **built-in chart additions** (cartesian thresholds, table value mappings,
Grafana units). Every session starts with an empty memory, so read this whole file before you change anything.

Read first: `CONTEXT.md` (glossary: say **Tile**, never "panel", for a dashboard item; "panel" only names Grafana's
concept), `docs/adr/0001-0004`, `docs/eng-1799/CONTRACTS.md`.

## How to run things

| What | Command (from the repo root) |
|---|---|
| Prepare the tree (install, build `formula`, `common`, `warehouses`, `visualization` when changed) | `bash ./init.sh` (about 1 s when nothing changed) |
| One feature's acceptance check | the `check` of the feature in the feature list |
| Common test file | `pnpm -F common exec vitest run src/__acceptance__/viz/<file>.test.ts` |
| Frontend test file | `pnpm -F frontend exec vitest run src/__acceptance__/viz/<file>.test.tsx` |
| Backend test file | `pnpm -F backend exec vitest run --config vitest.config.ts src/__acceptance__/viz/<file>.test.ts` |
| Registry test file | `bash chart-registry/tests/acceptance/run.sh <file>.test.ts` (builds the registry first) |
| Regression gate (keep green) | `pnpm -F common typecheck && pnpm -F warehouses typecheck && pnpm -F backend typecheck && pnpm -F frontend typecheck` (plus `pnpm -F visualization typecheck`) |
| Chart-as-code schema in sync | `pnpm -F common check:chart-as-code-schema` |

- `init.sh` never starts a server. That is required by `specs/goal-common.md`: tests start what they need on
  ephemeral ports and stop it themselves. There is no app to "start" for these checks.
- After you change `packages/common`, `formula`, `warehouses` or `visualization`, run `bash ./init.sh` before running
  frontend or backend tests. Frontend vitest (`NODE_ENV=test`) resolves `@lightdash/common` and
  `@lightdash/visualization` from their **dist**, not src. Checks always run after `init`, so they see your rebuild.
- Stamps for `init.sh` live in `tmp/init-stamps/`. `tmp/` is gitignored, and so are `/chart-registry/dist/` and the
  throwaway Postgres clusters.
- The whole frontend vitest suite is red upstream (123 files: `src/testing/testUtils.tsx` mocks paths that don't exist).
  Never use `renderWithProviders`. Render with `<MantineProvider env="test" forceColorScheme="light">` only (the
  acceptance `fixtures.tsx` has `renderWithMantine`), keep components under test presentational, and run single files.

## Protected folders (you cannot edit these)

`packages/common/src/__acceptance__/viz/**`, `packages/frontend/src/__acceptance__/viz/**`,
`packages/backend/src/__acceptance__/viz/**`, `chart-registry/tests/acceptance/**`, and every `packages/*/src/ee/**`.
The acceptance tests there fix the public names below. Build to them. If a test truly can't pass, stop and say why;
don't work around it.

## Measurement (scope item 1), done by the init session on 2026-11-08

On a scratch copy, the init session added `LOG_STREAM`/`TRACE_WATERFALL` to `ChartKind` and `ChartType`, and config
types to the `ChartConfig` union. It then ran the common, warehouses, backend and frontend typechecks, and reverted.

- With **only** the `ChartConfig` union extended, one `ee/` file broke: `packages/backend/src/ee/services/ai/utils/chartAsCode.ts`
  (TS2322: `ChartConfig` is no longer assignable to `ChartAsCodeConfig`). Adding both config types to the non-ee union
  `ChartAsCodeConfig` in `packages/common/src/types/contentAsCode/charts.ts`, which chart-as-code needs anyway, fixes it.
- With that union extended too, **no file under any `ee/` directory breaks**. **Decision: both types are native.**
- Non-ee files that break and need a case (find them again with the typechecks, not by hand):
  - common: `src/types/savedCharts.ts` (`getChartKind`, also add `getChartType` cases), `src/pivot/derivePivotConfigFromChart.ts`
  - backend: `src/services/RenameService/rename.ts`
  - frontend: `src/components/Explorer/VisualizationCard/VisualizationConfig.tsx`,
    `src/components/LightdashVisualization/VisualizationProvider.tsx`,
    `src/features/chartTypes/utils/savedChartPreviewFieldMapping.ts`, `src/features/explorer/store/explorerSlice.ts`,
    `src/features/visualization/store/buildInitialState.ts`, `src/providers/Explorer/utils.ts` (and `types.ts`,
    `ConfigCacheMap`)
  - not typechecked by the regression gate but switching on chart type: `packages/visualization/src/render.ts`
    (`resolveChart`/`buildChart`). Run `pnpm -F visualization typecheck` too.
- The checklist for a new chart type is `packages/frontend/src/components/LightdashVisualization/AGENTS.md`. Follow it,
  including the `chart_types` migration (pattern: `20260309094418_add_sankey_chart_type.ts`).
- `pnpm install --frozen-lockfile` and the builds work offline from the local pnpm store (Node 24.22.1 is fetched by
  pnpm's `devEngines`). All four typechecks were green on the untouched tree.

## Architecture and the names the acceptance tests use

### Common (`packages/common`): new code in `src/eng1799/`, everything re-exported from `src/index.ts`

| Export | Where | Notes |
|---|---|---|
| `ChartType.LOG_STREAM = 'log_stream'`, `ChartType.TRACE_WATERFALL = 'trace_waterfall'`, same in `ChartKind` | `types/savedCharts.ts` (registration lines only) | `getChartType`/`getChartKind` round-trip |
| `LogStreamChart`, `LogStreamChartConfig` (`{type: LOG_STREAM; config?: LogStreamChart}`) | config type in `eng1799/logStream.ts`, wrapper and union member in `savedCharts.ts` | fields: `lineFieldId`, `timestampFieldId`, `levelFieldId?`, `labelsFieldId?`, `wrapLines?` (default false), `newestFirst?` (default true), `showLabels?` (default false), `levelColors?: Partial<Record<LogLevel,string>>`. **Exactly these 8 properties** (the schema test checks the key set). |
| `TraceWaterfallChart`, `TraceWaterfallChartConfig` | `eng1799/traceWaterfall.ts` | `traceIdFieldId`, `spanIdFieldId`, `parentSpanIdFieldId`, `serviceFieldId`, `nameFieldId`, `startFieldId`, `durationMsFieldId`, `statusFieldId`, `attributesFieldId` (all optional strings; more allowed) |
| `LogLevel`, `LOG_LEVELS`, `DEFAULT_LOG_LEVEL_COLORS`, `normalizeLogLevel(raw)`, `getLogLevelColor(level, overrides?)` | `eng1799/logStream.ts` | Grafana classic colours: critical `#705DA0`, error `#E24D42`, warning `#EAB839`, info `#7EB26D`, debug `#1F78C1`, trace `#6ED0E0`, unknown `#8E8E8E`. Aliases: emerg/alert/crit/fatal→critical, err/eror→error, warn→warning, information/informational/notice→info, dbug→debug; trimmed, case-insensitive; anything else→unknown |
| `GrafanaThresholds` (`{mode:'absolute'|'percentage', steps:{value:number|null,color:string}[]}`), `resolveGrafanaColor`, `getThresholdColor(value, thresholds, {min,max}?)`, `grafanaThresholdsToGaugeSections(thresholds, {min,max})` | `eng1799/thresholds.ts` | Grafana named colours: green `#73BF69`, red `#F2495C`, orange `#FF9830`, yellow `#FADE2A`, blue `#5794F2`, purple `#B877D9` (add the dark-/light-/semi-dark- variants too) |
| `GrafanaValueMapping` (Grafana's own JSON shape: `value`/`range`/`regex`/`special`), `applyValueMappings(value, mappings)` → `{text?, color?}` or `undefined` | `eng1799/valueMappings.ts` | lowest `index` wins; colours resolved to hex |
| `grafanaUnitToCustomFormat(unit, {decimals?})` → `CustomFormat` | `eng1799/grafanaUnits.ts` | see the test for expected outputs through `applyCustomFormat`. Byte families are checked by type only (gap below) |
| `GRAFANA_PANEL_MAPPINGS`, `getGrafanaPanelMapping(type)`, `getGrafanaPanelOptionMapping(panelType, path)` | **`src/eng1799/grafanaPanelMapping.ts`** (path fixed by the goal; the importer line consumes it) | targets: `builtin_chart`/`native_chart`/`registry_chart`/`markdown_tile`/`heading_tile`/`dropped` (+`chartType`, `registrySlug`, `reason`). Option targets: `builtin_chart_config`/`native_chart_config`/`registry_option`/`field_format`/`tile`/`dropped` with `lightdash` (where it lands) or `reason`. Option paths look like `options.legend.displayMode`, `fieldConfig.defaults.custom.stacking.mode`, `fieldConfig.overrides.<property id>`, top-level keys for legacy `graph`. Panel-level keys (`description`, `links`, `transformations`, `timeFrom`, ...) must resolve for any panel type. The full list is `packages/common/src/__acceptance__/viz/fixtures/grafana-panel-options.json`, generated from the 32 infra dashboards: paths only, no values. |
| `CartesianChart.thresholds?: {mode?, steps, style: 'line'|'dashed'|'area'|'line+area'|'dashed+area'}` | `savedCharts.ts` (one optional property) + type in `eng1799/` | |
| `ColumnProperties.valueMappings?: GrafanaValueMapping[]` | `savedCharts.ts` (one optional property) | |

**Chart-as-code schema.** `src/schemas/json/chart-as-code-1.0.json` is generated from the backend's TSOA swagger. After
changing a type: run `pnpm -F backend generate-api`, then `pnpm -F common generate:chart-as-code-schema`.
`pnpm -F common check:chart-as-code-schema` must pass; several checks run it. TSOA can't resolve `Exclude<>` over
unions, so enumerate union members (see the comment above `ChartAsCodeConfig`). The as-code tests validate full chart
YAML with Ajv against `$defs.ChartAsCode`, and look for `$defs.LogStreamChart`, `$defs.TraceWaterfallChart`,
`$defs.CartesianChart.properties.thresholds` and `$defs.ColumnProperties.properties.valueMappings`. Keep those type
names.

### Visualization engine (`packages/visualization`): chart logic lives here, not in the frontend

`renderChart({chartConfig}, {rows, fields})` must return, for the new types:

- `{kind: 'logStream', chartType: LOG_STREAM, model}` where `model = {lines, wrapLines, showLabels, newestFirst}`. Each
  line is `{id, timestamp (ISO string or null), line, level: LogLevel, color, labels: Record<string,string>}`, sorted by
  time per `newestFirst` with a stable tie order.
- `{kind: 'traceWaterfall', chartType: TRACE_WATERFALL, model}` where `model = {traces: [{traceId, startMs, durationMs,
  spans}]}`. Traces come in row order of first appearance. `spans` is in depth-first order, children by start. Each span
  is `{spanId, parentSpanId, traceId, service, name, status, attributes (object), offsetMs, durationMs,
  reportedDurationMs, depth, isOrphan, isClamped, color}`. The trace window is measured from the roots. A child is
  clamped into its parent's window. An orphan (parent not in the results) is a root, ordered by start among roots. Each
  service gets one colour.
- `{kind: 'empty', reason: 'noRows'}` for no rows.
- With no field ids in the config, bind columns by name. A field id equals the column name or ends with `_<name>`:
  `timestamp`, `line`, `level`, `labels`; `trace_id`, `span_id` (not `parent_span_id`), `parent_span_id`, `service`,
  `name`, `start`, `duration_ms`, `status`, `attributes`.
- Labels and attributes arrive as objects (pg parses OID 114 `json`) or as JSON text. Handle both. With no level
  column, the level comes from label `level`, then `detected_level`, then `unknown`.
- Cartesian thresholds: ECharts `markLine` entries (`yAxis: <step>`, step colour, `"dashed"` type for dashed styles)
  for each non-base step, and `markArea` bands `[[{yAxis: from}, {yAxis: to}]]` in the step colour (the base band ends
  at the first step). Area-only style draws no lines.
- Table value mappings: the table model rows' `value.formatted` is replaced by the mapping text. `value.raw` is kept.

### Frontend (`packages/frontend`): presentational components in new folders

| Component (named export) | File | Props |
|---|---|---|
| `LogStreamView` | `src/components/LogStream/LogStreamView.tsx` | `{model, height}` |
| `LogStreamConfigPanel` | `src/components/VisualizationConfigs/LogStreamConfig/LogStreamConfigPanel.tsx` | `{config, fields: {id,label}[], onChange(config)}` |
| `TraceWaterfallView` | `src/components/TraceWaterfall/TraceWaterfallView.tsx` | `{model}` |
| `TraceWaterfallConfigPanel` | `src/components/VisualizationConfigs/TraceWaterfallConfig/TraceWaterfallConfigPanel.tsx` | `{config, fields, onChange}` |
| `ThresholdsConfig` | `src/components/VisualizationConfigs/ThresholdsConfig/ThresholdsConfig.tsx` | `{thresholds?, onChange}` |
| `ValueMappingsConfig` | `src/components/VisualizationConfigs/ValueMappingsConfig/ValueMappingsConfig.tsx` | `{mappings, onChange}` |

DOM contract the tests use:

- **Log stream**
  - `data-testid`: `log-stream-row` (with `data-level`), `log-stream-level-bar` (inline `background-color`),
    `log-stream-timestamp`, `log-stream-line` (inline `white-space: pre-wrap` when wrapping, else `pre`/`nowrap`),
    `log-stream-labels` (`key=value` text), `log-stream-details`.
  - A textbox named /filter/.
  - Text "N of M lines" (locale digits allowed) and "No log lines".
  - A button named "Download CSV". It exports `timestamp,level,line,labels` (labels as JSON) for the shown lines,
    RFC 4180 quoting, via `URL.createObjectURL` and an anchor click.
- **Trace waterfall**
  - `data-testid`: `trace-span-row` (`data-span-id`, `data-depth`, `data-status`), `trace-span-bar` (inline `left`,
    `width` in % and `background-color`), `trace-time-axis` (ticks "0 ms" … "<total> ms"), `trace-service-legend`.
  - Buttons "Collapse <name>" / "Expand <name>" on spans with children.
  - A Mantine `Drawer` (role dialog) on span click, with name, service, status, duration, span id, every attribute, and
    a clamped / clock-skew note when clamped.
  - A Mantine `Select` labelled "Trace", only when there are several traces.
- **Config panels**
  - Mantine `Select`s labelled "Line field", "Timestamp field", "Level field", "Labels field" (trace: "Trace ID field",
    "Span ID field", "Parent span ID field", "Service field", "Span name field", "Start field", "Duration field",
    "Status field", "Attributes field").
  - Switches "Wrap lines", "Newest first", "Show labels".
  - Inputs "<Level> colour" for the seven levels.
  - Thresholds: "Add threshold", "Threshold N value", "Remove threshold N" (never for the base step 1), and a
    SegmentedControl Line / Dashed / Area / Line + area / Dashed + area.
  - Value mappings: "Add value mapping", "Mapping N value", "Mapping N display text", "Remove mapping N".
- **jsdom has no layout.** Elements measure 0×0. Virtualise with `@tanstack/react-virtual` (already a dependency), but
  size the viewport from the `height` prop when the measured size is 0 (`initialRect` plus an `observeElementRect`
  fallback). Otherwise only overscan rows render.
- **Wiring.** Add the types to the gallery (`useChartTypeOptions.tsx`), the names and icons (`resourceUtils.ts`,
  `ResourceIcon/utils.ts`) and `CHART_TYPES_WITHOUT_IMAGE_EXPORT`. Mount the views in
  `LightdashVisualization/index.tsx` (via an adapter) and the panels in the config tabs. `viz-native-types-mounted`
  checks that each view and panel is referenced outside its own folder.

### Backend

The only new backend code is the `chart_types` migration (`log_stream`, `trace_waterfall`). Its `down` must delete
dependent `saved_queries_versions` rows first, like the Sankey migration. The check runs every migration that mentions
the new types against a throwaway Postgres in `tmp/`. The full migration chain can't run there: Homebrew Postgres 18
has no `pgvector`. The backend CSV path already writes json labels as JSON (verified), so it needs no change.

### HouseRx chart registry (`chart-registry/`)

- A pnpm workspace package named exactly **`chart-registry`**.
  - Add `- 'chart-registry'` to `pnpm-workspace.yaml`. Then run `pnpm install` once (not frozen) and keep the updated
    `pnpm-lock.yaml`, or `init.sh`'s frozen install fails.
  - Its `build` script writes `chart-registry/dist/`: `index.json` and `index-next.json` (same charts), plus
    `charts/<slug>/<version>/{entry.json, source.tar, dist.tar, screenshot-*.png}`.
  - Use `packages/backend/src/ee/services/AppGenerateService/testFixtures/buildChartRegistryFixture.ts` as the model
    (read only). `entry.json` is the per-version snapshot shape (`parseChartRegistryVersionSnapshot`). Index entries
    must pass `parseChartRegistryIndexTolerant` with nothing dropped. Tags include `houserx`, and every entry has
    `preview.rows`.
- **dist.tar** holds only `dist/index.html` and flat `dist/assets/*`. It must pass the backend's `assertValidDistTar`.
  `index.html` loads `./assets/*.js` via `<script src>` only, with no inline script (CSP). Each script must compile as a
  **classic script**, i.e. an IIFE bundle with no top-level import or export (esbuild `format: 'iife'`), because the
  jsdom harness evals it. **source.tar** holds `src/...`.
- **Runtime protocol.** Listen for `lightdash:sdk:data-app-viz-context` and post `lightdash:sdk:viz-context-request`
  to `window.parent`. `@lightdash/query-sdk`'s `VizContextProvider`/`useVizContext` do exactly this. Rows are keyed by
  query field id; look a viz field up through `fieldMapping`. Draw with DOM/SVG (no canvas).
- **Marks.** Each coloured mark carries `data-color="#RRGGBB"`.
- Entries, with their fields, options and marks:

  | Slug | Fields | Options (config option names) | Marks |
  |---|---|---|---|
  | `heatmap` | `time`, `bucket`, `value` (metric) | (free) | `heatmap-cell` (`data-time`, `data-bucket`, `data-value`), `heatmap-y-label` (numeric order, `+Inf` last) |
  | `state-timeline` | `time`, `series`, `state` | `valueMappings` (text) | `state-timeline-row` (`data-series`), `state-timeline-segment` (`data-state`) |
  | `stat-sparkline` | `value` (metric, required), `time` (optional) | `unit`, `decimals`, `reducer` (lastNotNull default, last, mean, max, min, sum), `thresholds`, `valueMappings`, `graphMode` (none/area), `colorMode` (value/background/none) | `stat` (`data-color`, `data-color-mode`), `stat-value` (text, "No data"), `stat-sparkline` (`data-points`, contains `<path d>`) |
  | `bar-gauge` | `name`, `value` | `orientation` (select), `displayMode` (select basic/gradient), `min`, `max`, `thresholds`, `unit` | `bar-gauge` (`data-orientation`), `bar-gauge-bar` (`data-name`, `data-fill` 0..1 clamped, `data-mode`, gradient as SVG `linearGradient` or CSS `linear-gradient`) |
  | `histogram` | `value` | `bucketCount` (number) | `histogram-bar` (`data-count`, `data-from`, `data-to`) |
  | `status-grid` | `series`, `value` (latest row per series wins) | `thresholds`, `valueMappings`, `columns` | `status-grid` (`data-columns`), `status-grid-cell` (`data-series`, text: series and mapped value) |

- `thresholds` and `valueMappings` options are **text options holding Grafana's own JSON**. `thresholds` is
  `{mode, steps}` or a bare `steps` array. `valueMappings` is Grafana's mappings array. The importer can then copy them
  verbatim. Units use Grafana ids (`ms`, `percentunit`, `bytes` → `1.5 KiB`, `percent`, …). Entries may bundle the
  common helpers.
- Hosting (a bucket and `LIGHTDASH_CHART_REGISTRY_URL`) is a later content task. Document what it needs in
  `docs/eng-1799/viz.md`: static files, `index.json`, `index-next.json` for the `next` channel, image content types,
  https, and `allowPrivateHosts` for an internal mirror.

### Docs

- `docs/eng-1799/grafana-panel-mapping.md` has a table row starting with `` | `<type>` | `` for each of the 15 panel
  types, and every option path from the fixture in backticks.
- `docs/eng-1799/viz.md` has headings for log stream, trace waterfall, registry, hosting, mapping and "Contract
  assumptions". It mentions `LIGHTDASH_CHART_REGISTRY_URL`, `chart-registry/dist`, `pnpm -F chart-registry build`,
  `index.json`, every slug in backticks, and the ee/ typecheck measurement. Never write "dashboard panel".

## Conventions

- Never modify `packages/*/src/ee/**`. Put new code in new files. Keep upstream edits to registration lines, union
  members, a case per switch, and one optional property per config type.
- Use synthetic fixtures only, with no PHI. Secret-shaped values look like `test-secret-not-real`.
- No network to HouseRx systems, no Docker, no fixed ports, no long-lived servers.
- Keep the regression typechecks green after every feature. Run `pnpm -F <pkg> lint` on files you touch if you can.
- Use glossary terms in UI copy and docs (Tile, Telemetry Source, Signal, Time series).

## Contract assumptions (narrowest compatible readings; for the integration line)

1. Both types are native: no `ee/` file breaks once `ChartAsCodeConfig` includes them (measurement above).
2. CONTRACTS §1 "plus `level` when present": with no level column, the level comes from label `level`, then
   `detected_level`, then `unknown`.
3. `labels`/`attributes` arrive as objects (pg parses `json`, OID 114) or as JSON text, and both are accepted. `start`
   and `timestamp` arrive as Date or ISO strings.
4. When results hold several traces, the first trace in row order is shown, with a Trace picker.
5. The log stream's CSV export is client-side over the loaded lines (after the filter). Full-result exports keep using
   the backend CSV path, which already writes json columns as JSON.
6. Registry `thresholds`/`valueMappings` options take Grafana's JSON shapes as text, so the importer line can copy them.
   `index-next.json` lists the same charts as `index.json`.
7. Lightdash byte formats need an explicit compact unit and ignore suffixes, so Grafana's auto-scaled `bytes`/`Bps`
   map to the `bytes_iec`/`bytes_si` family only. Listed as a gap in the mapping doc.

## Status

Init session (2026-11-08) wrote the feature list (54 features, all `passes: false`), the acceptance tests, `init.sh`
and this file. It built no features. Every check failed on the untouched tree, on missing modules or failed
assertions. The registry harness was proven against a scratch package, which was removed afterwards. Later sessions
should add a dated line here per feature.
- 2026-11-08T17:32:09Z supervisor: initialized: 54 features, run 20261108-114537
- 2026-11-08T17:41:27Z supervisor: initialized: 54 features, run 20261108-123501
- 2026-11-08T17:53:38Z supervisor: viz-chart-type-members halted: the worker halted on viz-chart-type-members
- 2026-11-08T17:56:39Z supervisor: viz-chart-types-migration halted: the worker halted on viz-chart-types-migration
- 2026-11-08T18:00:00Z supervisor: viz-log-levels halted: the worker halted on viz-log-levels
- 2026-11-08T18:00:56Z supervisor: viz-log-stream-as-code halted: the worker halted on viz-log-stream-as-code
- 2026-11-08T18:04:32Z supervisor: viz-trace-waterfall-as-code halted: the worker halted on viz-trace-waterfall-as-code
- 2026-11-08T18:05:20Z supervisor: viz-chart-type-wiring halted: the worker halted on viz-chart-type-wiring
- 2026-11-08T18:06:28Z supervisor: viz-log-stream-model halted: the worker halted on viz-log-stream-model
- 2026-11-08T18:07:19Z supervisor: viz-log-stream-order halted: the worker halted on viz-log-stream-order
