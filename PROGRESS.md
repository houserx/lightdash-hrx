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
