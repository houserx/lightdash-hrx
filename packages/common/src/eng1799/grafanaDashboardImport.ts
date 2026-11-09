import type { SqlChartAsCode } from '../types/contentAsCode/charts';
/**
 * ENG-1799 importers: one Grafana dashboard JSON → dashboard-as-code, SQL-chart-as-code, the
 * warnings and TODOs, and the per-dashboard IMPORT-REPORT.md. Pure: no filesystem, no network.
 * `lightdash import grafana-dashboard` reads the files and writes what this returns.
 */
import { ContentAsCodeType } from '../types/contentAsCode/core';
import type {
    DashboardAsCode,
    DashboardTileAsCode,
} from '../types/contentAsCode/dashboards';
import { DashboardTileTypes } from '../types/dashboard';
import { ChartKind, ChartType } from '../types/savedCharts';
import {
    generateSlug,
    MAX_CONTENT_SLUG_LENGTH,
    truncateSlug,
} from '../utils/slugs';
import type { AllVizChartConfig } from '../visualizations/types';
import {
    getGrafanaPanelMapping,
    type GrafanaPanelMapping,
} from './grafanaPanelMapping';
import {
    translateGrafanaPanelQueries,
    type GrafanaPanelWithTargets,
    type GrafanaQueryContext,
    type GrafanaTemplatingVariable,
} from './grafanaQuery';
import type { ImportWarning } from './importWarnings';

/** The fields of a Grafana dashboard JSON the importer reads. */
export type GrafanaDashboardJson = {
    title: string;
    uid?: string;
    panels: GrafanaDashboardPanel[];
    templating?: { list?: GrafanaTemplatingVariable[] };
    [key: string]: unknown;
};

export type GrafanaDashboardPanel = GrafanaPanelWithTargets & {
    id?: number;
    type?: string;
    title?: string;
    description?: string;
    gridPos?: { x?: number; y?: number; w?: number; h?: number };
    /** A collapsed row holds its panels here. */
    panels?: GrafanaDashboardPanel[];
    options?: Record<string, unknown>;
    /** Legacy graph panel series styles. */
    bars?: unknown;
    lines?: unknown;
    fieldConfig?: { defaults?: { custom?: { drawStyle?: unknown } } };
};

export type GrafanaDashboardInput = {
    dashboard: GrafanaDashboardJson;
    /** `meta.folderTitle` of an API export `{dashboard, meta}`. */
    folderTitle?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks that parsed JSON is a Grafana dashboard, or the API export `{dashboard, meta}` of
 * one. Returns the dashboard, or the reason it is not one.
 */
export const readGrafanaDashboardJson = (
    json: unknown,
): GrafanaDashboardInput | { error: string } => {
    if (!isRecord(json)) {
        return { error: 'expected a JSON object' };
    }
    const wrapped = isRecord(json.dashboard);
    const dashboard = wrapped
        ? (json.dashboard as Record<string, unknown>)
        : json;
    if (typeof dashboard.title !== 'string' || dashboard.title.trim() === '') {
        return { error: 'it has no dashboard title' };
    }
    if (!Array.isArray(dashboard.panels)) {
        return {
            error: Array.isArray(dashboard.rows)
                ? 'it uses the pre-5.0 rows layout; open and save it in a current Grafana first'
                : 'it has no panels list',
        };
    }
    const meta = wrapped && isRecord(json.meta) ? json.meta : undefined;
    return {
        dashboard: dashboard as GrafanaDashboardJson,
        folderTitle:
            typeof meta?.folderTitle === 'string'
                ? meta.folderTitle
                : undefined,
    };
};

/** A panel that became a TODO tile: what the reader has to do by hand. */
export type ImportTodo = { panel: string; text: string };

export type GrafanaDashboardImportOptions = {
    spaceSlug: string;
    /** Datasources and Ops Marts for query translation (variables come from the dashboard). */
    query?: Omit<GrafanaQueryContext, 'variables' | 'panelDatasource'>;
    /** Slugs already used in this run; the conversion adds its own so they stay unique. */
    takenDashboardSlugs?: Set<string>;
    takenChartSlugs?: Set<string>;
};

export type GrafanaDashboardImport = {
    dashboard: DashboardAsCode;
    charts: SqlChartAsCode[];
    warnings: ImportWarning[];
    todos: ImportTodo[];
};

/** The row limit a new SQL chart gets in the SQL runner. */
export const IMPORTED_SQL_CHART_LIMIT = 500;

// Leaves room for a "-<n>" suffix under the content-as-code slug limit.
const SLUG_BASE_LENGTH = MAX_CONTENT_SLUG_LENGTH - 8;

/** `generateSlug`, but never random (re-imports write the same files), and unique in `taken`. */
const uniqueSlug = (name: string, fallback: string, taken: Set<string>) => {
    const base = /[a-z0-9]/i.test(name)
        ? truncateSlug(generateSlug(name), SLUG_BASE_LENGTH)
        : fallback;
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) {
        slug = `${base}-${n}`;
    }
    taken.add(slug);
    return slug;
};

/** A graph panel with bars on and lines off, or a timeseries panel drawn as bars. */
const drawsBars = (panel: GrafanaDashboardPanel): boolean => {
    if (panel.type === 'graph')
        return panel.bars === true && panel.lines === false;
    return (
        panel.type === 'timeseries' &&
        panel.fieldConfig?.defaults?.custom?.drawStyle === 'bars'
    );
};

/**
 * The SQL chart kind a chart panel becomes, and the Lightdash chart type the panel
 * mapping module wanted when a SQL chart cannot be it (gauge, log stream, a registry entry).
 */
const chartKindForPanel = (
    panel: GrafanaDashboardPanel,
    mapping: GrafanaPanelMapping,
): { kind: ChartKind; fallbackFrom?: string } => {
    if (mapping.target === 'registry_chart') {
        return {
            kind:
                mapping.registrySlug === 'bar-gauge'
                    ? ChartKind.VERTICAL_BAR
                    : ChartKind.BIG_NUMBER,
            fallbackFrom: mapping.registrySlug,
        };
    }
    switch (mapping.chartType) {
        case ChartType.CARTESIAN:
            return {
                kind:
                    panel.type === 'barchart' || drawsBars(panel)
                        ? ChartKind.VERTICAL_BAR
                        : ChartKind.LINE,
            };
        case ChartType.PIE:
            return { kind: ChartKind.PIE };
        case ChartType.TABLE:
            return { kind: ChartKind.TABLE };
        case ChartType.GAUGE:
            return { kind: ChartKind.BIG_NUMBER, fallbackFrom: 'gauge' };
        default:
            return {
                kind: ChartKind.TABLE,
                fallbackFrom: mapping.chartType ?? mapping.target,
            };
    }
};

const chartConfig = (kind: ChartKind): AllVizChartConfig => {
    const metadata = { version: 1 };
    switch (kind) {
        case ChartKind.LINE:
        case ChartKind.VERTICAL_BAR:
        case ChartKind.PIE:
        case ChartKind.BIG_NUMBER:
            return {
                metadata,
                type: kind,
                fieldConfig: undefined,
                display: undefined,
            };
        default:
            return {
                metadata,
                type: ChartKind.TABLE,
                columns: {},
                display: undefined,
            };
    }
};

const DEFAULT_GRID = { x: 0, y: 0, w: 12, h: 8 };

/** The tile rectangle for a panel's gridPos, kept inside the dashboard grid. */
const tilePosition = (panel: GrafanaDashboardPanel) => {
    const num = (value: unknown, fallback: number) =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    const grid = panel.gridPos ?? {};
    const x = Math.min(
        35,
        Math.max(0, Math.round(num(grid.x, DEFAULT_GRID.x))),
    );
    const w = Math.min(
        36 - x,
        Math.max(1, Math.round(num(grid.w, DEFAULT_GRID.w))),
    );
    return {
        x,
        y: Math.max(0, Math.round(num(grid.y, DEFAULT_GRID.y))),
        w,
        h: Math.max(1, Math.round(num(grid.h, DEFAULT_GRID.h))),
    };
};

/** Panels in dashboard order, with the panels of collapsed rows in place of the row. */
const flattenPanels = (
    panels: GrafanaDashboardPanel[],
): GrafanaDashboardPanel[] =>
    panels.flatMap((panel) =>
        panel.type === 'row' ? flattenPanels(panel.panels ?? []) : [panel],
    );

/** Converts one Grafana dashboard into dashboard and SQL chart content as code. */
export const convertGrafanaDashboard = (
    input: GrafanaDashboardInput,
    options: GrafanaDashboardImportOptions,
): GrafanaDashboardImport => {
    const { dashboard: source } = input;
    const title = source.title.trim();
    const takenChartSlugs = options.takenChartSlugs ?? new Set<string>();
    const slug = uniqueSlug(
        title,
        'grafana-dashboard',
        options.takenDashboardSlugs ?? new Set<string>(),
    );
    const takenTileSlugs = new Set<string>();
    const queryCtx: GrafanaQueryContext = {
        ...options.query,
        variables: source.templating?.list ?? [],
    };

    const warnings: ImportWarning[] = [];
    const todos: ImportTodo[] = [];
    const charts: SqlChartAsCode[] = [];
    const tiles: DashboardTileAsCode[] = [];

    flattenPanels(source.panels).forEach((panel) => {
        const type = typeof panel.type === 'string' ? panel.type : '';
        const panelTitle =
            typeof panel.title === 'string' ? panel.title.trim() : '';
        const panelName =
            panelTitle ||
            `Untitled ${type || 'panel'} ${panel.id ?? ''}`.trim();
        const warn = (code: string, message: string) =>
            warnings.push({
                code,
                message,
                dashboard: title,
                panel: panelName,
            });
        const position = tilePosition(panel);
        const todoTile = (text: string) => {
            todos.push({ panel: panelName, text });
            tiles.push({
                ...position,
                uuid: undefined,
                type: DashboardTileTypes.MARKDOWN,
                tileSlug: uniqueSlug(
                    `todo ${panelName}`,
                    'todo',
                    takenTileSlugs,
                ),
                properties: { title: panelName, content: text },
            });
        };

        const mapping = getGrafanaPanelMapping(type);
        if (!mapping) {
            warn(
                'panel-type-unsupported',
                `The Grafana panel type "${type}" has no Lightdash equivalent`,
            );
            todoTile(
                `TODO: rebuild the Grafana "${type}" panel by hand; the importer does not know this panel type`,
            );
            return;
        }
        if (mapping.target === 'dropped') {
            warn(
                'panel-dropped',
                `The ${type} panel is not imported. ${mapping.reason}`,
            );
            return;
        }
        if (mapping.target === 'markdown_tile') {
            const content = panel.options?.content;
            tiles.push({
                ...position,
                uuid: undefined,
                type: DashboardTileTypes.MARKDOWN,
                tileSlug: uniqueSlug(panelName, 'text', takenTileSlugs),
                properties: {
                    title: panelTitle,
                    content: typeof content === 'string' ? content : '',
                },
            });
            return;
        }

        const translation = translateGrafanaPanelQueries(panel, queryCtx);
        translation.warnings.forEach((w) =>
            warnings.push({ ...w, dashboard: title, panel: panelName }),
        );
        if (translation.sql === null) {
            todoTile(
                translation.todo ?? 'TODO: translate the panel query by hand',
            );
            return;
        }
        const { kind, fallbackFrom } = chartKindForPanel(panel, mapping);
        if (fallbackFrom) {
            warn(
                'chart-kind-fallback',
                `The ${type} panel maps to the ${fallbackFrom} chart type, which SQL charts do not support; it is imported as a ${kind} SQL chart`,
            );
        }
        const chart: SqlChartAsCode = {
            version: 1,
            contentType: ContentAsCodeType.SQL_CHART,
            name: panelName,
            description:
                typeof panel.description === 'string' &&
                panel.description.trim()
                    ? panel.description.trim()
                    : null,
            slug: uniqueSlug(
                `${slug} ${panelName}`,
                `${slug}-chart`,
                takenChartSlugs,
            ),
            spaceSlug: options.spaceSlug,
            sql: translation.sql,
            limit: IMPORTED_SQL_CHART_LIMIT,
            chartKind: kind,
            config: chartConfig(kind),
        };
        charts.push(chart);
        tiles.push({
            ...position,
            uuid: undefined,
            type: DashboardTileTypes.SQL_CHART,
            tileSlug: uniqueSlug(panelName, 'chart', takenTileSlugs),
            properties: {
                title: panelName,
                chartName: chart.name,
                chartSlug: chart.slug,
            },
        });
    });

    return {
        dashboard: {
            version: 1,
            contentType: ContentAsCodeType.DASHBOARD,
            name: title,
            slug,
            spaceSlug: options.spaceSlug,
            tabs: [],
            tiles,
        },
        charts,
        warnings,
        todos,
    };
};

const cell = (text: string) =>
    text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** The per-dashboard IMPORT-REPORT.md: every warning (code, panel, message) and every TODO. */
export const renderGrafanaImportReport = (
    result: GrafanaDashboardImport,
): string => {
    const { dashboard, warnings, todos } = result;
    const lines = [
        `# Import report: ${dashboard.name}`,
        '',
        `Dashboard \`${dashboard.slug}\`: ${result.charts.length} chart${
            result.charts.length === 1 ? '' : 's'
        }, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}, ${
            todos.length
        } TODO${todos.length === 1 ? '' : 's'}.`,
        '',
        '## Warnings',
        '',
    ];
    if (warnings.length === 0) {
        lines.push('No warnings.');
    } else {
        lines.push('| Code | Panel | Message |', '| --- | --- | --- |');
        warnings.forEach((w) =>
            lines.push(
                `| ${w.code} | ${cell(w.panel ?? '')} | ${cell(w.message)} |`,
            ),
        );
    }
    lines.push('', '## TODO', '');
    if (todos.length === 0) {
        lines.push('No TODOs.');
    } else {
        todos.forEach((t) =>
            lines.push(`- **${cell(t.panel)}**: ${cell(t.text)}`),
        );
    }
    return `${lines.join('\n')}\n`;
};
