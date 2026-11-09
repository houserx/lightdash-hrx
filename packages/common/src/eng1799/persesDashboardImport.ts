/**
 * ENG-1799 importers: one Perses dashboard (`kind: Dashboard`, `metadata`, `spec`, panels keyed
 * by id, Grid layouts that `$ref` them) → the same dashboard-as-code, SQL-chart-as-code,
 * warnings, TODOs and IMPORT-REPORT.md as the Grafana importer. Pure: no filesystem, no network.
 *
 * The Perses dashboard is restated as the Grafana dashboard JSON it corresponds to and goes
 * through `convertGrafanaDashboard`, so both importers share one panel mapping, query
 * translation, layout and report:
 *
 * - Panels become Grafana panels of the matching type (TimeSeriesChart → timeseries, BarChart →
 *   barchart, StatChart → stat, GaugeChart → gauge, Table → table, Markdown → text). Any other
 *   plugin keeps its Perses kind as the panel type, which becomes a `perses-plugin-unsupported`
 *   warning and a TODO tile.
 * - Plugin options become the Grafana options they correspond to (legend position and mode,
 *   stacking, units and decimals, thresholds, y axis bounds, the stat and gauge calculation, the
 *   gauge max), so the panel mapping carries them as far as the chart kind supports and warns
 *   about the rest. A set option with no Grafana counterpart is an `option-dropped` warning.
 * - PrometheusTimeSeriesQuery queries become Prometheus targets. A query's datasource name is
 *   both the Grafana datasource uid and name, so it resolves to the Telemetry Source of that
 *   name; other query plugins keep their kind as the datasource type and are reported.
 * - Grid layouts (24 columns, like Grafana's) are stacked in order. A grid with a title
 *   becomes a row: an open grid a heading above its panels, a collapsed one a collapsed row.
 *   A panel no layout places is not shown in Perses; it is a `panel-dropped` warning.
 * - `duration` and `refreshInterval` become the dashboard time (`now-<duration>` to `now`)
 *   and refresh.
 */
import {
    convertGrafanaDashboard,
    type GrafanaDashboardImport,
    type GrafanaDashboardImportOptions,
    type GrafanaDashboardJson,
    type GrafanaDashboardPanel,
    type UnsupportedPanelType,
} from './grafanaDashboardImport';
import type { GrafanaDatasource, GrafanaTarget } from './grafanaQuery';
import type { ImportWarning } from './importWarnings';

/** The fields of a Perses dashboard the importer reads. */
export type PersesDashboard = {
    kind: 'Dashboard';
    metadata?: { name?: string; project?: string; [key: string]: unknown };
    spec: {
        display?: { name?: string; description?: string };
        duration?: string;
        refreshInterval?: string;
        variables?: unknown[];
        panels: Record<string, unknown>;
        layouts?: unknown[];
        [key: string]: unknown;
    };
};

export type PersesDashboardInput = { dashboard: PersesDashboard };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> =>
    isRecord(value) ? value : {};

const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const gridNumber = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : fallback;

/** The dashboard's display name, else its metadata name. */
const persesDashboardName = (dashboard: PersesDashboard): string | undefined =>
    text(record(dashboard.spec.display).name) ?? text(dashboard.metadata?.name);

/**
 * Checks that a parsed JSON or YAML document is a Perses dashboard. Returns the dashboard, or
 * the reason it is not one.
 */
export const readPersesDashboard = (
    doc: unknown,
): PersesDashboardInput | { error: string } => {
    if (!isRecord(doc)) {
        return { error: 'expected a JSON or YAML object' };
    }
    if (doc.kind !== 'Dashboard') {
        return {
            error:
                doc.kind === undefined
                    ? 'it has no `kind: Dashboard`'
                    : `its kind is ${JSON.stringify(doc.kind)}, not Dashboard`,
        };
    }
    if (!isRecord(doc.spec)) {
        return { error: 'it has no spec' };
    }
    if (!isRecord(doc.spec.panels)) {
        return { error: 'it has no spec.panels map' };
    }
    if (doc.spec.layouts !== undefined && !Array.isArray(doc.spec.layouts)) {
        return { error: 'its spec.layouts is not a list' };
    }
    if (persesDashboardName(doc as PersesDashboard) === undefined) {
        return { error: 'it has neither spec.display.name nor metadata.name' };
    }
    return { dashboard: doc as PersesDashboard };
};

/** Perses panel plugin kind → the Grafana panel type with the same meaning. */
const PANEL_TYPES: Record<string, string> = {
    TimeSeriesChart: 'timeseries',
    BarChart: 'barchart',
    StatChart: 'stat',
    GaugeChart: 'gauge',
    Table: 'table',
    Markdown: 'text',
};

/** Perses query plugin kind → the Grafana datasource type it queries. */
const QUERY_DATASOURCE_TYPES: Record<string, string> = {
    PrometheusTimeSeriesQuery: 'prometheus',
};

/** A lookup table's own entry for a key (never an inherited property). */
const lookup = <T>(table: Record<string, T>, key: unknown): T | undefined =>
    typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key)
        ? table[key]
        : undefined;

/** Perses unit → the Grafana unit with the same meaning; other units are passed on as they are. */
const UNITS: Record<string, string> = {
    decimal: 'none',
    percent: 'percent',
    'percent-decimal': 'percentunit',
    bytes: 'bytes',
    decbytes: 'decbytes',
    nanoseconds: 'ns',
    microseconds: 'µs',
    milliseconds: 'ms',
    seconds: 's',
    minutes: 'm',
    hours: 'h',
    days: 'd',
    'bits/sec': 'bps',
    'bytes/sec': 'Bps',
    'counts/sec': 'cps',
    'ops/sec': 'ops',
    'requests/sec': 'reqps',
    'reads/sec': 'rps',
    'writes/sec': 'wps',
};

/** Perses time series `visual.stack` → the Grafana stacking mode. */
const STACKING: Record<string, string> = {
    all: 'normal',
    percent: 'percent',
};

/** Perses calculation → the Grafana reducer. */
const CALCULATIONS: Record<string, string> = {
    first: 'first',
    last: 'last',
    'first-number': 'firstNotNull',
    'last-number': 'lastNotNull',
    mean: 'mean',
    sum: 'sum',
    min: 'min',
    max: 'max',
};

/**
 * The plugin spec paths each panel kind carries into the Grafana panel (a path covers
 * everything under it). Any other set option is an `option-dropped` warning.
 */
const CARRIED_OPTIONS: Record<string, string[]> = {
    TimeSeriesChart: [
        'legend.position',
        'legend.mode',
        'legend.values',
        'yAxis.format.unit',
        'yAxis.format.decimalPlaces',
        'yAxis.label',
        'yAxis.show',
        'yAxis.min',
        'yAxis.max',
        'visual.stack',
        'visual.display',
        'visual.lineWidth',
        'visual.areaOpacity',
        'visual.pointRadius',
        'visual.connectNulls',
        'thresholds',
    ],
    BarChart: ['format.unit', 'format.decimalPlaces'],
    StatChart: [
        'calculation',
        'format.unit',
        'format.decimalPlaces',
        'thresholds',
        'sparkline',
    ],
    GaugeChart: [
        'calculation',
        'format.unit',
        'format.decimalPlaces',
        'thresholds',
        'max',
    ],
    Table: [],
    Markdown: ['text'],
};

const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** The set option paths of a plugin spec that the panel kind does not carry. */
const droppedOptions = (kind: string, spec: Record<string, unknown>) => {
    const carried = lookup(CARRIED_OPTIONS, kind) ?? [];
    const dropped: string[] = [];
    const visit = (path: string, value: unknown) => {
        if (value === undefined || value === null) return;
        if (carried.some((c) => path === c || path.startsWith(`${c}.`))) {
            return;
        }
        if (isRecord(value)) {
            Object.entries(value).forEach(([key, child]) =>
                visit(`${path}.${key}`, child),
            );
            return;
        }
        dropped.push(path);
    };
    Object.entries(spec).forEach(([key, value]) => visit(key, value));
    return dropped;
};

/** Perses `format` → the Grafana field unit and decimals. */
const formatDefaults = (format: unknown): Record<string, unknown> => {
    const unit = text(record(format).unit);
    const decimals = finite(record(format).decimalPlaces);
    return {
        ...(unit === undefined ? {} : { unit: lookup(UNITS, unit) ?? unit }),
        ...(decimals === undefined ? {} : { decimals }),
    };
};

/**
 * Perses thresholds → Grafana thresholds: the default colour is the base step (Grafana's
 * default green when unset) and `percent` mode is Grafana's `percentage`.
 */
const thresholdDefaults = (thresholds: unknown): Record<string, unknown> => {
    const source = record(thresholds);
    const steps = (Array.isArray(source.steps) ? source.steps : [])
        .filter(isRecord)
        .map((step) => ({
            value: finite(step.value) ?? null,
            color: step.color,
        }))
        .filter((step) => step.value !== null);
    if (steps.length === 0) return {};
    return {
        thresholds: {
            mode: source.mode === 'percent' ? 'percentage' : 'absolute',
            steps: [
                { value: null, color: text(source.defaultColor) ?? 'green' },
                ...steps,
            ],
        },
    };
};

const reduceOptions = (calculation: unknown) => {
    const calc = text(calculation);
    return calc === undefined
        ? {}
        : { reduceOptions: { calcs: [lookup(CALCULATIONS, calc) ?? calc] } };
};

/** A Perses chart plugin's spec as the Grafana panel `options` and `fieldConfig`. */
const panelOptions = (
    kind: string,
    spec: Record<string, unknown>,
): Pick<GrafanaDashboardPanel, 'options' | 'fieldConfig'> => {
    const withDefaults = (
        options: Record<string, unknown>,
        defaults: Record<string, unknown>,
    ) => ({
        ...(Object.keys(options).length > 0 ? { options } : {}),
        ...(Object.keys(defaults).length > 0
            ? { fieldConfig: { defaults, overrides: [] } }
            : {}),
    });
    switch (kind) {
        case 'TimeSeriesChart': {
            const legend = record(spec.legend);
            const yAxis = record(spec.yAxis);
            const visual = record(spec.visual);
            const thresholds = thresholdDefaults(spec.thresholds);
            const stacking = lookup(STACKING, visual.stack);
            const areaOpacity = finite(visual.areaOpacity);
            const custom: Record<string, unknown> = {
                ...(stacking === undefined
                    ? {}
                    : { stacking: { mode: stacking } }),
                ...(visual.display === 'bar' ? { drawStyle: 'bars' } : {}),
                ...(visual.display === 'line' ? { drawStyle: 'line' } : {}),
                ...(finite(visual.lineWidth) === undefined
                    ? {}
                    : { lineWidth: finite(visual.lineWidth) }),
                ...(areaOpacity === undefined
                    ? {}
                    : { fillOpacity: Math.round(areaOpacity * 100) }),
                ...(finite(visual.pointRadius) === undefined
                    ? {}
                    : { pointSize: finite(visual.pointRadius) }),
                ...(typeof visual.connectNulls === 'boolean'
                    ? { spanNulls: visual.connectNulls }
                    : {}),
                ...(text(yAxis.label) === undefined
                    ? {}
                    : { axisLabel: text(yAxis.label) }),
                ...(yAxis.show === false ? { axisPlacement: 'hidden' } : {}),
                // Perses draws a time series chart's thresholds as lines.
                ...('thresholds' in thresholds
                    ? { thresholdsStyle: { mode: 'line' } }
                    : {}),
            };
            const placement = text(legend.position);
            return withDefaults(
                isRecord(spec.legend)
                    ? {
                          legend: {
                              showLegend: true,
                              ...(placement === undefined ? {} : { placement }),
                              ...(text(legend.mode) === undefined
                                  ? {}
                                  : { displayMode: text(legend.mode) }),
                              ...(Array.isArray(legend.values) &&
                              legend.values.length > 0
                                  ? { calcs: legend.values }
                                  : {}),
                          },
                      }
                    : {},
                {
                    ...formatDefaults(yAxis.format),
                    ...(finite(yAxis.min) === undefined
                        ? {}
                        : { min: finite(yAxis.min) }),
                    ...(finite(yAxis.max) === undefined
                        ? {}
                        : { max: finite(yAxis.max) }),
                    ...thresholds,
                    ...(Object.keys(custom).length > 0 ? { custom } : {}),
                },
            );
        }
        case 'BarChart':
            return withDefaults({}, formatDefaults(spec.format));
        case 'StatChart':
            return withDefaults(
                {
                    ...reduceOptions(spec.calculation),
                    // Perses shows a sparkline only when one is set; Grafana's default is one.
                    graphMode:
                        isRecord(spec.sparkline) || spec.sparkline === true
                            ? 'area'
                            : 'none',
                },
                {
                    ...formatDefaults(spec.format),
                    ...thresholdDefaults(spec.thresholds),
                },
            );
        case 'GaugeChart':
            return withDefaults(reduceOptions(spec.calculation), {
                ...formatDefaults(spec.format),
                ...thresholdDefaults(spec.thresholds),
                ...(finite(spec.max) === undefined
                    ? {}
                    : { min: 0, max: finite(spec.max) }),
            });
        case 'Markdown':
            return {
                options: {
                    mode: 'markdown',
                    content: typeof spec.text === 'string' ? spec.text : '',
                },
            };
        default:
            return {};
    }
};

/** The warning and TODO for a panel whose plugin the importer does not know. */
const persesUnsupportedPlugin = (kind: string): UnsupportedPanelType => ({
    code: 'perses-plugin-unsupported',
    message: `The Perses panel plugin "${kind}" has no Lightdash equivalent`,
    todo: `TODO: rebuild the Perses "${kind}" panel by hand; the importer does not know this panel plugin`,
});

type PanelConversion = {
    panel: GrafanaDashboardPanel;
    datasources: GrafanaDatasource[];
    /** Set plugin options the panel kind does not carry, as `spec.plugin.spec` paths. */
    droppedOptions: string[];
};

const refIdFor = (index: number): string =>
    index < 26 ? String.fromCharCode(65 + index) : `Q${index + 1}`;

const convertQueries = (
    queries: unknown,
): { targets: GrafanaTarget[]; datasources: GrafanaDatasource[] } => {
    const datasources: GrafanaDatasource[] = [];
    const targets: GrafanaTarget[] = (
        Array.isArray(queries) ? queries : []
    ).map((query, index) => {
        const plugin = record(record(record(query).spec).plugin);
        const kind = text(plugin.kind) ?? 'unknown';
        const spec = record(plugin.spec);
        const type = QUERY_DATASOURCE_TYPES[kind] ?? kind;
        const name = text(record(spec.datasource).name);
        if (name !== undefined) datasources.push({ uid: name, name, type });
        return {
            refId: refIdFor(index),
            datasource: name === undefined ? { type } : { type, uid: name },
            ...(typeof spec.query === 'string' ? { expr: spec.query } : {}),
            ...(typeof spec.seriesNameFormat === 'string'
                ? { legendFormat: spec.seriesNameFormat }
                : {}),
            range: true,
        };
    });
    return { targets, datasources };
};

const convertPanel = (
    id: string,
    value: unknown,
    gridPos: Required<NonNullable<GrafanaDashboardPanel['gridPos']>>,
): PanelConversion => {
    const spec = record(record(value).spec);
    const display = record(spec.display);
    const plugin = record(spec.plugin);
    const kind = text(plugin.kind) ?? 'unknown';
    const pluginSpec = record(plugin.spec);
    const type = lookup(PANEL_TYPES, kind) ?? kind;
    const queries = convertQueries(spec.queries);
    const panel: GrafanaDashboardPanel = {
        type,
        title: text(display.name) ?? id,
        ...(text(display.description) === undefined
            ? {}
            : { description: text(display.description) }),
        gridPos,
        ...(queries.targets.length > 0 ? { targets: queries.targets } : {}),
        ...panelOptions(kind, pluginSpec),
    };
    return {
        panel,
        datasources: queries.datasources,
        // An unknown plugin is a TODO tile as a whole, so its options are not listed.
        droppedOptions: lookup(CARRIED_OPTIONS, kind)
            ? droppedOptions(kind, pluginSpec)
            : [],
    };
};

const PANEL_REF = /^#\/spec\/panels\/(.+)$/;

/** The panel id a Grid item's `content.$ref` points at. */
const referencedPanelId = (
    item: Record<string, unknown>,
): string | undefined => {
    const ref = text(record(item.content).$ref);
    const match = ref === undefined ? null : PANEL_REF.exec(ref);
    return match ? decodeURIComponent(match[1]) : undefined;
};

export type PersesAsGrafana = {
    dashboard: GrafanaDashboardJson;
    datasources: GrafanaDatasource[];
    warnings: ImportWarning[];
};

/** Restates a Perses dashboard as the Grafana dashboard JSON it corresponds to. */
export const persesToGrafanaDashboard = (
    dashboard: PersesDashboard,
): PersesAsGrafana => {
    const title = persesDashboardName(dashboard) ?? 'Perses dashboard';
    const { spec } = dashboard;
    const warnings: ImportWarning[] = [];
    const datasources = new Map<string, GrafanaDatasource>();
    const placed = new Set<string>();
    const panels: GrafanaDashboardPanel[] = [];
    let id = 0;
    let top = 0;

    (spec.layouts ?? []).forEach((layout, layoutIndex) => {
        const layoutSpec = record(record(layout).spec);
        const layoutDisplay = record(layoutSpec.display);
        const rowTitle = text(layoutDisplay.title);
        const collapsed = record(layoutDisplay.collapse).open === false;
        const items = (
            Array.isArray(layoutSpec.items) ? layoutSpec.items : []
        ).filter(isRecord);
        const offset = top + (rowTitle === undefined ? 0 : 1);
        const children: GrafanaDashboardPanel[] = [];
        let bottom = offset;
        items.forEach((item) => {
            const panelId = referencedPanelId(item);
            const source =
                panelId === undefined ? undefined : spec.panels[panelId];
            if (panelId === undefined || source === undefined) {
                warnings.push({
                    code: 'panel-dropped',
                    message: `Grid item ${JSON.stringify(
                        record(item.content).$ref ?? null,
                    )} in layout ${layoutIndex + 1} references no panel`,
                    dashboard: title,
                });
                return;
            }
            const gridPos = {
                x: gridNumber(item.x, 0),
                y: offset + gridNumber(item.y, 0),
                w: gridNumber(item.width, 12),
                h: gridNumber(item.height, 8),
            };
            bottom = Math.max(bottom, gridPos.y + gridPos.h);
            const converted = convertPanel(panelId, source, gridPos);
            const plugin = text(
                record(record(record(source).spec).plugin).kind,
            );
            converted.droppedOptions.forEach((path) =>
                warnings.push({
                    code: 'option-dropped',
                    message: `The Perses ${plugin} option ${path} is not imported: the SQL chart has no equivalent`,
                    dashboard: title,
                    panel: converted.panel.title,
                    path: `spec.plugin.spec.${path}`,
                }),
            );
            id += 1;
            children.push({ id, ...converted.panel });
            converted.datasources.forEach((ds) => datasources.set(ds.name, ds));
            placed.add(panelId);
        });
        if (rowTitle !== undefined) {
            id += 1;
            panels.push({
                id,
                type: 'row',
                title: rowTitle,
                collapsed,
                gridPos: { x: 0, y: top, w: 24, h: 1 },
                panels: collapsed ? children : [],
            });
            if (!collapsed) panels.push(...children);
        } else {
            panels.push(...children);
        }
        top = Math.max(bottom, offset);
    });

    Object.keys(spec.panels)
        .filter((panelId) => !placed.has(panelId))
        .forEach((panelId) => {
            const name =
                text(
                    record(record(record(spec.panels[panelId]).spec).display)
                        .name,
                ) ?? panelId;
            warnings.push({
                code: 'panel-dropped',
                message: `Panel ${panelId} is in no layout, so Perses does not show it; it was not imported`,
                dashboard: title,
                panel: name,
            });
        });

    const duration = text(spec.duration);
    const refresh = text(spec.refreshInterval);
    return {
        dashboard: {
            title,
            ...(text(record(spec.display).description) === undefined
                ? {}
                : { description: text(record(spec.display).description) }),
            panels,
            ...(duration === undefined
                ? {}
                : { time: { from: `now-${duration}`, to: 'now' } }),
            ...(refresh === undefined ? {} : { refresh }),
        },
        datasources: [...datasources.values()],
        warnings,
    };
};

/** Converts one Perses dashboard into dashboard and SQL chart content as code. */
export const convertPersesDashboard = (
    input: PersesDashboardInput,
    options: GrafanaDashboardImportOptions,
): GrafanaDashboardImport => {
    const restated = persesToGrafanaDashboard(input.dashboard);
    const result = convertGrafanaDashboard(
        { dashboard: restated.dashboard },
        {
            ...options,
            unsupportedPanelType: persesUnsupportedPlugin,
            query: {
                ...options.query,
                datasources: [
                    ...(options.query?.datasources ?? []),
                    ...restated.datasources,
                ],
            },
        },
    );
    return { ...result, warnings: [...restated.warnings, ...result.warnings] };
};
