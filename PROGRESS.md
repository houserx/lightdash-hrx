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
- 2026-11-08T18:08:02Z supervisor: viz-log-stream-view halted: the worker halted on viz-log-stream-view
- 2026-11-08T18:08:51Z supervisor: viz-log-stream-virtualised halted: the worker halted on viz-log-stream-virtualised

### 2026-11-08 viz-chart-type-members (session)

- **What.** `ChartType`/`ChartKind` gained `LOG_STREAM = 'log_stream'` and `TRACE_WATERFALL = 'trace_waterfall'`, with
  `getChartType`/`getChartKind` cases. Check passes.
- **Why it is bigger than the enum lines (the trap that halted earlier rounds).** With only the enum members added, the
  backend typecheck breaks in a **protected** file: `src/ee/services/AiAgentToolsService/AiAgentToolsService.documents.test.ts`
  builds `chartConfig: { type: ChartType.TABLE }` in a widening position, which only typechecks while every `ChartType`
  member has a member in `ChartConfig`/`ChartAsCodeConfig`. So this feature also added, per the handbook:
  - `src/eng1799/logStream.ts` (`LogLevel` type, `LogStreamChart`, exactly the 8 properties, all optional so columns can
    bind by name) and `src/eng1799/traceWaterfall.ts` (`TraceWaterfallChart`, 9 optional field ids), re-exported from
    `index.ts`.
  - `LogStreamChartConfig`/`TraceWaterfallChartConfig` in `savedCharts.ts`, members of `ChartConfig` and
    `ChartAsCodeConfig`.
  - Regenerated `backend/src/generated/{routes.ts,swagger.json}` (`pnpm -F backend generate-api:build`, which also runs
    oxfmt. Plain `generate-api` leaves them unformatted with a 400k-line diff) and `chart-as-code-1.0.json`. As a side
    effect, the `log-stream-as-code` and `trace-waterfall-as-code` acceptance tests pass already. Their sessions only
    need to confirm them.
- **Minimal switch cases to keep the regression gate green** (placeholders the later features replace):
  - common `derivePivotConfigFromChart`: no pivot.
  - backend `rename.ts`: renames every field id in both configs (real behaviour, done).
  - visualization `render.ts`: both resolve and render as `{kind: 'unsupported'}` via a new `UnsupportedChartType`.
    `viz-log-stream-model`/`viz-trace-waterfall-model` must replace that with `logStream`/`traceWaterfall` outputs.
  - frontend: `VisualizationTelemetryConfig.tsx` (adapter exposing the prop config as `validConfig`, no emitting yet;
    `editedChartConfig` returns null for both); `index.tsx` shows a SuboptimalState "This chart type can't be displayed
    yet" (replace with the view adapters); `VisualizationConfig.tsx` returns an empty `NoConfigTabs` (replace with the
    config panels); `buildInitialState` seeds no editor slice; preview field mapping keeps query roles; Explorer
    `ConfigCacheMap`/`DEFAULTS` got `{}` entries. Names, icons, gallery and `CHART_TYPES_WITHOUT_IMAGE_EXPORT` are
    still for `viz-chart-type-wiring`.
- Also changed the non-protected upstream fixture `common/src/utils/documentMarkdown.test.ts` (`ChartType.BIG_NUMBER as
  const`). It is not strictly needed now that the unions are extended, but it is harmless.
- **Tested.** `bash ./init.sh`, then the check (4/4). Common, warehouses, backend, frontend and visualization typechecks
  are green, `check:chart-as-code-schema` passes, and oxlint/oxfmt are clean on the touched files. Nearby unit tests
  pass (common types/pivot, visualization render, backend RenameService, frontend Explorer/store/preview mapping). A tsx
  script through `@lightdash/common`/`@lightdash/visualization` listed both members, JSON round-tripped a saved config
  of each type to the same kind and type, and rendered them as `unsupported`. Saving to a DB needs the `chart_types`
  migration (next feature).
- **Tooling notes.** Format with `oxfmt` (`pnpm -F <pkg> exec oxfmt --check <files>`), not prettier. Running eslint/npx
  hits the Node devEngines mismatch, so use `pnpm -F <pkg> run linter <files>` (oxlint).
- 2026-11-08T18:19:19Z supervisor: viz-chart-type-members passed the gate in round 1

### 2026-11-08 viz-chart-types-migration (session)

- **What.** New core migration `packages/backend/src/database/migrations/20261108120000_add_log_stream_and_trace_waterfall_chart_types.ts`.
  `up` inserts `log_stream` and `trace_waterfall` into `chart_types` (the FK target of `saved_queries_versions.chart_type`).
  `down` deletes `saved_queries_versions` rows of those types first, then the two `chart_types` rows. This copies the
  `sankey`/`data_app_viz` chart-type migrations. The type strings are frozen local constants, with no `@lightdash/common`
  import (migrations/AGENTS.md).
- **Tested.** `bash ./init.sh`, then the check (4/4). It starts a throwaway Postgres, runs the real `up`, inserts a
  `saved_queries_versions` row of each new type (FK accepted), and runs `down` (types and their chart versions removed,
  `sankey` untouched). The full `migrate:latest` chain can't run locally because it needs pgvector, so the check's
  hand-built `chart_types` + `saved_queries_versions` is the closest end-to-end run. oxfmt and oxlint are clean. The
  release-safety analyzer (`scripts/release-safety-migrations.ts` `analyzeMigrationSource`) gives the same result as for
  `20260624120004_add_data_app_viz_chart_type.ts` (complete, no heaviness), so no declaration is needed.
- **Next.** Charts of both types can now be saved through the API. No other changes.
- 2026-11-08T18:22:15Z supervisor: viz-chart-types-migration passed the gate in round 1

### 2026-11-08 viz-log-levels (session)

- **What.** `packages/common/src/eng1799/logStream.ts` (already exported from the common index) now has `LOG_LEVELS` (most
  severe first), `DEFAULT_LOG_LEVEL_COLORS` (Grafana's defaults), `normalizeLogLevel(raw: unknown)` and
  `getLogLevelColor(level, overrides?)`. The alias table copies Grafana's `LogLevel` enum: emerg/fatal/alert/crit/critical
  map to critical, warn/warning to warning, err/eror/error to error, info/information/informational/notice to info,
  dbug/debug to debug, and trace to trace. Matching ignores case and surrounding whitespace. Non-strings, empty strings
  and unknown names give `unknown`. An override that is empty or falsy falls back to the default colour.
- **Tested.** `bash ./init.sh`, then the check (25/25). The common typecheck, oxfmt and oxlint are clean. No log stream
  UI exists yet, so I ran a tsx script through `@lightdash/common` on rows with levels ERR/warn/crit/notice/missing. It
  got error/warning/critical/info/unknown with Grafana's colours, and an `error` override changed only the error colour.
- **Next.** `viz-log-stream-model` and `viz-log-stream-level-bar` should use `normalizeLogLevel` and `getLogLevelColor`
  with `config.levelColors`, not their own tables.
- 2026-11-08T18:26:53Z supervisor: viz-log-levels passed the gate in round 1

### 2026-11-08 viz-log-stream-as-code (session)

- **What.** No code change was needed. `viz-chart-type-members` had already added `LogStreamChart` (all 8 config fields,
  with doc comments) and `LogStreamChartConfig` to `ChartConfig` and `ChartAsCodeConfig`, and regenerated swagger and
  `chart-as-code-1.0.json`. The check passed on the untouched tree (schema up to date, 5/5).
- **Verified the as-code path.** Backend `CoderService` and the CLI `download` (`sanitizeChartForDownload`, then
  `yaml.dump`) pass `chartConfig` through unchanged for every type except `data_app_viz`/cartesian, so a log stream chart
  downloads as `type: log_stream` with its `config`.
- **Tested as a user.** `bash ./init.sh`, then the check. A real `lightdash download` needs a running backend with a full
  DB, and `migrate:latest` needs pgvector, which isn't available locally. Instead I wrote a synthetic chart YAML in the
  shape download writes into `../tmp/lsac/charts/` and ran the CLI `pnpm -F cli exec tsx src/index.ts lint --path …`.
  The full config was reported valid. With `wrapLines: "sometimes"` it failed with "Expected type 'boolean' (line 22)".
- **Note.** `levelColors` keys are the 7 `LogLevel` names. Unknown keys are not rejected, because the schema has no
  `additionalProperties: false`, the same as other chart configs.
- 2026-11-08T18:30:21Z supervisor: viz-log-stream-as-code passed the gate in round 1

### 2026-11-08 viz-trace-waterfall-as-code (session)

- **What.** No code change was needed. `viz-chart-type-members` had already added `TraceWaterfallChart`
  (`packages/common/src/eng1799/traceWaterfall.ts`, all 9 span field ids as optional strings with doc comments) to
  `ChartConfig`/`ChartAsCodeConfig`, and the generated `chart-as-code-1.0.json` has `$defs.TraceWaterfallChart`. The
  check passed on the untouched tree (schema up to date, 5/5).
- **Verified the as-code path.** The CLI `download` only special-cases cartesian and `data_app_viz`, so a trace waterfall
  chart downloads as `type: trace_waterfall` with its `config` unchanged.
- **Tested as a user.** `bash ./init.sh`, then the check. A real `lightdash download` needs a running backend and full DB
  (pgvector is not available locally). Instead I wrote a synthetic chart YAML in the shape download writes, at
  `../tmp/twac/charts/synthetic-trace.yml`, and ran `pnpm -F cli exec tsx src/index.ts lint --path …`. All 9 span field
  ids were reported valid. With `spanIdFieldId: [a, b]` it failed with "Expected type 'string' (line 19)".
- **Note.** Unknown config keys are not rejected (no `additionalProperties: false`), the same as other chart configs.
- 2026-11-08T18:33:42Z supervisor: viz-trace-waterfall-as-code passed the gate in round 1
- 2026-11-08T18:35:23Z supervisor: viz-chart-type-wiring halted: worker viz.feature.viz-chart-type-wiring.r1 stopped: STOP file present

### 2026-11-08 viz-chart-type-wiring (session)

- **What.** Three frontend helpers that used a `default:` branch now handle the new types. `getResourceTypeName`
  returns 'Log stream' and 'Trace waterfall'. `getChartIcon` returns `IconListDetails` for log stream and
  `IconTimeline` for trace waterfall. `CHART_TYPES_WITHOUT_IMAGE_EXPORT` now lists `LOG_STREAM` and `TRACE_WATERFALL`,
  because both are DOM renderers and the ECharts image capture has nothing to read.
- **Audit.** All five typechecks were already green before this change: `viz-chart-type-members` had wired every
  exhaustive switch (`assertUnreachable`). The remaining non-ee `SANKEY`/`DATA_APP_VIZ` references are equality
  checks, not switches over the type.
- **Tested as a user.** A full app needs a backend and DB, and pgvector isn't available locally. Instead I rendered the
  real `ResourceViewList` in a throwaway vitest file (since deleted) with two synthetic charts. The rows read
  "Log stream • …" and "Trace waterfall • …", and their SVGs match IconListDetails and IconTimeline: distinct, and not
  the bar-chart fallback. In a throwaway copy of the `ChartDownloadMenu` test harness, log stream and trace waterfall
  render no export button and no image option. Cartesian still shows both. Then I ran the check after
  `bash ./init.sh`: 3/3 pass, and all five typechecks pass. The related ChartDownload/ResourceView unit tests pass
  (69/69), and oxfmt and oxlint are clean.
- **Next.** Because the new types are also in `CHART_TYPES_WITHOUT_DATA_EXPORT` (everything except table),
  `ChartDownloadMenu` returns null for them, so no export menu shows at all. `viz-log-stream-csv-export` must change
  that gate (for example, a log-stream branch like the `DATA_APP_VIZ` one) to offer CSV. The ee AI-copilot callers of
  `CHART_TYPES_WITHOUT_IMAGE_EXPORT` and `getChartIcon` pick up the new entries automatically, with no ee edit.
- 2026-11-08T18:41:04Z supervisor: viz-chart-type-wiring passed the gate in round 1

### 2026-11-08 viz-log-stream-model (session)

- **What.** A new folder, `packages/visualization/src/logStream/`. `config.ts` holds `resolveLogStreamChartConfig`: a
  field the config names stays bound while the data has it. Otherwise each role binds by name to a field id equal to
  or ending in `_<name>`, else to a field with that label: line `line`, then `message`; timestamp `timestamp`; level
  `level`; labels `labels`, then `fields`. These are the `logql()`/`cloudwatch_logs()` columns of CONTRACTS §1.1. It
  also fills the defaults: wrapLines false, newestFirst true, showLabels false. `model.ts` holds `buildLogStreamModel`:
  one line per row with `id` (row index), `line`, `timestamp` (epoch ms or null), `formattedTimestamp`, `level`,
  `color` and `labels`, plus the display options and the full `levelColors` map. Labels can be an object or JSON
  text. The level comes from the level column, else the label `level`, then `detected_level`, else `unknown`
  (contract assumption 2).
- **render.ts.** `LOG_STREAM` left `UnsupportedChartType`. `RenderOutput` gains `{ kind: 'logStream', model }`. No
  rows gives `empty`/`noRows`. Rows with no line column give `empty`/`incompleteConfig`. The README's kind switch and
  the smoke-pack consumer's exhaustive switch list the new kind. `LogStreamLine`/`LogStreamModel` are exported from the
  package index.
- **Tested as a user.** There is no telemetry engine or frontend log renderer yet: the renderer is `viz-log-stream-view`.
  So I called the built `dist/cjs` `renderChart` from plain Node. The input was synthetic logql-shaped rows (fields
  `logs_timestamp/line/level/labels/stream`) with no config. Every line came back with its timestamp, its level
  (ERR→error, crit→critical, null+detected_level notice→info), Grafana's colour and its labels, from both JSON text
  and object labels. Zero rows gave `empty`/`noRows`. The check passes 9/9 after `bash ./init.sh`. The new unit tests
  pass (6/6), and so do render.test (21) and readme.test. The visualization typecheck, lint and format check pass, and
  so does the frontend typecheck.
- **Next.** Lines keep the data's order. Sorting by `newestFirst` belongs to `viz-log-stream-order`: sort on
  `timestamp` (null last) in `buildLogStreamModel`. The view should read `model.lines[].formattedTimestamp` or format
  `timestamp` itself.
- 2026-11-08T18:46:43Z supervisor: viz-log-stream-model passed the gate in round 1

### 2026-11-08 viz-log-stream-order (session)

- **What.** `packages/visualization/src/logStream/model.ts`: `buildLogStreamModel` now returns `lines` sorted by
  `timestamp` through the new exported `sortLogStreamLines(lines, newestFirst)`. Newest first is the default
  (`newestFirst` resolves to true), oldest first when the config sets `newestFirst: false`. The sort is stable, so
  lines with the same time keep the query's order (in both directions). Lines with no valid time go last, in the
  query's order. `id` is still the row index in the data, so ids stay stable but are no longer in display order.
  A unit test in `logStream.test.ts` covers both directions and untimed lines.
- **Tested as a user.** There is still no frontend log renderer (`viz-log-stream-view` is next), so I called the built
  `dist/cjs` `renderChart` from plain Node with five synthetic logs-shaped rows in shuffled order (03, 01, 05, 02, 04).
  With no config the lines came back 05→01. With `newestFirst: false` they came back 01→05. The check passes 3/3 after
  `bash ./init.sh`, and the log-stream-model acceptance test still passes 9/9. Unit tests (7/7), typecheck, oxlint
  and oxfmt for the visualization package pass.
- **Next.** The view should draw `model.lines` in the given order and not sort again.
- 2026-11-08T18:48:53Z supervisor: viz-log-stream-order passed the gate in round 1

### 2026-11-08 viz-log-stream-view (session)

- **What.** New `packages/frontend/src/components/LogStream/LogStreamView.tsx` (+ `LogStreamView.module.css`), named
  export `LogStreamView({model, height})`. It draws `model.lines` in the given order (no re-sort), one
  `log-stream-row` per line (`data-level` set), each with a `log-stream-timestamp` (the data's `formattedTimestamp`,
  else the ISO time, else empty) and a `log-stream-line`. A footer reads `N of N lines` with `toLocaleString()`
  digits. A model with no lines shows "No log lines". The view is `height` px tall, footer included; rows sit in a
  Mantine `ScrollArea`. Not mounted in the app yet (that is a wiring feature).
- **Tested as a user.** No app mounts the view yet, so I rendered it with the fixtures' synthetic logs in a
  throwaway vitest file (deleted): five rows came out newest first, each "timestamp + text", with the right levels,
  and the footer read "5 of 5 lines". The check passes 3/3 after `bash ./init.sh`. The frontend typecheck, oxlint and
  oxfmt pass.
- **Traps for the next sessions.**
  - The frontend lint rule `lightdash-ui(no-inline-style-prop)` forbids `style={{...}}` except `--css-variable`
    bridges. The no-wrap rule lives in the CSS module's `.line` class for now. `log-stream-wrap-lines` checks
    `line.style.whiteSpace` (inline), and `log-stream-level-bar` checks an inline `background-color`; jsdom does not
    apply CSS modules. Use a CSS variable bridge (e.g. `style={{'--log-white-space': ...}}`) only if the test sees it,
    else decide how to satisfy both the lint and the test (check the rule's source first).
  - The footer says `${total} of ${total}`; the filter feature should make the first number the shown count.
  - The row list is not virtualised yet (`viz-log-stream-virtualised`); replace the `.map` with
    `@tanstack/react-virtual` sized from `height` minus the 28 px footer.
  - Zero rows never reach the view through `renderChart` (it returns `empty`/`noRows`); "No log lines" is for a model
    with no lines (e.g. everything filtered out).
- 2026-11-08T18:51:47Z supervisor: viz-log-stream-view passed the gate in round 1

### 2026-11-08 viz-log-stream-virtualised (session)

- **What.** `packages/frontend/src/components/LogStream/LogStreamView.tsx` now virtualises its rows with
  `@tanstack/react-virtual` (already a frontend dependency, same pattern as `sqlRunner/components/Tables.tsx`). The
  Mantine `ScrollArea` viewport is the scroll element. Rows have a fixed height (`ROW_HEIGHT = 24`, matching `.row`
  in the CSS module) and an overscan of 20. Each row is absolutely positioned through a `--log-row-start` CSS variable
  bridge (`transform: translateY(...)` in the CSS module), which the lint rule allows. The viewport size comes from the
  real measurement, falling back to `height - 28` (footer) while the element has no layout (first paint, jsdom). It
  uses `initialRect` plus a wrapper around the library's `observeElementRect`.
- **Tested as a user.** No app mounts the view yet, so I rendered it with `manyLogs(5000)` in a throwaway vitest file
  (deleted). It took about 47 ms and drew 36 rows (line 5000 down to 4965), and the footer read "5,000 of 5,000 lines".
  After scrolling the viewport to 4,000 rows down, the window showed lines 1020 to 965 (56 rows). The check passes
  1/1 and log-stream-view still passes 3/3. The frontend tsc, oxlint and oxfmt pass.
- **Traps for the next sessions.** Fixed row heights assume one text line per row. `log-stream-wrap-lines` and
  `log-stream-expand-row` will need variable heights: add `ref={virtualizer.measureElement}` + `data-index` on rows
  and drop the fixed `height` in `.row`. jsdom measures 0 though, so keep the estimate as the fallback when the
  measured size is 0 (the jsdom window tests must still draw rows).
- 2026-11-08T18:54:34Z supervisor: viz-log-stream-virtualised passed the gate in round 1

### 2026-11-08 viz-log-stream-level-bar (session)

- **What.** Each `log-stream-row` in `packages/frontend/src/components/LogStream/LogStreamView.tsx` now starts with a
  `log-stream-level-bar` `Box` coloured with the model's `line.color` (the chart's `levelColors` override, else
  Grafana's default, already resolved by `@lightdash/visualization`). The colour goes through Mantine's `bg` style
  prop, which renders inline (so jsdom's `toHaveStyle({backgroundColor})` sees it) and is the route the
  `lightdash-ui(no-inline-style-prop)` rule recommends; no `style={{...}}`. Shape (3 px wide, full row height) lives in
  `.levelBar` in the CSS module. The bar has `title={line.level}` for a hover hint.
- **Tested as a user.** No app mounts the view yet, so I rendered `FIVE_LOGS` in a throwaway vitest file (deleted):
  error rgb(226,77,66) red, warning rgb(234,184,57) yellow, info rgb(126,178,109) green, debug blue, critical purple.
  With `levelColors: {error: '#ff00ff'}` only the error bar changed, to rgb(255,0,255). The check passes 2/2 after
  `bash ./init.sh`; log-stream-view (3/3) and log-stream-virtualised (1/1) still pass. Frontend tsc, oxlint, oxfmt pass.
- **For the next sessions.** For inline colours/values the tests read, a Mantine style prop (`bg`, `c`, `h`, ...) is
  the lint-clean way; `log-stream-wrap-lines` (inline `whiteSpace`) has no Mantine style prop, so check that rule again
  there. The bar uses `align-self: stretch` with `margin: -2px 0` to cover the row padding; with variable row heights it
  still stretches.
- 2026-11-08T18:57:13Z supervisor: viz-log-stream-level-bar passed the gate in round 1

### 2026-11-08 viz-log-stream-expand-row (session)

- **What.** In `packages/frontend/src/components/LogStream/LogStreamView.tsx`, each `log-stream-row` is now an outer
  absolutely positioned `Box` (one per line, still carrying `data-testid="log-stream-row"` and `data-level`). It holds a
  clickable header `Group` (`role="button"`, `tabIndex=0`, `aria-expanded`, toggled by click or Enter/Space) with the
  level bar, timestamp and line. When the row is expanded it also holds a `log-stream-details` box that lists every label
  as a `<dl>` of key (`dt`, dimmed) and value (`dd`), in model order, or "No labels". The view keeps a `Set` of
  expanded line ids, so several rows can be open at once (as in Grafana). The ids are `line.id`, so the set survives
  re-sorting and, later, filtering.
- **Variable row heights.** Rows now use `ref={virtualizer.measureElement}` + `data-index`. The fixed `height` moved
  from `.row` to `.header` (23 px + 1 px row border = `ROW_HEIGHT` 24). `estimateSize` returns
  `24 + 9 + labels × 20` for expanded rows (`DETAILS_PADDING`, `LABEL_HEIGHT`; keep them in step with `.details` and
  `.label` in the CSS module). A custom `measureElement` option falls back to that estimate when the element measures 0
  (jsdom), so the jsdom window tests still draw rows and positions stay sensible.
- **Tested as a user.** No app mounts the view yet, so I drove `FIVE_LOGS` in a throwaway vitest file (deleted) with
  userEvent. Row starts were 0/24/48/72/96 px. After clicking rows 1 and 3, two details boxes showed app, namespace and
  pod, and the starts became 0/93/117/210/234. Enter on a focused open header closed it, and Space opened it again.
  After `bash ./init.sh` the check passes 1/1, and log-stream-view (3/3), virtualised (1/1) and level-bar (2/2) still
  pass. The frontend typecheck, oxlint and oxfmt are clean.
- **For the next sessions.** `log-stream-show-labels` expects `log-stream-labels` inside each row. Put it in the header
  (or a second header line) and add its height to `estimatedRowHeight`. `log-stream-wrap-lines` can now drop
  `white-space: pre` / the fixed `.header` height when wrapping; measurement already handles taller rows in a browser.
  `log-stream-filter`: keep the expanded set keyed by `line.id`. Do not reset it on filter changes unless the spec says
  to.
- 2026-11-08T19:00:22Z supervisor: viz-log-stream-expand-row passed the gate in round 1

### 2026-11-08 viz-log-stream-show-labels (session)

- **What.** In `packages/frontend/src/components/LogStream/LogStreamView.tsx`, when `model.showLabels` is true each row's
  header gets a `log-stream-labels` `Text` between the timestamp and the line, holding the labels as space-separated
  `key=value` pairs in model order (`labelsText`), dimmed monospace, with the full text as `title`. It stays on the one
  header line: `.inlineLabels` in the CSS module is `nowrap` + ellipsis, `max-width: 40%`, so `ROW_HEIGHT` and
  `estimatedRowHeight` are unchanged. With `showLabels` off (the default) nothing is rendered. Clicking the labels
  still toggles the row's details (they sit inside the clickable header).
- **Steps 1–2 (config panel toggle).** No log stream config UI exists yet; `viz-log-stream-config-panel` adds the
  "Show labels" toggle. The view reads only the model field (`showLabels`, from `@lightdash/visualization` config,
  default false), so the panel only has to set `showLabels` on the chart config.
- **Tested as a user.** No app mounts the view yet, so I rendered `FIVE_LOGS` with `showLabels: true` in a throwaway
  vitest file (deleted): each of the 5 headers read level-bar, timestamp, labels, line, with labels like
  `app=cache namespace=synthetic pod=cache-1`; clicking a labels cell opened that row's details. After `bash ./init.sh`
  the check passes 2/2; log-stream-view (3/3), virtualised (1/1), level-bar (2/2), expand-row (1/1) still pass.
  Frontend tsc, oxlint, oxfmt clean.
- **For the next sessions.** `log-stream-wrap-lines`: when wrapping, consider letting `.inlineLabels` wrap too or keep
  it capped; it is a flex child of `.header`, which currently has a fixed height.
- 2026-11-08T19:02:52Z supervisor: viz-log-stream-show-labels passed the gate in round 1

### 2026-11-08 viz-log-stream-wrap-lines (session)

- **What.** In `packages/frontend/src/components/LogStream/LogStreamView.tsx` the view passes `model.wrapLines` to each
  row. The `log-stream-line` `Text` gets an inline `white-space`: `pre-wrap` when wrapping, `pre` when not (the
  acceptance check reads `line.style.whiteSpace`, and CSS modules are not applied in jsdom, so it has to be inline; one
  `oxlint-disable-next-line lightdash-ui/no-inline-style-prop` with a reason, as in SimpleTreemap/UserActivity). When
  wrapping, a `.wrapped` modifier class goes on `.header` (`height: auto; min-height: 23px`) and on `.line`
  (`overflow-wrap: anywhere`, so long unbroken tokens wrap too). Off is the default and unchanged: one 24 px row.
- **Row heights.** `estimatedRowHeight` still returns `ROW_HEIGHT` for wrapped rows; in a browser the virtualiser's
  `measureElement` (ResizeObserver) measures the taller rows. Inline labels stay capped/ellipsed (`.inlineLabels`)
  when wrapping, a deliberate choice to keep the labels column tidy.
- **Steps 1–3 (toggle).** No config panel exists yet; `viz-log-stream-config-panel` adds the "Wrap lines" toggle and only
  has to set `wrapLines` on the chart config (`@lightdash/visualization`, default false).
- **Tested as a user.** No app mounts the view yet, so I rendered `FIVE_LOGS` with each line extended by ~600 chars in a
  throwaway vitest file (deleted) and re-rendered off → on → off: all 5 lines were `pre` with plain `.header`, then
  `pre-wrap` with `.wrapped` on header and line, then `pre` again. After `bash ./init.sh` the check passes 2/2;
  log-stream-view (3/3), virtualised (1/1), level-bar (2/2), expand-row (1/1), show-labels (2/2) still pass. Frontend
  tsc, oxlint (`pnpm run linter`) and oxfmt clean.
- 2026-11-08T19:06:27Z supervisor: viz-log-stream-wrap-lines passed the gate in round 1

### 2026-11-08 viz-log-stream-filter (session)

- **What.** `packages/frontend/src/components/LogStream/LogStreamView.tsx` now has a filter box (Mantine `TextInput`,
  `aria-label="Filter lines"`, with a "Clear filter" close button while it has text) in a 36 px `.toolbar` above the
  lines (`TOOLBAR_HEIGHT`, subtracted from the viewport height with the footer). `filterLines` keeps the lines whose
  `line` text contains the trimmed filter, ignoring case; a blank filter keeps all. The virtualiser, row estimates and
  keys all run over the filtered list, and the footer says `<shown> of <total> lines`. Filtered to nothing shows
  "No lines match"; no lines at all still shows "No log lines". The box is shown in both cases.
- **Decisions.** No spec text defines the match; I took the narrowest reading: the line text only (not labels or
  level). The filter is view state only (not saved to the chart config). The expanded set stays keyed by `line.id` and is
  not reset when the filter changes, so an expanded row stays expanded after the filter is cleared.
- **Tested as a user.** No app mounts the view yet, so I drove `FIVE_LOGS` in a throwaway vitest file (deleted) with
  userEvent: 5 of 5 lines → typed `timeout` → the two timeout lines (`TIMEOUT` matched too), `2 of 5 lines` → expanded
  one → clicked Clear filter → all 5 lines back, `5 of 5 lines`, still expanded → typed `nope` → `0 of 5 lines`,
  "No lines match". After `bash ./init.sh` the check passes 2/2; log-stream view, virtualised, level-bar, expand-row,
  show-labels, wrap-lines still pass. Frontend tsc, oxlint, oxfmt clean.
- **For the next sessions.** `log-stream-csv-export` exports "the shown lines": use the filtered `lines` array
  inside `LogStreamView` (in display order), not `model.lines`. The toolbar is the natural place for the Download CSV
  button.
- 2026-11-08T19:09:27Z supervisor: viz-log-stream-filter passed the gate in round 1

### 2026-11-08 viz-log-stream-csv-export (session)

- **What.** New `packages/frontend/src/components/LogStream/logStreamCsv.ts`: `logLinesToCsv(lines)` writes
  `timestamp,level,line,labels` plus one row per line in the given order, RFC 4180 quoting (a field holding `,`, `"`, CR
  or LF is quoted, quotes doubled), CRLF row ends; labels are `JSON.stringify(line.labels)` (`{}` when none).
  `downloadLogLinesCsv(lines, fileName = 'log-stream.csv')` saves it through a Blob + temporary `<a download>` with a
  UTF-8 BOM (Excel). `LogStreamView`'s toolbar is now a `Group`: filter box (`flex={1}`) plus a "Download CSV" button
  (default variant, download icon) that exports the **filtered** `lines` in display order. Disabled when no line is
  shown.
- **Decisions.** Timestamp column is the ISO time (`toISOString()`) when the line has a valid time, else the data's
  `formattedTimestamp` (the on-screen column prefers the formatted text; the file prefers a machine-readable value).
  Level column is the normalised level (`warning`, `critical`, ...), not the raw source value. No spreadsheet formula
  escaping (a leading `=`/`+`/`-`/`@` is written as is) to keep the log text exact; revisit if security review asks.
  The file name is fixed (`log-stream.csv`); a chart-name-based name can come when the view is mounted in a chart.
- **Tested as a user.** No app mounts the view yet, so I drove `FIVE_LOGS` plus a synthetic line with a newline, comma
  and quotes in a throwaway vitest file (deleted) with userEvent: Download CSV → 7 rows newest first, the tricky line
  quoted correctly, labels as JSON → typed `timeout` → Download CSV → header + the 2 matching rows → typed `nope` →
  button disabled. After `bash ./init.sh` the check passes 2/2; filter, view, wrap-lines, expand-row still pass.
  Frontend tsc, `pnpm run linter`, oxfmt clean.
- 2026-11-08T19:12:51Z supervisor: viz-log-stream-csv-export passed the gate in round 1

### 2026-11-08 viz-log-stream-config-panel (session)

- **What.** New `packages/frontend/src/components/VisualizationConfigs/LogStreamConfig/LogStreamConfigPanel.tsx`, a
  controlled panel: props `config: LogStreamChart`, `fields: { id, label }[]`, `onChange(config)`. Every edit calls
  `onChange({ ...config, ...patch })`. Sections: **Fields**: four searchable, clearable Mantine `Select`s ("Line
  field", "Timestamp field", "Level field", "Labels field"); clearing one sets it to `undefined` (auto-detect).
  **Display**: `Switch`es for Wrap lines (default off), Newest first (default **on**, as in `LogStreamChart`) and Show
  labels (default off). **Level colours**: one hex `ColorInput` per `LOG_LEVELS` entry, visible label `Error` etc.,
  `aria-label="Error colour"`.
- **Traps.** (1) Mantine 9's Combobox keeps its dropdown mounted by default, and the listbox is `aria-labelledby` the
  Select's label, so `getByLabelText(/line field/)` found two elements. The pickers pass
  `comboboxProps={{ keepMounted: false }}`. (2) `ColorInput` calls `onChange` again on blur, which saved the default
  colour as an override when you just tabbed through. Now a value equal to the level's default (or an empty input)
  removes the override, `onChange` only fires on a real change, and an empty `levelColors` becomes `undefined`.
  Typing an invalid colour keeps a local draft and goes back to the saved colour on blur.
- **Tested as a user.** No app mounts the panel yet (`viz-native-types-mounted` does that). So I used a throwaway
  vitest harness (deleted): config in `useState`, the panel plus `LogStreamView` fed by `renderChart`, `FIVE_LOGS`
  with an extra `app_logs_message` column. Picked Line field → Message: the rows showed `msg-4 … msg-0`. Toggled Wrap
  lines: the lines went from `pre` to `pre-wrap`. Typed `#123456` in Error colour: the error row's bar turned
  rgb(18,52,86) and the config held `levelColors.error`. Cleared it: back to the default red, override removed. After
  `bash ./init.sh` the check passes 6/6. Frontend tsc and oxfmt are clean. oxlint is clean on the new file; the package
  lint has 37 errors without this change too, mostly `only-export-components` in the protected acceptance
  `fixtures.tsx`.
- **For the next sessions.** When mounting, map the explore's dimensions to `fields` (id = field id, label = field
  label) and wire `onChange` to the chart config store.
- 2026-11-08T19:19:07Z supervisor: viz-log-stream-config-panel passed the gate in round 1

### 2026-11-08 viz-trace-waterfall-model (session)

- **What.** New `packages/visualization/src/traceWaterfall/` (`config.ts`, `model.ts`, `index.ts`, unit test).
  `renderChart` on `trace_waterfall` now returns `{kind: 'traceWaterfall', chartType, model}` (was `unsupported`);
  `UnsupportedChartType` is now only MAP and DATA_APP_VIZ. `resolveTraceWaterfallChartConfig` keeps configured field
  ids the data has and binds the rest to the `trace()` columns by name (id is `<col>` or ends in `_<col>`, else a label
  equal to the column with spaces read as `_`); `span_id` never binds a `parent_span_id` column. No rows →
  `empty/noRows`; no span id column → `empty/incompleteConfig`. Model shape is the one in "Visualization engine" above:
  `traces[{traceId, startMs, durationMs, spans}]`, span `{spanId, parentSpanId, traceId, service, name, status,
  attributes, offsetMs, durationMs, reportedDurationMs, depth, isOrphan, isClamped, color}`. Model types exported from
  the package index. README and `scripts/smoke-pack/consumer.ts` (exhaustive switch) gained the new kind.
- **Decisions.** Traces in row order of first appearance. Roots and each span's children sorted by start (no-time
  spans last, ties by row order). Trace window = earliest root start to latest root end (falls back to all spans if no
  root has a time). Service colours: the render palette (`options.colors.palette`, default `ECHARTS_DEFAULT_COLORS`)
  in waterfall order of first appearance across all traces, so a service keeps its colour when the picker switches
  traces; wraps after the palette length. Duration: `Number(raw)`, negative/invalid → 0. Status is the raw text.
- **For the next sessions.** (1) *Orphans*: so no span is ever dropped, a span whose parent is not in its trace is
  already rooted (depth 0, `isOrphan: true`), ordered by start among roots; spans only reachable through a parent cycle
  are rooted too. `viz-trace-waterfall-orphans` already passes (3/3, checked this session); that session only needs to confirm it as a user. (2) *Clock skew is NOT done*: `isClamped` is
  always `false` and `durationMs === reportedDurationMs`; a skewed child can have a negative offset or overrun its
  parent. `viz-trace-waterfall-clock-skew` should clamp in `buildTrace` (`model.ts`) during placement, against the
  parent's (already clamped) window.
- **Tested as a user.** No app mounts the waterfall yet, so I drove the built package's public `renderChart` from a
  throwaway Node script (deleted) with five `trace()`-shaped rows (bare column names, `start` as Date, attributes as
  JSON text and as an object) and no chart config: got `traceWaterfall`, trace `trace-a`, 200 ms, spans a(0) e(1)
  b(1) c(2) d(2) at +0/+5/+10/+20/+80 ms, five distinct colours, attributes parsed; with no rows got `empty noRows`.
  After `bash ./init.sh` the check passes 7/7; `log-stream-model` 9/9 and `render.test.ts` 21/21 still pass;
  visualization and frontend typechecks clean; oxlint/oxfmt clean on the new and touched src files (the package
  README was already not oxfmt-clean before this change and is not in the `format` script).
- 2026-11-08T19:24:50Z supervisor: viz-trace-waterfall-model passed the gate in round 1

### 2026-11-08 viz-trace-waterfall-orphans (session)

- **What.** No code change. `placeSpans` in `packages/visualization/src/traceWaterfall/model.ts` (from
  `viz-trace-waterfall-model`) already roots a span whose parent is not in its trace (depth 0, `isOrphan: true`),
  orders it by start among the roots and keeps its children under it. This session confirmed that and changed nothing.
- **Tested as a user.** No app mounts the waterfall yet, so I drove the built package's public `renderChart`
  (`dist/cjs`) from a throwaway Node script (deleted) with `trace()`-shaped rows a→b→c plus `f` (parent
  `missing-parent`, start +50 ms) and its child `g`. Got `traceWaterfall` with spans a(0) b(1) c(2) f(0, orphan)
  g(1, not orphan) at +0/+10/+20/+50/+55 ms. After `bash ./init.sh` the check passes 3/3.
- **For the next sessions.** A span whose parent id is its own id is rooted and flagged `isOrphan: true`, the same
  as a missing parent. Clock skew is still not done (see the model entry above).
- 2026-11-08T19:26:41Z supervisor: viz-trace-waterfall-orphans passed the gate in round 1

### 2026-11-08 viz-trace-waterfall-clock-skew (session)

- **What.** `packages/visualization/src/traceWaterfall/model.ts`: `placeSpans` now records each placed span's drawn
  parent (`PlacedSpan.parent`), and a new `spanWindows` pass (depth-first order, so a parent is known before its
  children) clamps each child's reported window `[start, start + duration]` into its parent's already clamped
  window. `offsetMs`/`durationMs` come from the clamped window; `reportedDurationMs` stays as the data reported;
  `isClamped` is true when the start or the end moved.
- **Decisions.** Roots (including orphans and cycle-rooted spans) are never clamped, so the trace window is still
  measured from the roots. A child with no time, or whose parent has no time, keeps its reported window (offset 0 if
  no time, as before). A child entirely outside its parent becomes a zero-length bar at the nearer parent edge, flagged.
  Clamping cascades: a grandchild is clamped against its parent's clamped window.
- **Tested as a user.** No app mounts the waterfall yet, so I drove the built `dist/cjs` `renderChart` from a throwaway
  Node script (deleted) with root 0–200 ms, `early` at −20 ms for 30 ms, its child `grand` at −15 ms for 20 ms, `late`
  at 190 ms for 50 ms and `fine` at 40 ms for 20 ms. Got trace 200 ms; early +0 ms/10 ms clamped, grand +0 ms/5 ms
  clamped, fine +40 ms/20 ms not clamped, late +190 ms/10 ms clamped (reported 50). After `bash ./init.sh` the check
  passes 5/5; `trace-waterfall-model` 7/7 and `trace-waterfall-orphans` 3/3 still pass; visualization typecheck,
  oxlint and oxfmt clean on the file.
- **For the next sessions.** The span drawer feature ("See a note when the span was clamped") can read `isClamped` and
  compare `durationMs` with `reportedDurationMs`.
- 2026-11-08T19:29:03Z supervisor: viz-trace-waterfall-clock-skew passed the gate in round 1

### 2026-11-08 viz-trace-waterfall-view (session)

- **What.** New `packages/frontend/src/components/TraceWaterfall/`: `TraceWaterfallView.tsx` (+ CSS module) and
  `traceWaterfallFormat.ts` (`isErrorStatus`, `formatDurationMs`, `percentOf`). The view takes the
  `TraceWaterfallModel` and draws the **first** trace: a time axis (`data-testid="trace-time-axis"`, labels at 0, ¼,
  ½, ¾ and the full trace duration) above one row per span in model order (`trace-span-row` with `data-span-id`,
  `data-depth`, `data-status`), each with name, service, duration and a bar (`trace-span-bar`) whose inline `left`
  / `width` are `offsetMs` / `durationMs` as a percentage of the trace duration, coloured with `span.color`. No
  traces or no spans shows "No spans".
- **Decisions.** Error = status `error` or `STATUS_CODE_ERROR`, any case, trimmed; `data-status` is then `error`,
  otherwise `ok` (also for blank or other statuses). Error rows get a red-light background, a red outline on the bar
  and a warning icon (aria-label "Error"). Durations print as `50 ms` (≤2 decimals) and `1.5 s` from 1000 ms up.
  Indentation is a `--span-depth` CSS variable (16 px per level). Not virtualised. Bars already use the service
  colour, but the legend is left to `viz-trace-waterfall-service-colours`. The view is not mounted in any chart
  yet (mounting belongs to a later feature, as with `LogStreamView`).
- **Tested as a user.** No app mounts it, so I rendered it with the fixtures' real model (BASIC_TRACE plus a
  `STATUS_CODE_ERROR` grandchild of c, 1500 ms, clamped by the model) from a throwaway vitest file (deleted): axis
  `0 ms 50 ms 100 ms 150 ms 200 ms`; rows a(0) e(1) b(1) c(2) g(3) d(2) with names, services and durations
  (c "50 ms", g "40 ms" clamped); bars a 0%/100%, c 10%/25%, d 40%/2.5%; d and g marked error, the rest ok.
  After `bash ./init.sh` the check passes 5/5; frontend `tsc --noEmit` clean; oxlint and oxfmt clean on the new
  files.
- **For the next sessions.** Collapse (buttons "Collapse <name>"/"Expand <name>"), the span drawer (click on the
  name) and the trace picker (replace `model.traces[0]`) all hang off `SpanRow` / `TraceWaterfallView` here.
- 2026-11-08T19:32:37Z supervisor: viz-trace-waterfall-view passed the gate in round 1

### 2026-11-08 viz-trace-waterfall-service-colours (session)

- **What.** `TraceWaterfallView.tsx` gains a `ServiceLegend` (`data-testid="trace-service-legend"`, aria-label
  "Services") above the time axis: one `trace-service-legend-item` (`data-service`) per service of the shown trace, in
  order of first appearance in the span rows, each a 10 px swatch in the model's `span.color` and the service name
  (blank service shows "(no service)"). CSS classes `.legend` and `.swatch` in the module. Bars already used
  `span.color` since `viz-trace-waterfall-view`, so no change there.
- **Decisions.** The legend lists only the services of the drawn trace (`model.traces[0]`), not every service in the
  model; the colour comes from the model, which assigns one colour per service across the whole model, so the trace
  picker feature can reuse this legend unchanged. Colours repeat only when there are more services than palette
  entries (model behaviour, unchanged).
- **Tested as a user.** No app mounts the view yet, so I rendered it from a throwaway vitest file (deleted) with
  BASIC_TRACE plus a second postgres span: legend gateway, auth, orders-api, postgres, redis, each in a different
  colour; every row's bar matched its service's legend swatch (both postgres spans the same yellow). After
  `bash ./init.sh` the check passes 2/2; `trace-waterfall-view` 5/5 still passes; frontend `tsc --noEmit` clean;
  oxlint and oxfmt clean on the component folder.
- 2026-11-08T19:35:13Z supervisor: viz-trace-waterfall-service-colours passed the gate in round 1

### 2026-11-08 viz-trace-waterfall-collapse (session)

- **What.** `TraceWaterfallView.tsx`: every span with children gets a chevron `ActionIcon` before its name, labelled
  "Collapse <name>" / "Expand <name>" with `aria-expanded`; leaves get a same-width placeholder (`.togglePlaceholder`
  in the CSS module) so names stay aligned. The view keeps a `Set` of collapsed span ids in state; `visibleRows`
  walks the model's depth-first spans and skips, after a collapsed span, the run of following spans deeper than it
  (that run is exactly its subtree). "Has children" = the next span is deeper.
- **Decisions.** Collapse state is per span id and survives collapsing an ancestor: collapse b, collapse a, expand
  a → b is still collapsed. All spans start expanded. State is not reset when the model changes (ids that vanish
  are harmless); revisit if the trace picker needs a reset per trace.
- **Tested as a user.** No app mounts the view yet, so I drove it with user-event from a throwaway vitest file
  (deleted) on BASIC_TRACE: buttons only on "GET /orders" and "orders.list", both expanded; collapse orders.list →
  rows a e b; collapse GET /orders → a; Enter on "Expand GET /orders" → a e b with orders.list still collapsed;
  expand orders.list → a e b c d. After `bash ./init.sh` the check passes 3/3; `trace-waterfall-view` 5/5 and
  `trace-waterfall-service-colours` 2/2 still pass; frontend `tsc --noEmit` clean; oxlint and oxfmt clean.
- 2026-11-08T19:38:11Z supervisor: viz-trace-waterfall-collapse passed the gate in round 1

### 2026-11-08 viz-trace-waterfall-span-drawer (session)

- **What.** New `components/TraceWaterfall/SpanDetailDrawer.tsx`: a right-side Mantine `Drawer` (role dialog,
  `data-testid="trace-span-drawer"` on its body) titled with the span name, listing service, status (red when an
  error), Duration (= `reportedDurationMs`), "Drawn duration" (= bar `durationMs`, only when clamped), start offset,
  span id, parent span id (when not a root), trace id, and an attributes table (`trace-span-attributes`; strings
  as-is, other values as JSON, "No attributes" when empty). Yellow alert when `isClamped` ("...clamped because of
  clock skew"), grey alert when `isOrphan`. `TraceWaterfallView.tsx`: the span name is now an `UnstyledButton`
  (aria-label "Show details of <name>") that selects the span; the view keeps `selectedSpanId` and looks the span up
  in the current trace (closes itself if the span vanishes). CSS: `.detailLabel`, `.attributeValue`, `.nameButton`.
- **Decisions.** Only the name opens the drawer (not the bar or whole row), so the collapse chevron never opens it.
  The drawer's duration is the reported one; the clamped bar length is a separate row. Keep the clamp note as the
  single element mentioning "clamped"/"clock skew" and no other "50 ms"-like text, or the acceptance `getByText`
  calls become ambiguous.
- **Tested as a user.** No app mounts the view yet, so I drove it with user-event from a throwaway vitest file
  (deleted) on BASIC_TRACE + a clamped `late` span + an orphan: collapse/expand chevron opened no drawer; clicking
  "GET /orders" showed gateway, ok, 200 ms, id a, trace-a, http.method GET, http.route /orders; Escape closed it;
  "payments.authorize" showed the clock-skew note, Duration 50 ms, Drawn duration 10 ms; Enter on the orphan's name
  button showed the orphan note and parent id zz. After `bash ./init.sh` the check passes 3/3; view 5/5, collapse
  3/3, service-colours 2/2 still pass; frontend `tsc --noEmit` clean; oxlint and oxfmt clean.
- 2026-11-08T19:42:00Z supervisor: viz-trace-waterfall-span-drawer passed the gate in round 1

### 2026-11-08 viz-trace-waterfall-trace-picker (session)

- **What.** `TraceWaterfallView.tsx`: when `model.traces` holds more than one trace, a searchable Mantine `Select`
  above the legend lists them as "<traceId> (<n> spans)" and switches the drawn trace. The view keeps the picked
  trace id in state and falls back to the first trace when none is picked or the picked id is gone from the model.
  One trace (or none) shows no picker. CSS: `.tracePicker`, `.traceSelect`. The model already grouped spans by
  trace, so `@lightdash/visualization` is unchanged.
- **Trap.** Mantine 9 `Select` copies its `label` (or, without one, its `aria-label`) onto the options listbox, which
  stays mounted while closed, so `getByLabelText('Trace')` found two elements. The visible "Trace" is a `Text` with a
  `useId` id and the Select names itself with `aria-labelledby`; Mantine doesn't pass that on to the listbox.
- **Decisions.** Collapse state (a set of span ids) and the selected span are not reset when switching traces: span
  ids differ across traces, so collapsing in trace-b and coming back finds it still collapsed, and the drawer closes
  because the selected span isn't in the new trace.
- **Tested as a user.** No app mounts the view yet, so I drove it with user-event from a throwaway vitest file
  (deleted) on BASIC_TRACE + a two-span trace-b: it opened on trace-a (rows a e b c d, 5 services, axis to 200 ms);
  the options were "trace-a (5 spans)" and "trace-b (2 spans)"; picking trace-b showed b-root b-child, a worker legend
  and an axis to 40 ms; collapsing job.run and opening its drawer worked; typing "trace-a" filtered to one option and
  ArrowDown+Enter switched back; picking trace-b again still had job.run collapsed. A single trace showed no combobox.
  After `bash ./init.sh` the check passes 3/3; view 5/5, collapse 3/3, span-drawer 3/3, service-colours 2/2 still
  pass; frontend `tsc --noEmit` clean; oxlint and oxfmt clean on the component folder.
- 2026-11-08T19:45:47Z supervisor: viz-trace-waterfall-trace-picker passed the gate in round 1

### 2026-11-08 viz-trace-waterfall-config-panel (session)

- **What.** New `packages/frontend/src/components/VisualizationConfigs/TraceWaterfallConfig/TraceWaterfallConfigPanel.tsx`,
  a controlled panel like `LogStreamConfigPanel`: props `config: TraceWaterfallChart`, `fields: { id, label }[]`,
  `onChange(config)`. One "Span fields" section with nine searchable, clearable Mantine `Select`s: "Trace ID field",
  "Span ID field", "Parent span ID field", "Service field", "Span name field", "Start field", "Duration field" (description
  "In milliseconds"), "Status field", "Attributes field". Each pick calls `onChange({ ...config, [key]: value })`;
  clearing sets the key to `undefined`, so `@lightdash/visualization` detects the column by name again
  (placeholder "Detect automatically").
- **Trap (same as log stream).** Pickers pass `comboboxProps={{ keepMounted: false }}`, else the always-mounted listbox
  shares the label and `getByLabelText` finds two elements. Keep labels distinct for the acceptance regexes:
  `/^span id field/` must not hit "Parent span ID field", `/duration field/` needs the label to be exactly
  "Duration field" (not "Duration (ms) field").
- **Tested as a user.** No app mounts the panel yet (`viz-native-types-mounted` does that). Throwaway vitest harness
  (deleted): config in `useState`, panel + `TraceWaterfallView` fed by `renderChart`, `BASIC_TRACE` plus a
  `spans_service_name` column ("svc-<service>"). All nine pickers showed their bound field; the Service options listed
  all ten fields; picking "Service name" set `serviceFieldId: 'spans_service_name'` and the legend changed from
  gateway/auth/orders-api/postgres/redis to svc-gateway/...; clearing the picker set it to `undefined` and the legend
  went back (auto-detected `spans_service`). After `bash ./init.sh` the check passes 2/2. Frontend `tsc --noEmit`
  clean; oxlint and oxfmt clean on the new folder.
- **For the next sessions.** When mounting, map the explore's dimensions to `fields` and wire `onChange` to the chart
  config store, as for the log stream panel.
- 2026-11-08T19:48:43Z supervisor: viz-trace-waterfall-config-panel passed the gate in round 1

### 2026-11-08 viz-native-types-mounted (session)

- **What.** The two native types are now drawn and edited by the app.
  - New `components/TelemetryChart/index.tsx` (`TelemetryChart`): reads `useVisualizationConfig()` and
    `useVisualizationInputs()`, calls `renderChart` from `@lightdash/visualization` with `{ rows: resultsData.rows,
    fields: itemsMap }` and the colour palette, then draws `LogStreamView` (height from Mantine `useElementSize`, 400 px
    before it is measured) or `TraceWaterfallView`. `empty` output shows a "No data available" SuboptimalState. It asks
    for every page (`setFetchAll(true)`) like Sankey, shows `LoadingChart` while loading, and signals screenshot-ready.
    `LightdashVisualization/index.tsx` mounts it for both types instead of the "can't be displayed yet" placeholder, so
    the explorer and dashboard tiles (both go through `LightdashVisualization`) draw the same view.
  - New `components/VisualizationConfigs/TelemetryConfig/TelemetryConfigTabs.tsx` (`ConfigTabs`): renders
    `LogStreamConfigPanel` or `TraceWaterfallConfigPanel` with `fields` = the itemsMap as `{ id, label }`
    (`getItemLabelWithoutTableName`) and `onChange` = the adapter's `setConfig`. `Explorer/VisualizationCard/
    VisualizationConfig.tsx` returns it for both types (`NoConfigTabs` removed).
  - `VisualizationTelemetryConfig.tsx` adapter: `chartConfig` is now `{ validConfig, setConfig }`; `setConfig` calls the
    provider's `forwardChartConfig` (not `emitChartConfig`: the adapter keeps no local state, the owner's echoed prop is
    the next config). New guards in `types.ts`: `isLogStreamVisualizationConfig`, `isTraceWaterfallVisualizationConfig`,
    `isTelemetryVisualizationConfig`.
  - Gallery: `useChartTypeOptions.tsx` lists "Log stream" (`IconListDetails`) and "Trace waterfall" (`IconTimeline`)
    after "Big value", selecting via `resetCartesian(ChartType.X)`; the explorer seeds `{}` (DEFAULTS), so columns bind
    by name. `ChartTypeGallery.test.tsx`'s `BUILT_IN_LABELS` got the two labels (that file uses `renderWithProviders`,
    so it is red upstream anyway).
- **Decision.** With an empty config the field pickers show "Detect automatically" (blank) even though the model has
  auto-bound a column; showing the auto-detected column in the picker would need the resolved config exposed to the
  panel. Left as is.
- **Tested as a user.** No backend/DB locally, so a throwaway vitest harness (deleted) rendered the real
  `VisualizationProvider` (owner state for chartConfig, app `MantineProvider`, QueryClient, MemoryRouter,
  ChartColorMappingContextProvider; Monaco, web worker and server feature flag mocked) with a probe over
  `useChartTypeOptions`, the real `VisualizationConfig` tab and `LightdashVisualization`, on synthetic logs results
  (`FIVE_LOGS`). The gallery listed ...Big value | Log stream | Trace waterfall. Picking Log stream set
  `{type:'log_stream',config:{}}` and drew the 5 lines newest first with "5 of 5 lines" and Download CSV; the config tab
  showed the pickers and switches, and toggling Wrap lines saved `wrapLines: true`. Switching to spans results
  (`BASIC_TRACE`) and picking Trace waterfall drew the legend gateway/auth/orders-api/postgres/redis, axis 0-200 ms and the
  five spans, and the gallery marked it selected; picking Service field = Name saved `serviceFieldId: 'spans_name'` and
  the legend changed to the span names. Two dashboard-style providers (`isDashboard`, no config owner, saved configs)
  drew the same log stream and waterfall in `LightdashVisualization isDashboard`. After `bash ./init.sh` the check passes
  (5/5 and all five typechecks); `useChartTypeOptions.test.tsx` 5/5; oxlint and oxfmt clean on the touched files.
- **Trap.** In zsh, `F="a b"; oxlint $F` passes one argument (no word splitting) and oxlint reports "0 files"; use an
  array. Vitest hides `console.log` from passing tests here; write harness output to a file in `../tmp` instead.
- 2026-11-08T19:59:51Z supervisor: viz-native-types-mounted passed the gate in round 1

## viz-grafana-thresholds (round 1)
- **What.** New `packages/common/src/eng1799/grafanaThresholds.ts`, exported from `@lightdash/common` index:
  - `GrafanaThresholds` / `GrafanaThresholdStep` / `GrafanaThresholdRange` types (shape of a panel's
    `fieldConfig.defaults.thresholds`; base step has `value: null`).
  - `GRAFANA_NAMED_COLORS` + `resolveGrafanaColor(color)`: Grafana palette names (red, orange, yellow, green, blue,
    purple, each with `super-light-`, `light-`, `semi-dark-`, `dark-` shades) to hex; anything else (hex, rgb(), CSS
    names) passes through unchanged. Lookup is case-insensitive.
  - `getThresholdColor(value, thresholds, range = {min:0,max:100})`: colour of the highest step at or below the value;
    in `percentage` mode step values are read as % of min..max (Grafana's default 0..100 when no range is given).
  - `grafanaThresholdsToGaugeSections(thresholds, range = {min:0,max:100})`: one `GaugeSection` per step, step start to
    next step start, clamped to min..max; empty sections (steps outside the range) are dropped. Percentage steps are
    converted to absolute values in the range.
- **Tested as a user.** No UI consumer yet (the Grafana importer line consumes this). Ran a throwaway node script
  (deleted) against the built `dist/cjs` with a gauge panel's fieldConfig (min 0, max 100, green / 80 orange / 90 red):
  12 and 79.99 -> #73BF69, 80/85 -> #FF9830, 90/120 -> #F2495C; sections [0-80 green, 80-90 orange, 90-100 red];
  percentage mode over 0..500 gives 420 -> orange and sections 0-400/400-450/450-500; max 50 gives a single green
  section. Check passes 4/4 after `bash ./init.sh`; common linter, oxfmt and `tsc --noEmit` clean.
- **For later sessions.** Grafana unit / panel-type / option mapping features can live next to this in `eng1799/`.
  Run oxlint via `pnpm -F common run linter <files>` (`pnpm exec oxlint` at the root is not found).
- 2026-11-08T20:03:24Z supervisor: viz-grafana-thresholds passed the gate in round 1

## viz-value-mappings (round 1)
- **What.** New `packages/common/src/eng1799/grafanaValueMappings.ts`, exported from `@lightdash/common` index:
  `GrafanaValueMapping` (value / range / regex / special, shaped like a panel's `fieldConfig.defaults.mappings`) and
  `applyValueMappings(value, mappings)` -> `{text, color, icon, index}` or undefined.
  - value: `String(value)` looked up in the options (so `0` matches key `'0'`); range: inclusive, null/missing bound is
    open, numeric strings are parsed; regex: Grafana's `stringToJsRegex` (bare pattern anchored `^...$`, `/p/flags`
    literal as written), only for string values, text substituted with `value.replace(regex, text)` so `$1` works;
    special: `null` (null/undefined), `nan`, `null+nan`, `true`, `false`, `empty`.
  - Precedence: the matching result with the lowest `index` wins (Grafana editor row order); results with no index
    come after, in array order. Colours go through `resolveGrafanaColor` (palette names -> hex).
- **Decision.** Grafana treats a `null` range bound as 0 (`isNaN(null)` is false); here null/missing bounds are open,
  which is what the editor shows for an empty bound.
- **Tested as a user.** No UI consumer yet. Throwaway node script (deleted) against built `dist/cjs` with 0->Down red,
  10-20->Busy orange, null->N/A: 0 and '0' -> Down #F2495C; 10/15/20 -> Busy #FF9830; 21 and 5 -> undefined; null and
  undefined -> N/A; regex `host-(\d+)` -> 'Host $1' gave "Host 7" for host-7 and nothing for xhost-7; overlapping
  range(index 1)/value(index 0) on 5 -> Early. Check 7/7 after `bash ./init.sh`; linter, oxfmt, `tsc --noEmit` clean.
- 2026-11-08T20:05:47Z supervisor: viz-value-mappings passed the gate in round 1

## viz-grafana-unit-formats (round 1)
- **What.** New `packages/common/src/eng1799/grafanaUnits.ts`, exported from `@lightdash/common` index:
  `grafanaUnitToCustomFormat(unit, { decimals })` -> `CustomFormat` (undefined for an empty/missing unit, so the caller
  keeps the field's own format). `decimals` becomes `round` (rounded, min 0); unset keeps automatic decimals.
  - `none` -> NUMBER; `short` -> NUMBER with compact auto; `percent` (0-100) -> NUMBER with suffix `%`; `percentunit`
    (0-1) -> PERCENT; `bytes`/`Bps`/`binBps` -> BYTES_IEC, `decbytes`/`decBps` -> BYTES_SI; time units (ns, µs/us, ms,
    s, m, h, d) and rates (reqps, reqpm, ops, opm, rps, wps, iops, cps, bps, pps) -> NUMBER with a fixed suffix
    (` ms`, ` req/s`, ...); dateTimeAs{Iso,System,US} -> TIMESTAMP; currencyUSD/GBP/EUR -> CURRENCY; Grafana custom
    `suffix:X` / `prefix:X`; anything else is a free-text suffix (`vCPU` -> "4 vCPU").
- **Gaps (in the module doc).** Grafana auto-scales bytes/time/rates (1500 ms -> 1.5 s); Lightdash keeps the base
  unit (byte formats have no compact set, so they render as plain byte counts). Byte rates lose their "/s". `Bps` is
  mapped IEC because the acceptance test requires it (current Grafana labels Bps as SI) - revisit in the importer.
- **Tested as a user.** Throwaway node script (deleted) against built `dist/cjs`: panel `{unit:'ms', decimals:1}` ->
  `{type:number, suffix:' ms', round:1}` -> "12.3 ms" for 12.3456; percentunit 0.42 -> "42%"; percent 42 -> "42%";
  s 30 -> "30 s"; reqps 12 -> "12 req/s"; ops 7 -> "7 ops/s"; vCPU 4 -> "4 vCPU"; short 1234567 -> "1.235M";
  `suffix:/h` -> "3/h"; `constructor` is a free-text unit (own-property lookup), '' -> undefined. Check 12/12 after
  `bash ./init.sh`; linter, oxfmt, `tsc --noEmit` clean.
- **Trap.** `npx tsc` in packages/common fails on the node devEngines pin; use `pnpm exec tsc`.
- 2026-11-08T20:08:46Z supervisor: viz-grafana-unit-formats passed the gate in round 1

## viz-registry-build (round 1)
- **What.** New pnpm workspace package `chart-registry` (added to `pnpm-workspace.yaml`; `pnpm install --prefer-offline`
  added only its importer to `pnpm-lock.yaml`, no new packages; `--offline` fails on the devEngines node pin).
  `pnpm -F chart-registry build` runs `tsx scripts/build.ts`, which wipes and writes `chart-registry/dist/`:
  `index.json` + `index-next.json` (same charts), `charts/<slug>/<version>/{entry.json,source.tar,dist.tar}` and any
  `screenshot-*.png` the chart ships.
  - A chart is `src/charts/<slug>/` with `registry.json` (name, description, version, publishedAt, changelog, tags,
    icon, vizSchema, preview) and `index.ts`. esbuild bundles `index.ts` as one minified IIFE ->
    `dist/assets/<slug>.js`; `dist/index.html` comes from `src/shared/index.html` (external `<script src>` and
    `style.css` only, CSP-safe). source.tar = the `src/` files esbuild bundled (from its metafile) + registry.json +
    the shared template/css, so relative imports resolve inside the tar.
  - Validation: entry.json is the snapshot shape and goes through `parseChartRegistryVersionSnapshot`; the **index
    entry is the parsed snapshot**, so index and entry.json cannot disagree (thumbnail = first screenshot, as the
    client derives it). Index goes through `chartRegistryIndexSchema` and `parseChartRegistryIndexTolerant` (build fails
    if anything is dropped). Build also fails without the `houserx` tag or `preview.rows`.
  - Tars are deterministic (sorted, mtime = publishedAt, mode 644, uid/gid 0): rebuilding gives identical digests, so a
    published version stays immutable. Bump `version` (and publishedAt) in registry.json for any change to a chart.
  - `src/shared/vizContext.ts`: React-free viz protocol (listen for `lightdash:sdk:data-app-viz-context`, post
    `viz-context-request`, ack `viz-rendered` after two frames) plus `rawValue` (via fieldMapping), `toNumber`,
    `option` helpers for the other entries.
- **Decision.** The build needs at least one entry, so the first entry is `histogram` (simplest of the six), fully
  implemented: `value` field (type column), `bucketCount` number option, `histogram-bar` SVG rects with `data-count`,
  `data-from`, `data-to`, `data-color` (first palette colour), "No data" when empty. `histogram.test.ts` already
  passes (3/3); the viz-registry-histogram session only needs to verify it. No screenshots yet (no renderer for PNGs
  without canvas); the gallery has `preview.rows`.
- **Tested as a user.** `pnpm -F chart-registry build` -> "built 1 chart(s) into dist: histogram@1.0.0"; listed
  dist (index.json, index-next.json, charts/histogram/1.0.0/{entry.json,source.tar,dist.tar}); `tar tvf` shows
  dist.tar = dist/index.html + dist/assets/{histogram.js,style.css}, source.tar = src/...; rebuilt and digests matched.
  Served dist over HTTP to the real ChartRegistryClient (`client-install.test.ts`, 4/4: index, version entry, digest-
  checked downloads, next channel). Check `build.test.ts` 10/10 after `bash ./init.sh`; `tsc --noEmit` and oxfmt clean.
- **For later sessions.** Add an entry = new `src/charts/<slug>/` dir; nothing in the build script changes. Bundling
  `@lightdash/common` helpers into an entry pulls its whole import graph into the IIFE - prefer importing the
  specific `src/eng1799/*` module files (or copy small helpers into `src/shared/`) and check bundle size.
- 2026-11-08T20:15:29Z supervisor: viz-registry-build passed the gate in round 1

## viz-registry-client-install (round 1)
- **What.** No code change needed: viz-registry-build already produced a registry the real client reads. This session
  verified it end to end. Check `client-install.test.ts` 4/4 after `bash ./init.sh`.
- **Tested as a user.** Served `chart-registry/dist` from a local HTTP server and set `LIGHTDASH_CHART_REGISTRY_URL`
  (+ `LIGHTDASH_CHART_REGISTRY_ALLOW_INSECURE=true` for http/loopback) and `LIGHTDASH_CHART_REGISTRY_CHANNEL`
  stable/next. Read them through the backend's real `parseConfig()`, built `ChartRegistryClient` exactly as
  `ee/index.ts` does, and ran the client calls `listRegistryChartTypes`/`installRegistryChartType` make before S3:
  `getIndex` (GET /index.json, or /index-next.json on next) listed `histogram@1.0.0` tagged houserx; `getVersionEntry`
  -> entry.json; `downloadArtifact` source.tar (17408 B) and dist.tar (7168 B), with recomputed sha256 equal to the
  entry digests; dist.tar passes `assertValidDistTar`. Same result on both channels.
- **Not done / for later.** The browser library UI and the full install (S3 copy + DB rows) were not driven: they need
  Postgres, an S3/MinIO store, the `ChartTypeRegistry` flag and a login, and this line has no Docker. The image
  check (`getAsset`) is vacuous until a chart ships `screenshot-*.png` (previews feature). A local registry needs
  `LIGHTDASH_CHART_REGISTRY_ALLOW_INSECURE=true` (http + loopback). `ALLOW_PRIVATE_HOSTS` alone still requires https.
- Scratch driver left in `../tmp/drive-registry/` (outside the repo; deleting it was refused by the sandbox).
- 2026-11-08T20:18:15Z supervisor: viz-registry-client-install passed the gate in round 1

## viz-registry-heatmap (round 1)
- **What.** New entry `chart-registry/src/charts/heatmap/` (build script unchanged). `heatmap.ts` has the pure model:
  `buildHeatmap` (one cell per distinct (time, bucket); rows missing time/bucket/numeric value are skipped; repeated
  pairs add up), `compareBuckets` (numeric `le` order, `+Inf` last, non-numeric labels after by name), `compareTimes`
  (chronological), `interpolateColor` (linear RGB across `#RRGGBB` stops). `index.ts` draws SVG rects
  `heatmap-cell` with `data-time` (the raw time string; epoch millis/Date become ISO), `data-bucket`, `data-value`,
  `data-color`; `heatmap-y-label` per bucket in sorted order (lowest at the bottom, +Inf on top, as Grafana);
  `heatmap-x-label` HH:MM UTC, thinned to ~8; "No data" (`heatmap-empty`) when no cell.
- **Schema.** Fields `time` (dimension), `bucket` (dimension), `value` (metric). One config option `colorScale`
  (type `gradient`, default `#FCE2C9 -> #FF9830 -> #C4162A`, min/max `auto` = data min/max; equal min/max paints the
  top colour). `colorPalette: null` (the heatmap does not use the series palette).
- **Decision.** Bucket values are drawn as given, not de-accumulated: Prometheus `_bucket` series are cumulative, so the
  query should send per-bucket counts/rates (the acceptance data is not cumulative either). Preview rows are synthetic
  per-bucket counts for 6 times x 4 buckets.
- **Tested as a user.** Built the registry (`heatmap@1.0.0, histogram@1.0.0`), read `index.json` (fields
  time/dimension, bucket/dimension, value/metric), untarred dist.tar and ran its bundle in jsdom as the host would,
  with Lightdash-style field ids in `fieldMapping` and string numerics, buckets shuffled `1,+Inf,0.1,0.5`: 16 cells,
  y labels 0.1, 0.5, 1, +Inf bottom to top, x labels 12:00-12:03, colours ramp with value, `viz-rendered` ack sent.
  Check `heatmap.test.ts` 5/5 after `bash ./init.sh`; regressions build 17/17, histogram 3/3, client-install 4/4;
  `tsc --noEmit` and oxfmt clean. Scratch driver in `../tmp/drive-heatmap/` (outside the repo).
- 2026-11-08T20:22:06Z supervisor: viz-registry-heatmap passed the gate in round 1

## viz-registry-state-timeline (round 1)
- **What.** New entry `chart-registry/src/charts/state-timeline/` (build script unchanged). `stateTimeline.ts` has the
  pure model `buildStateTimeline`: rows without time or series are skipped; series keep first-appearance order; within
  a series points are read in time order and consecutive equal states (compared as trimmed text) merge into one
  segment that lasts until the next point; the last point lasts until domain end = latest time + smallest gap between
  distinct times (one sample interval). A null/blank state ends the run before it and leaves a gap (Grafana's null
  handling). `index.ts` draws SVG `g[data-testid=state-timeline-row][data-series]` with series label and
  `rect[data-testid=state-timeline-segment]` carrying `data-state` (state text), `data-text` (mapped text),
  `data-start`/`data-end` (ISO), `data-color`; mapped text drawn inside a segment when it fits; x labels at sample
  times (HH:MM UTC, HH:MM:SS for sub-minute samples, thinned to one per 80px); an HTML legend
  (`state-timeline-legend-item`) per state; "No data" (`state-timeline-empty`).
- **Schema.** Fields `time`, `series`, `state` (all dimension, required). One option `valueMappings` (type `text`,
  default `""`): Grafana's mappings array as JSON text; blank/malformed gives no mappings. `colorPalette: {}`: states
  with no mapping colour take palette colours by first appearance. Preview: 3 synthetic services x 8 times with
  `optionValues.valueMappings` (up/degraded/down -> Healthy/Degraded/Outage, green/orange/red).
- **Shared helper for later entries.** `chart-registry/src/shared/valueMappings.ts`: `parseValueMappings(option)` and
  `mapValue(raw, mappings)`. It imports `applyValueMappings` straight from
  `packages/common/src/eng1799/grafanaValueMappings.ts` (relative path; only a type import from savedCharts, so the
  bundle stays ~7.4 KB). stat-sparkline and status-grid should reuse it. Trap: legend/caption styles are inline on
  purpose; editing `src/shared/style.css` changes every entry's dist.tar and so needs a version bump for each.
- **Gap.** source.tar only holds `src/...` (build.ts filters inputs to `src/`), so the common value-mapping files
  bundled from `packages/common` are not in source.tar; the source is not standalone-buildable. Revisit if source.tar
  must rebuild on its own (copy the helper in, or widen the build's source filter).
- **Tested as a user.** Built the registry (`heatmap@1.0.0, histogram@1.0.0, state-timeline@1.0.0`), read
  `index.json` (fields time/series/state, option valueMappings text), untarred dist.tar and ran its bundle in jsdom as
  the host does, with Lightdash-style field ids, epoch-millis times, numeric 0/1 states, rows shuffled newest first:
  rows node-b (one segment 1) and node-a (1 | 0 | 1) with palette colours and axis 12:00-12:05; with a value mapping
  0->Outage/red, 1->Healthy/green the segments read Healthy/Outage in #73BF69/#F2495C and the legend shows them;
  malformed JSON falls back to unmapped; a null state leaves a gap; no rows shows "No data"; `viz-rendered` ack sent.
  Check `state-timeline.test.ts` 3/3 after `bash ./init.sh`; regressions build 24/24, heatmap 5/5, histogram 3/3,
  client-install 4/4; `tsc --noEmit` and oxfmt clean. Scratch driver in `../tmp/drive-state-timeline/` (outside repo).
- 2026-11-08T20:26:49Z supervisor: viz-registry-state-timeline passed the gate in round 1

## viz-registry-stat-value (round 1)
- **What.** New entry `chart-registry/src/charts/stat-sparkline/` (build script unchanged). `stat.ts` is the pure
  model: `orderPoints` sorts rows by the optional `time` field (stable; rows without a time follow in row order) and
  `reduce` implements Grafana reducers `lastNotNull` (default), `last`, `firstNotNull`, `first`, `min`, `max`, `mean`,
  `sum`, `count` (all rows, like Grafana), `range`; nulls are skipped except by last/first/count; null result = no
  value. `index.ts` draws HTML `div[data-testid=stat]` (attrs `data-reducer`, `data-value`, `data-empty`) holding
  `stat-value` (number + `span[data-testid=stat-unit]` suffix) and `stat-label` (the value field's label). A null
  result or no rows shows "No data".
- **Shared helper for later entries.** `chart-registry/src/shared/grafanaFormat.ts`: `formatGrafanaValue(value, unit,
  decimals|null)` -> {prefix, text, suffix} and `formatGrafanaText`. Standalone on purpose (common's `grafanaUnits.ts`
  imports `types/field`, which pulls es-toolkit into the bundle) and it auto-scales like Grafana, which the Lightdash
  CustomFormat mapping cannot: bytes 1536 -> 1.5 KiB (IEC; decbytes SI), ms 1500 -> 1.5 s (ns..year ladder),
  short -> K/Mil/Bil, percentunit x100 + %, Bps/decBps/bps add /s, currency prefixes, `prefix:`/`suffix:` custom,
  unknown unit = " <unit>" suffix. Auto decimals (null): integers 0, |v|>=1 up to 2, below 1 ~3 significant,
  trailing zeros dropped. bar-gauge and status-grid should reuse it.
- **Schema.** Fields `value` (metric, required), `time` (dimension, optional). Options: `reducer` (select, default
  lastNotNull), `unit` (text, ""), `decimals` (number, default -1 = auto, min -1 max 20), and - declared now because
  this feature's schema test requires them, but **not yet acted on** - `thresholds` (text ""), `valueMappings` (text
  ""), `graphMode` (select area|none, default area, Grafana's default), `colorMode` (select value|background|none,
  default value). viz-registry-stat-thresholds / -stat-sparkline / -stat-value-mappings implement them; each of those
  changes dist.tar, so bump the entry's `version` (and changelog) in `registry.json` when you add behaviour.
  `colorPalette: null` for now. Preview: 8 synthetic p95 latency points, `optionValues` unit ms, 1 decimal.
- **Note for value-mappings.** The null special must apply when the reduced value is null (test feeds a single null
  row with default lastNotNull): check mappings before falling back to "No data".
- **Tested as a user.** Built the registry (`heatmap, histogram, stat-sparkline, state-timeline @1.0.0`), read the
  stat entry from `index.json`, untarred dist.tar and ran its bundle in jsdom as the host does, with Lightdash-style
  field ids, digit-string epoch times and string numerics, rows newest first: unit ms + 1 decimal -> "42.5 ms" (latest
  by time, not last row); defaults -> "42.5"; trailing null -> "42.5 ms"; reducer last with trailing null -> "No
  data"; max "99.0 ms"; mean "50.50"; 1500 ms auto -> "1.5 s"; 5 GiB bytes -> "5.0 GiB"; percentunit "42.4%"; reqps
  "123 req/s"; free text "7 widgets"; no rows / all null -> "No data"; label "p95 latency"; `viz-rendered` ack sent.
  Check `stat-sparkline-value.test.ts` 9/9 after `bash ./init.sh`; regressions build 31/31, client-install 4/4,
  state-timeline 3/3; `tsc --noEmit` and oxfmt clean. Scratch driver in `../tmp/drive-stat/` (outside the repo).
- 2026-11-08T20:31:14Z supervisor: viz-registry-stat-value passed the gate in round 1

## viz-registry-stat-thresholds (round 1)
- **What.** Stat entry now colours by Grafana threshold steps. New shared helper `chart-registry/src/shared/thresholds.ts`
  (`parseThresholds`, `thresholdColor`) bundles common's `eng1799/grafanaThresholds.ts` from source, like
  `valueMappings.ts` does. The `thresholds` option is Grafana JSON text: `{mode, steps}` or a bare steps array; step
  value null / "-Infinity" = base; named Grafana colours or hex; blank/malformed/step-less = no thresholds = Grafana base
  green `#73BF69` (decision: no implicit red-80 default). Percentage mode reads steps against the series' data min..max
  (Grafana's behaviour with no min/max), or 0..100 when the series has no spread.
- **Colour mode** (`colorMode`, unknown -> `value`): `div[data-testid=stat]` always carries `data-color-mode`.
  `value` -> `data-color` on the stat and the number (and unit) drawn in it; `background` -> `data-color` on the stat,
  stat background = colour, text white or near-black by luminance; `none` -> no colour, no `data-color`. "No data" has no
  `data-color` (value-mappings may give the null special a colour later - set `data-color` there).
- **Version.** stat-sparkline bumped to **1.1.0** in `registry.json` with a changelog; threshold label now
  "Thresholds (Grafana steps JSON)" (config options have no `description` key in `DataAppVizConfigOption`).
  bar-gauge / status-grid should reuse `shared/thresholds.ts` (bar-gauge passes its min/max as `range`).
- **Tested as a user.** Built the registry, untarred stat-sparkline@1.1.0 dist.tar and ran its bundle in jsdom with
  Lightdash-style rows: thresholds green / 80 orange / 90 red -> 50 green `#73BF69`, 85 orange `#FF9830`, 95 red
  `#F2495C`, 80 exactly orange; background mode 95 -> red background, white text, mode recorded; none -> mode recorded,
  uncoloured; bare array with hex base + `semi-dark-red` -> `#E02F44`; blank / malformed -> green; percentage 50% over
  data 0..200: 150 red, 40 green; no rows -> "No data", uncoloured; `viz-rendered` ack each time. Check
  `stat-sparkline-thresholds.test.ts` 7/7 after `bash ./init.sh`; regressions stat-sparkline-value 9/9, build 31/31,
  client-install 4/4; chart-registry typecheck and oxfmt clean. Scratch driver in `../tmp/drive-stat-thresholds/`.
- 2026-11-08T20:34:52Z supervisor: viz-registry-stat-thresholds passed the gate in round 1

## viz-registry-stat-sparkline (round 1)
- **What.** With `graphMode` area (the default; unknown values also mean area), the stat entry draws
  `svg[data-testid=stat-sparkline]` behind the value, across the bottom half of the tile: a filled area (opacity 0.2)
  under a line through every point. `data-points` = points drawn. The pure geometry is `sparkline()` in
  `chart-registry/src/charts/stat-sparkline/stat.ts` (with `graphModeOption`). x spans first..last time, y the series
  min (bottom)..max (top); a flat series runs through the middle; if every point has the same time they are spread in row
  order. `div[data-testid=stat]` now carries `data-graph-mode` and is `position:relative`. The value and label have
  `z-index:1` so they sit above the sparkline.
- **Decisions.** A point needs both a time and a value. Null values are skipped, so the line joins its neighbours. No
  sparkline when the time field is unbound, when fewer than two points can be drawn, or when the value is "No data".
  Colour: the threshold colour in value and none colour modes (Grafana colours the sparkline even when colour mode is
  none). In background mode it takes the text colour (white or near-black). Both paths carry `data-color`.
- **Version.** stat-sparkline bumped to **1.2.0** in `registry.json`, with a changelog and a description update.
  value-mappings must bump it again. If a mapping gives the value a colour, decide whether the sparkline follows it
  (Grafana: the field colour, i.e. thresholds, not the mapping colour).
- **Tested as a user.** Built the registry, untarred stat-sparkline@1.2.0 dist.tar and ran its bundle in jsdom as the
  host does: Lightdash-style ids, digit-string epoch times, string numerics, rows newest first. Default options with the
  preview series: "42.5 ms" over an 8-point green sparkline, x strictly increasing and y following the series in time
  order. graphMode area [3,1,4,1,5,9]: 6 points, value "9". graphMode none: no sparkline. Red threshold: line and area
  `#F2495C`. Background mode: white line. Nulls skipped (3 of 5 points). Flat series: mid-line. One point, time unbound
  and no rows: no sparkline. `viz-rendered` ack sent each time. Check `stat-sparkline-graph.test.ts` 3/3 after
  `bash ./init.sh`. Regressions: stat-sparkline-value 9/9, -thresholds 7/7, build 31/31, client-install 4/4. Typecheck
  and oxfmt clean. Scratch driver in `../tmp/drive-stat-sparkline/` (outside the repo).
- 2026-11-08T20:38:37Z supervisor: viz-registry-stat-sparkline passed the gate in round 1

## viz-registry-stat-value-mappings (round 1)
- **What.** The stat entry now applies the `valueMappings` option (Grafana's mappings JSON, read by
  `shared/valueMappings.ts`, matched by common's `applyValueMappings`) to the **reduced** value, or to null when the
  reducer gives no value (no rows / all null). A mapping's `text` replaces the formatted value **and** its unit (no
  `stat-unit` span), as Grafana does; a mapping without text keeps the formatted value. A mapping's colour (named colours
  resolved to hex, so `red` -> `#F2495C`) replaces the threshold colour in value and background modes (`data-color`
  set); colour mode none stays uncoloured. A matched mapping sets `data-mapped="true"` on `div[data-testid=stat]`.
- **Null special.** With a null mapping, "No data" becomes the mapped text (full opacity) and takes the mapped colour
  if any; `data-empty="true"` stays. No sparkline in the null case, as before.
- **Decision: sparkline colour.** The sparkline follows the displayed colour, so a mapping colour wins over thresholds
  (Grafana's BigValue draws the sparkline in the display value's colour, which includes the mapping colour). This
  reverses the guess in the sparkline entry's notes. Background mode still uses the text colour for the line.
- **Version.** stat-sparkline bumped to **1.3.0** with a changelog; option label now "Value mappings (Grafana mappings
  JSON)", matching the thresholds label.
- **Tested as a user.** Built the registry, untarred stat-sparkline@1.3.0 dist.tar and ran its bundle in jsdom with
  Lightdash-style rows. Mappings 0->Down red and null->N/A: 0 -> "Down" in `#F2495C` (unit dropped, red sparkline); null
  and no rows -> "N/A", uncoloured; 7 ms -> "7 ms" green; 90 with orange threshold -> orange; background mode -> red
  background with a white line; colour mode none -> "Down", uncoloured; malformed JSON -> "0" unchanged; range 1..10
  colour-only purple -> "5 ms" in `#B877D9`; no mappings and null -> "No data". `viz-rendered` ack sent each time. Check
  `stat-sparkline-value-mappings.test.ts` 3/3 after `bash ./init.sh`. Regressions: stat-sparkline-value 9/9,
  -thresholds 7/7, -graph 3/3, build 31/31. Typecheck and oxfmt clean. Scratch driver in `../tmp/drive-stat-mappings/`
  (run it from that directory with `vitest run --globals --disableConsoleIntercept drive.test.ts`).
- 2026-11-08T20:41:53Z supervisor: viz-registry-stat-value-mappings passed the gate in round 1
