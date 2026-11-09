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
 *   plugin keeps its Perses kind as the panel type, which the panel mapping reports and turns
 *   into a TODO tile.
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

type PanelConversion = {
    panel: GrafanaDashboardPanel;
    datasources: GrafanaDatasource[];
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
    const type = PANEL_TYPES[kind] ?? kind;
    const queries = convertQueries(spec.queries);
    const panel: GrafanaDashboardPanel = {
        type,
        title: text(display.name) ?? id,
        ...(text(display.description) === undefined
            ? {}
            : { description: text(display.description) }),
        gridPos,
        ...(queries.targets.length > 0 ? { targets: queries.targets } : {}),
        ...(type === 'text'
            ? {
                  options: {
                      mode: 'markdown',
                      content:
                          typeof pluginSpec.text === 'string'
                              ? pluginSpec.text
                              : '',
                  },
              }
            : {}),
    };
    return { panel, datasources: queries.datasources };
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
