import type { SqlChartAsCode } from '../types/contentAsCode/charts';
/**
 * ENG-1799 importers: one Grafana dashboard JSON → dashboard-as-code, SQL-chart-as-code, the
 * warnings and TODOs, and the per-dashboard IMPORT-REPORT.md. Pure: no filesystem, no network.
 * `lightdash import grafana-dashboard` reads the files and writes what this returns.
 */
import { ContentAsCodeType } from '../types/contentAsCode/core';
import type {
    DashboardAsCode,
    DashboardTabAsCode,
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
    getGrafanaPanelOptionMapping,
    type GrafanaPanelMapping,
} from './grafanaPanelMapping';
import {
    translateGrafanaPanelQueries,
    type GrafanaPanelWithTargets,
    type GrafanaQueryContext,
    type GrafanaTemplatingVariable,
} from './grafanaQuery';
import { importDashboardTimeRange } from './importTimeRange';
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
    /** Row panels: whether the row is collapsed. */
    collapsed?: boolean;
    options?: Record<string, unknown>;
    /** Legacy graph panel series styles. */
    bars?: unknown;
    lines?: unknown;
    /** Legacy text panels keep these at the panel root instead of under `options`. */
    mode?: unknown;
    content?: unknown;
    /** Panel links (fieldConfig holds the field links). */
    links?: unknown;
    fieldConfig?: {
        defaults?: { custom?: { drawStyle?: unknown }; links?: unknown };
        overrides?: unknown;
    };
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

/** The separate things a TODO asks for: a panel's translator joins one per target with newlines. */
const todoItems = (text: string): string[] => {
    const items = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    return items.length > 0 ? items : [text];
};

/**
 * A TODO tile's markdown. One TODO is a plain paragraph. Several TODOs become a list:
 * markdown joins lines split by single newlines into one paragraph, which would run them together.
 */
const todoMarkdown = (text: string): string => {
    const items = todoItems(text);
    return items.length === 1
        ? items[0]
        : items.map((item) => `- ${item}`).join('\n');
};

export type GrafanaDashboardImportOptions = {
    spaceSlug: string;
    /** Datasources and Ops Marts for query translation (variables come from the dashboard). */
    query?: Omit<GrafanaQueryContext, 'variables' | 'panelDatasource'>;
    /** Slugs already used in this run; the conversion adds its own so they stay unique. */
    takenDashboardSlugs?: Set<string>;
    takenChartSlugs?: Set<string>;
    /** Collapsed rows become headings with their panels below, instead of tabs. */
    noTabs?: boolean;
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

/** Grafana lays panels out on 24 columns; Lightdash dashboards have 36. */
const GRAFANA_GRID_COLUMNS = 24;
const LIGHTDASH_GRID_COLUMNS = 36;
const COLUMN_SCALE = LIGHTDASH_GRID_COLUMNS / GRAFANA_GRID_COLUMNS;

type TileRect = { x: number; y: number; w: number; h: number };

/**
 * The tile rectangle for a panel's gridPos on the 36-column grid: x and w scale by 36/24 and
 * stay inside the grid; y and h keep Grafana's row units, so rows keep their order and
 * proportions.
 */
const tilePosition = (panel: GrafanaDashboardPanel): TileRect => {
    const num = (value: unknown, fallback: number) =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    const grid = panel.gridPos ?? {};
    const x = Math.min(
        LIGHTDASH_GRID_COLUMNS - 1,
        Math.max(0, Math.round(num(grid.x, DEFAULT_GRID.x) * COLUMN_SCALE)),
    );
    const w = Math.min(
        LIGHTDASH_GRID_COLUMNS - x,
        Math.max(1, Math.round(num(grid.w, DEFAULT_GRID.w) * COLUMN_SCALE)),
    );
    return {
        x,
        y: Math.max(0, Math.round(num(grid.y, DEFAULT_GRID.y))),
        w,
        h: Math.max(1, Math.round(num(grid.h, DEFAULT_GRID.h))),
    };
};

const rectsOverlap = (a: TileRect, b: TileRect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The rect moved down, just below whatever placed tiles it hits, until it hits none. */
const lowestFreeRect = (placed: TileRect[], rect: TileRect): TileRect => {
    const hits = placed.filter((p) => rectsOverlap(p, rect));
    if (hits.length === 0) return rect;
    const y = Math.max(...hits.map((p) => p.y + p.h));
    return lowestFreeRect(placed, { ...rect, y });
};

/**
 * Moves tiles down until no two on the same tab overlap. Rounding odd widths and overlapping
 * Grafana gridPos can put two tiles on the same cells. Tiles are placed top to bottom, left to
 * right; a tile that hits a placed tile on its tab moves to just below it. Tile order in the
 * array is kept.
 */
const resolveTileOverlaps = <T extends TileRect & { tabSlug?: string | null }>(
    tiles: T[],
): T[] => {
    const order = tiles
        .map((tile, index) => ({ tile, index }))
        .sort(
            (a, b) =>
                a.tile.y - b.tile.y || a.tile.x - b.tile.x || a.index - b.index,
        );
    const placedByTab = new Map<string | null, TileRect[]>();
    const moved = new Map<number, T>();
    order.forEach(({ tile, index }) => {
        const tab = tile.tabSlug ?? null;
        const placed = placedByTab.get(tab) ?? [];
        placedByTab.set(tab, placed);
        const rect = lowestFreeRect(placed, {
            x: tile.x,
            y: tile.y,
            w: tile.w,
            h: tile.h,
        });
        placed.push(rect);
        moved.set(index, rect.y === tile.y ? tile : { ...tile, y: rect.y });
    });
    return tiles.map((tile, index) => moved.get(index) ?? tile);
};

/**
 * Panel keys the importer reads itself (identity, layout, queries) rather than options the
 * panel mapping lists. `transformations` belong to the transformation importer.
 */
const NON_OPTION_PANEL_KEYS = new Set([
    'id',
    'type',
    'title',
    'gridPos',
    'datasource',
    'targets',
    'panels',
    'pluginVersion',
    'libraryPanel',
    'transformations',
    // Panel and field links go into the chart description (panelLinks).
    'links',
]);

/** The objects of a JSON array (links, overrides, override properties); [] if not an array. */
const objectList = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(isRecord) : [];

const nonBlank = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * `[title](url)`. Brackets in the title are escaped; a url with spaces, parentheses or angle
 * brackets is written as `<url>` (with `<` and `>` percent-encoded) so it stays one link.
 */
const markdownLink = (title: string, url: string) => {
    const text = title.replace(/([\\[\]])/g, '\\$1');
    const target = /[\s()<>]/.test(url)
        ? `<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
        : url;
    return `[${text}](${target})`;
};

/** `text`, then a blank line and a `Links:` list; undefined if both are empty. */
const describeWithLinks = (
    text: string | undefined,
    links: string[],
): string | undefined => {
    const parts = [
        ...(text ? [text] : []),
        ...(links.length > 0
            ? [`Links:\n${links.map((link) => `- ${link}`).join('\n')}`]
            : []),
    ];
    return parts.length > 0 ? parts.join('\n\n') : undefined;
};

/**
 * A panel's links (`links`) and field links (`fieldConfig.defaults.links` and `links`
 * overrides) as markdown links, in that order, without repeats. A link without a url can't
 * be followed and is left out; `missing` names it so it can be reported.
 */
const panelLinks = (
    panel: GrafanaDashboardPanel,
): { links: string[]; missing: string[] } => {
    const overrides = objectList(panel.fieldConfig?.overrides);
    const overrideLinks = overrides.flatMap((override) =>
        objectList(override.properties)
            .filter((property) => property.id === 'links')
            .flatMap((property) => objectList(property.value)),
    );
    const links = new Set<string>();
    const missing: string[] = [];
    [
        ...objectList(panel.links),
        ...objectList(panel.fieldConfig?.defaults?.links),
        ...overrideLinks,
    ].forEach((link) => {
        const url = nonBlank(link.url);
        const title = nonBlank(link.title);
        if (url) links.add(markdownLink(title ?? url, url));
        else missing.push(title ?? 'Untitled link');
    });
    return { links: [...links], missing };
};

/**
 * Dashboard links as description lines. A `link` becomes `[title](url)`. A `dashboards` link
 * lists Grafana dashboards by tag, which has no Lightdash equivalent: it is named (with its
 * tags) without a url, and reported.
 */
const dashboardLinks = (
    value: unknown,
): { links: string[]; unsupported: string[] } => {
    const links: string[] = [];
    const unsupported: string[] = [];
    objectList(value).forEach((link) => {
        const url = nonBlank(link.url);
        const title = nonBlank(link.title);
        if (link.type !== 'dashboards' && url) {
            links.push(markdownLink(title ?? url, url));
            return;
        }
        const tags = (Array.isArray(link.tags) ? link.tags : [])
            .map(nonBlank)
            .filter((tag): tag is string => tag !== undefined);
        const what =
            link.type === 'dashboards'
                ? `lists the Grafana dashboards ${
                      tags.length > 0
                          ? `tagged ${tags.join(', ')}`
                          : 'of the instance'
                  }`
                : 'has no url';
        const name =
            title ?? (tags.length > 0 ? tags.join(', ') : 'Dashboards');
        links.push(`${name} (not imported: it ${what})`);
        unsupported.push(
            `The dashboard link "${name}" ${what}${
                link.type === 'dashboards'
                    ? '; Lightdash has no tag-based dashboard list, so the link is named in the dashboard description without a url'
                    : ', so it is named in the dashboard description without a url'
            }`,
        );
    });
    return { links, unsupported };
};

/**
 * The markdown tile content for a Grafana text panel. markdown and html content are copied
 * exactly (Lightdash markdown renders inline html). code mode is wrapped in a fenced code
 * block with `options.code.language`; the fence is longer than any backtick run in the
 * content so the block can't close early. Old dashboards keep `mode` and `content` at the
 * panel root instead of under `options`; those are read when `options` doesn't set them.
 */
const textPanelMarkdown = (panel: GrafanaDashboardPanel): string => {
    const options = isRecord(panel.options) ? panel.options : {};
    const pick = (key: 'mode' | 'content'): string | undefined => {
        const value = options[key] ?? panel[key];
        return typeof value === 'string' ? value : undefined;
    };
    const content = pick('content') ?? '';
    if (pick('mode') !== 'code') return content;
    const code = isRecord(options.code) ? options.code : {};
    const language =
        typeof code.language === 'string' ? code.language.trim() : '';
    const longestRun = Math.max(
        0,
        ...(content.match(/`+/g) ?? []).map((run) => run.length),
    );
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    const body = content.endsWith('\n') ? content : `${content}\n`;
    return `${fence}${language}\n${body}${fence}`;
};

/**
 * The options a panel sets that the panel mapping drops, with the mapping's reason. Walks
 * the panel JSON from the top and stops at the first path the mapping knows, so a dropped
 * object (`options.legend.calcs`) is one warning, not one per key. Override properties
 * are looked up as `fieldConfig.overrides.<property id>`. Per-panel time overrides
 * (`timeFrom`, `timeShift`) are dropped options too. Options the mapping keeps are not
 * reported here, even where a SQL chart cannot hold them yet. Links are not reported: the
 * panel has no link menu, but its links go into the chart description (panelLinks).
 */
const LINK_OPTION_PATHS = new Set([
    'fieldConfig.defaults.links',
    'fieldConfig.overrides.links',
]);

const droppedPanelOptions = (
    panel: GrafanaDashboardPanel,
    type: string,
): { path: string; reason: string }[] => {
    const found = new Map<string, string>();
    const visit = (path: string, value: unknown) => {
        // Unset, null and blank values (Grafana exports `description: ""`) set nothing.
        if (value === undefined || value === null) return;
        if (typeof value === 'string' && value.trim() === '') return;
        if (LINK_OPTION_PATHS.has(path)) return;
        const mapping = getGrafanaPanelOptionMapping(type, path);
        if (mapping) {
            if (mapping.target === 'dropped' && !found.has(path)) {
                found.set(path, mapping.reason);
            }
            return;
        }
        if (isRecord(value)) {
            Object.entries(value).forEach(([key, child]) =>
                visit(`${path}.${key}`, child),
            );
        }
    };
    Object.entries(panel).forEach(([key, value]) => {
        if (NON_OPTION_PANEL_KEYS.has(key)) return;
        if (key === 'fieldConfig' && isRecord(value)) {
            visit('fieldConfig.defaults', value.defaults);
            const overrides = Array.isArray(value.overrides)
                ? value.overrides
                : [];
            overrides.forEach((override: unknown) => {
                const properties =
                    isRecord(override) && Array.isArray(override.properties)
                        ? override.properties
                        : [];
                properties.forEach((property: unknown) => {
                    if (isRecord(property) && typeof property.id === 'string')
                        visit(
                            `fieldConfig.overrides.${property.id}`,
                            property.value ?? true,
                        );
                });
            });
            return;
        }
        visit(key, value);
    });
    return [...found].map(([path, reason]) => ({ path, reason }));
};

const isExpandedRow = (panel: GrafanaDashboardPanel) =>
    panel.type === 'row' && panel.collapsed !== true;

/**
 * Panels in dashboard order. An expanded row stays in the list (it becomes a heading); its
 * panels follow it in the export.
 */
const flattenPanels = (
    panels: GrafanaDashboardPanel[],
): GrafanaDashboardPanel[] =>
    panels.flatMap((panel) =>
        panel.type === 'row'
            ? [panel, ...flattenPanels(panel.panels ?? [])]
            : [panel],
    );

const gridNumber = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const gridY = (panel: GrafanaDashboardPanel) =>
    gridNumber(panel.gridPos?.y, DEFAULT_GRID.y);
const gridBottom = (panel: GrafanaDashboardPanel) =>
    gridY(panel) + gridNumber(panel.gridPos?.h, DEFAULT_GRID.h);
const atY = (
    panel: GrafanaDashboardPanel,
    y: number,
): GrafanaDashboardPanel => ({
    ...panel,
    gridPos: { ...panel.gridPos, y },
});

/** The name of the first tab, which holds the panels outside collapsed rows. */
export const GRAFANA_FIRST_TAB_NAME = 'Overview';

type PanelLayout = {
    tabs: DashboardTabAsCode[];
    /** Panels in dashboard order with their y on their tab, and the tab they go on. */
    panels: { panel: GrafanaDashboardPanel; tabSlug?: string }[];
};

/**
 * Where each panel goes. A collapsed row holds its panels inside it, and becomes a tab holding
 * them, its top panel at y 0; the panels outside collapsed rows go on a first tab (left out if
 * it would be empty). With `noTabs`, or with no collapsed rows, there are no tabs: a collapsed
 * row stays in the list (it becomes a heading) with its panels expanded right below it, and
 * everything below the row moves down to make room, as when the row is expanded in Grafana.
 */
const layoutPanels = (
    top: GrafanaDashboardPanel[],
    noTabs: boolean,
): PanelLayout => {
    const isCollapsedRow = (panel: GrafanaDashboardPanel) =>
        panel.type === 'row' && !isExpandedRow(panel);
    const heldPanels = (row: GrafanaDashboardPanel) =>
        flattenPanels(row.panels ?? []);

    if (noTabs || !top.some(isCollapsedRow)) {
        let offset = 0;
        const panels = top.flatMap((panel) => {
            if (!isCollapsedRow(panel)) {
                return flattenPanels([panel]).map((p) => ({
                    panel: offset ? atY(p, gridY(p) + offset) : p,
                }));
            }
            const rowY = gridY(panel) + offset;
            const held = heldPanels(panel);
            const contentTop = rowY + gridNumber(panel.gridPos?.h, 1);
            const minY = Math.min(...held.map(gridY));
            const placed = held.map((p) => ({
                panel: atY(p, gridY(p) - minY + contentTop),
            }));
            if (held.length > 0) {
                offset += Math.max(...held.map(gridBottom)) - minY;
            }
            return [{ panel: atY(panel, rowY) }, ...placed];
        });
        return { tabs: [], panels };
    }

    const takenTabSlugs = new Set<string>();
    const tabs: DashboardTabAsCode[] = [];
    const addTab = (name: string) => {
        const tab = {
            slug: uniqueSlug(name, 'tab', takenTabSlugs),
            name,
            order: tabs.length,
        };
        tabs.push(tab);
        return tab.slug;
    };
    const outside = flattenPanels(top.filter((p) => !isCollapsedRow(p)));
    const firstTab =
        outside.length > 0 ? addTab(GRAFANA_FIRST_TAB_NAME) : undefined;
    const panels: PanelLayout['panels'] = outside.map((panel) => ({
        panel,
        tabSlug: firstTab,
    }));
    top.filter(isCollapsedRow).forEach((row, index) => {
        const name =
            typeof row.title === 'string' && row.title.trim()
                ? row.title.trim()
                : `Row ${index + 1}`;
        const tabSlug = addTab(name);
        const held = heldPanels(row);
        const minY = Math.min(...held.map(gridY));
        held.forEach((panel) =>
            panels.push({ panel: atY(panel, gridY(panel) - minY), tabSlug }),
        );
    });
    return { tabs, panels };
};

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

    const layout = layoutPanels(source.panels, options.noTabs === true);
    layout.panels.forEach(({ panel, tabSlug }) => {
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
        const position = {
            ...tilePosition(panel),
            ...(tabSlug === undefined ? {} : { tabSlug }),
        };
        if (panel.type === 'row') {
            // A row with no title shows nothing in Grafana, so it gets no heading.
            if (!panelTitle) return;
            tiles.push({
                ...position,
                x: 0,
                w: LIGHTDASH_GRID_COLUMNS,
                uuid: undefined,
                type: DashboardTileTypes.HEADING,
                tileSlug: uniqueSlug(panelTitle, 'heading', takenTileSlugs),
                properties: { text: panelTitle },
            });
            return;
        }
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
                properties: { title: panelName, content: todoMarkdown(text) },
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
        droppedPanelOptions(panel, type).forEach(({ path, reason }) =>
            warn(
                'option-dropped',
                `The ${type} panel option ${path} is not imported. ${reason}`,
            ),
        );
        if (mapping.target === 'markdown_tile') {
            tiles.push({
                ...position,
                uuid: undefined,
                type: DashboardTileTypes.MARKDOWN,
                tileSlug: uniqueSlug(panelName, 'text', takenTileSlugs),
                properties: {
                    title: panelTitle,
                    content: textPanelMarkdown(panel),
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
        const { links, missing } = panelLinks(panel);
        missing.forEach((name) =>
            warn(
                'link-unsupported',
                `The ${type} panel link "${name}" has no url, so it is not added to the chart description`,
            ),
        );
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
                describeWithLinks(nonBlank(panel.description), links) ?? null,
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

    const sourceLinks = dashboardLinks(source.links);
    sourceLinks.unsupported.forEach((message) =>
        warnings.push({
            code: 'dashboard-link-unsupported',
            message,
            dashboard: title,
        }),
    );
    const description = describeWithLinks(
        nonBlank(source.description),
        sourceLinks.links,
    );
    const { timeRange, warnings: timeRangeWarnings } = importDashboardTimeRange(
        source.time,
        source.refresh,
    );
    timeRangeWarnings.forEach((w) => warnings.push({ ...w, dashboard: title }));

    return {
        dashboard: {
            version: 1,
            contentType: ContentAsCodeType.DASHBOARD,
            name: title,
            ...(description === undefined ? {} : { description }),
            slug,
            spaceSlug: options.spaceSlug,
            tabs: layout.tabs,
            tiles: resolveTileOverlaps(tiles),
            timeRange,
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
        todos.forEach((t) => {
            const items = todoItems(t.text);
            if (items.length === 1) {
                lines.push(`- **${cell(t.panel)}**: ${cell(items[0])}`);
            } else {
                lines.push(`- **${cell(t.panel)}**:`);
                items.forEach((item) => lines.push(`  - ${cell(item)}`));
            }
        });
    }
    return `${lines.join('\n')}\n`;
};
