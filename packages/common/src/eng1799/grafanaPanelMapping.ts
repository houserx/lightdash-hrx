import { ChartType } from '../types/savedCharts';

/**
 * Where each Grafana panel type used by HouseRx's 32 dashboards lands in
 * Lightdash. The dashboard importer reads this module to decide which kind
 * of tile (or chart) to create for a panel, and documents every panel type
 * it drops.
 */

/** The Grafana panel types used by the 32 dashboards in the infra snapshot. */
export const GRAFANA_PANEL_TYPES = [
    'alertlist',
    'barchart',
    'bargauge',
    'dashlist',
    'gauge',
    'graph',
    'logs',
    'news',
    'piechart',
    'row',
    'stat',
    'table',
    'table-old',
    'text',
    'timeseries',
] as const;

export type GrafanaPanelType = (typeof GRAFANA_PANEL_TYPES)[number];

/** The entries the HouseRx chart registry publishes (chart-registry/src/charts). */
export type GrafanaRegistrySlug =
    | 'heatmap'
    | 'state-timeline'
    | 'stat-sparkline'
    | 'bar-gauge'
    | 'histogram'
    | 'status-grid';

export type GrafanaPanelTarget =
    | 'builtin_chart'
    | 'native_chart'
    | 'registry_chart'
    | 'markdown_tile'
    | 'heading_tile'
    | 'dropped';

type GrafanaPanelMappingBase = {
    /** The Grafana panel `type` this entry maps. */
    grafanaType: GrafanaPanelType;
    /** A short note on how the panel converts, for the docs and importer logs. */
    note?: string;
};

/** A chart tile whose saved chart uses one of Lightdash's own chart types. */
export type GrafanaPanelToBuiltinChart = GrafanaPanelMappingBase & {
    target: 'builtin_chart';
    chartType:
        | ChartType.CARTESIAN
        | ChartType.GAUGE
        | ChartType.TABLE
        | ChartType.PIE;
    registrySlug?: never;
    reason?: never;
};

/** A chart tile whose saved chart uses a chart type added for ENG-1799. */
export type GrafanaPanelToNativeChart = GrafanaPanelMappingBase & {
    target: 'native_chart';
    chartType: ChartType.LOG_STREAM | ChartType.TRACE_WATERFALL;
    registrySlug?: never;
    reason?: never;
};

/** A chart tile drawn by an entry from the HouseRx chart registry. */
export type GrafanaPanelToRegistryChart = GrafanaPanelMappingBase & {
    target: 'registry_chart';
    chartType: ChartType.CUSTOM;
    registrySlug: GrafanaRegistrySlug;
    reason?: never;
};

/** A markdown tile, or a heading tile (a dashboard section header). */
export type GrafanaPanelToTile = GrafanaPanelMappingBase & {
    target: 'markdown_tile' | 'heading_tile';
    chartType?: never;
    registrySlug?: never;
    reason?: never;
};

/** Not imported. `reason` says why, for the docs and the importer's report. */
export type GrafanaPanelDropped = GrafanaPanelMappingBase & {
    target: 'dropped';
    reason: string;
    chartType?: never;
    registrySlug?: never;
};

export type GrafanaPanelMapping =
    | GrafanaPanelToBuiltinChart
    | GrafanaPanelToNativeChart
    | GrafanaPanelToRegistryChart
    | GrafanaPanelToTile
    | GrafanaPanelDropped;

export const GRAFANA_PANEL_MAPPINGS: Readonly<
    Record<GrafanaPanelType, GrafanaPanelMapping>
> = {
    alertlist: {
        grafanaType: 'alertlist',
        target: 'dropped',
        reason: 'Lists Grafana alert instances. Alert Rules move to Lightdash (ADR 0001), which has no alert list dashboard tile.',
    },
    barchart: {
        grafanaType: 'barchart',
        target: 'builtin_chart',
        chartType: ChartType.CARTESIAN,
        note: 'Cartesian chart with bar series.',
    },
    bargauge: {
        grafanaType: 'bargauge',
        target: 'registry_chart',
        chartType: ChartType.CUSTOM,
        registrySlug: 'bar-gauge',
    },
    dashlist: {
        grafanaType: 'dashlist',
        target: 'dropped',
        reason: 'Lists links to other Grafana dashboards. Lightdash spaces and the dashboard browser cover navigation, and the Grafana links stop working at Cutover.',
    },
    gauge: {
        grafanaType: 'gauge',
        target: 'builtin_chart',
        chartType: ChartType.GAUGE,
    },
    graph: {
        grafanaType: 'graph',
        target: 'builtin_chart',
        chartType: ChartType.CARTESIAN,
        note: 'Legacy Grafana graph panel; converts like timeseries.',
    },
    logs: {
        grafanaType: 'logs',
        target: 'native_chart',
        chartType: ChartType.LOG_STREAM,
    },
    news: {
        grafanaType: 'news',
        target: 'dropped',
        reason: 'Shows an external RSS feed (the Grafana blog), not query data, so there is nothing to chart.',
    },
    piechart: {
        grafanaType: 'piechart',
        target: 'builtin_chart',
        chartType: ChartType.PIE,
    },
    row: {
        grafanaType: 'row',
        target: 'heading_tile',
        note: 'The row title becomes a heading tile above the panels it holds.',
    },
    stat: {
        grafanaType: 'stat',
        target: 'registry_chart',
        chartType: ChartType.CUSTOM,
        registrySlug: 'stat-sparkline',
    },
    table: {
        grafanaType: 'table',
        target: 'builtin_chart',
        chartType: ChartType.TABLE,
    },
    'table-old': {
        grafanaType: 'table-old',
        target: 'builtin_chart',
        chartType: ChartType.TABLE,
        note: 'Legacy Grafana table panel; converts like table.',
    },
    text: {
        grafanaType: 'text',
        target: 'markdown_tile',
        note: 'The panel content becomes the markdown tile content.',
    },
    timeseries: {
        grafanaType: 'timeseries',
        target: 'builtin_chart',
        chartType: ChartType.CARTESIAN,
        note: 'Cartesian chart with line series over a time x axis.',
    },
};

export const isGrafanaPanelType = (type: string): type is GrafanaPanelType =>
    Object.prototype.hasOwnProperty.call(GRAFANA_PANEL_MAPPINGS, type);

/** The Lightdash equivalent of a Grafana panel type, or undefined if unknown. */
export const getGrafanaPanelMapping = (
    type: string,
): GrafanaPanelMapping | undefined =>
    isGrafanaPanelType(type) ? GRAFANA_PANEL_MAPPINGS[type] : undefined;
