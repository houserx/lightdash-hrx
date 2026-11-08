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

/*
 * Panel options
 *
 * Where each panel option the 32 dashboards set lands in Lightdash, keyed by
 * panel type and the option's JSON path in the panel (for example
 * `options.wrapLogMessage` or `fieldConfig.defaults.unit`). Paths name the
 * key the dashboards set, never a value. `fieldConfig.overrides.<key>` stands
 * for an override property with that id (`custom.<key>` for `custom.*` ids).
 */

export type GrafanaPanelOptionTarget =
    /** A key in a built-in chart type's config (CartesianChart, GaugeChart, TableChart, PieChart). */
    | 'builtin_chart_config'
    /** A key in an ENG-1799 chart type's config (LogStreamChart, TraceWaterfallChart). */
    | 'native_chart_config'
    /** A config option of the chart registry entry (the chart's `optionValues`). */
    | 'registry_option'
    /** The field's number format (`metricQuery.metricOverrides[field].formatOptions`). */
    | 'field_format'
    /** A property of the dashboard tile or saved chart itself. */
    | 'tile'
    /** Not imported; `reason` says why. */
    | 'dropped';

type GrafanaPanelOptionKept = {
    target: Exclude<GrafanaPanelOptionTarget, 'dropped'>;
    /** Where the option lands in Lightdash, as a config path. */
    lightdash: string;
    /** How values convert, when it is not a straight copy. */
    note?: string;
    reason?: never;
};

type GrafanaPanelOptionDropped = {
    target: 'dropped';
    /** Why the option is not imported, for the docs and the importer's report. */
    reason: string;
    lightdash?: never;
    note?: never;
};

type GrafanaPanelOptionEntry =
    | GrafanaPanelOptionKept
    | GrafanaPanelOptionDropped;

export type GrafanaPanelOptionMapping = GrafanaPanelOptionEntry & {
    /** The Grafana panel `type` the option was looked up for. */
    grafanaType: GrafanaPanelType;
    /** The option's JSON path in the panel. */
    path: string;
};

const builtin = (lightdash: string, note?: string): GrafanaPanelOptionKept =>
    note
        ? { target: 'builtin_chart_config', lightdash, note }
        : { target: 'builtin_chart_config', lightdash };
const native = (lightdash: string, note?: string): GrafanaPanelOptionKept =>
    note
        ? { target: 'native_chart_config', lightdash, note }
        : { target: 'native_chart_config', lightdash };
const registry = (option: string, note?: string): GrafanaPanelOptionKept => {
    const lightdash = `optionValues.${option}`;
    return note
        ? { target: 'registry_option', lightdash, note }
        : { target: 'registry_option', lightdash };
};
const fieldFormat = (
    lightdash: string,
    note?: string,
): GrafanaPanelOptionKept =>
    note
        ? { target: 'field_format', lightdash, note }
        : { target: 'field_format', lightdash };
const tile = (lightdash: string, note?: string): GrafanaPanelOptionKept =>
    note ? { target: 'tile', lightdash, note } : { target: 'tile', lightdash };
const dropped = (reason: string): GrafanaPanelOptionDropped => ({
    target: 'dropped',
    reason,
});

type GrafanaPanelOptionTable = Readonly<
    Record<string, GrafanaPanelOptionEntry>
>;

const FORMAT = 'metricQuery.metricOverrides[field].formatOptions';

/* Reasons shared by several panel types. */
const NO_LINKS = dropped(
    'Lightdash charts have no per-panel link menu, and links to Grafana dashboards stop working at Cutover.',
);
const NO_NO_VALUE = dropped(
    'Lightdash shows its own empty-result message; there is no custom no-value text.',
);
const NO_UNIT_SCALE = dropped(
    'grafanaUnitToCustomFormat already picks the compact scale for each unit; there is no separate switch.',
);
const NO_FIELD_MIN_MAX = dropped(
    'Only sets per-field colour scale ranges, which Lightdash does not have.',
);
const NO_SERIES_BY = dropped(
    'Only matters for Grafana gradient colour schemes, which Lightdash does not have.',
);
const NO_VIZ_SIZING = dropped(
    'Grafana layout sizing; the tile size comes from the panel gridPos.',
);
const NO_TOOLTIP_OPTIONS = dropped(
    'Lightdash tooltips are not configurable per chart.',
);
const UNIT_FORMAT = fieldFormat(
    FORMAT,
    'grafanaUnitToCustomFormat(unit, { decimals }).',
);
const DECIMALS_FORMAT = fieldFormat(
    `${FORMAT}.round`,
    'Passed as the decimals of grafanaUnitToCustomFormat.',
);

/* Cartesian field config, shared by timeseries and barchart. */
const CARTESIAN_FIELD_OPTIONS: GrafanaPanelOptionTable = {
    'fieldConfig.defaults.color.fixedColor': builtin(
        'eChartsConfig.series[].color',
        'Resolved to hex with resolveGrafanaColor.',
    ),
    'fieldConfig.defaults.color.mode': builtin(
        'eChartsConfig.series[].color',
        'fixed sets each series colour to color.fixedColor; palette and threshold schemes use the project colour palette.',
    ),
    'fieldConfig.defaults.color.seriesBy': NO_SERIES_BY,
    'fieldConfig.defaults.custom.axisBorderShow': dropped(
        'Lightdash draws its own axis lines; there is no per-axis border switch.',
    ),
    'fieldConfig.defaults.custom.axisCenteredZero': dropped(
        'Lightdash axes have no centred-zero mode; min and max are fixed numbers or automatic.',
    ),
    'fieldConfig.defaults.custom.axisColorMode': dropped(
        'Axis colours follow the Lightdash theme, not the series colour.',
    ),
    'fieldConfig.defaults.custom.axisGridShow': builtin('layout.showGridY'),
    'fieldConfig.defaults.custom.axisLabel': builtin(
        'eChartsConfig.yAxis[].name',
    ),
    'fieldConfig.defaults.custom.axisPlacement': builtin(
        'eChartsConfig.series[].yAxisIndex',
        'left is axis 0 and right is axis 1; hidden sets layout.showYAxis to false.',
    ),
    'fieldConfig.defaults.custom.axisSoftMax': builtin(
        'eChartsConfig.yAxis[].max',
        'Lightdash max is hard: values above it are clipped, where Grafana would extend the axis.',
    ),
    'fieldConfig.defaults.custom.axisSoftMin': builtin(
        'eChartsConfig.yAxis[].min',
        'Lightdash min is hard: values below it are clipped, where Grafana would extend the axis.',
    ),
    'fieldConfig.defaults.custom.barAlignment': dropped(
        'Lightdash centres each bar on its x value.',
    ),
    'fieldConfig.defaults.custom.barWidthFactor': dropped(
        'Bar width follows the category width; Lightdash has no bar width option.',
    ),
    'fieldConfig.defaults.custom.drawStyle': builtin(
        'eChartsConfig.series[].type',
        'line is line, bars is bar and points is scatter.',
    ),
    'fieldConfig.defaults.custom.fillOpacity': builtin(
        'eChartsConfig.series[].areaStyle',
        'A line series with fillOpacity above 0 becomes an area series; the opacity itself is not kept.',
    ),
    'fieldConfig.defaults.custom.gradientMode': dropped(
        'Lightdash area and bar fills are flat.',
    ),
    'fieldConfig.defaults.custom.hideFrom.legend': dropped(
        'Lightdash cannot hide a drawn series from the legend alone.',
    ),
    'fieldConfig.defaults.custom.hideFrom.tooltip': dropped(
        'Lightdash cannot hide a drawn series from the tooltip alone.',
    ),
    'fieldConfig.defaults.custom.hideFrom.viz': builtin(
        'eChartsConfig.series[].hidden',
    ),
    'fieldConfig.defaults.custom.insertNulls': dropped(
        'Lightdash does not insert gaps after a time threshold; gaps come from missing rows.',
    ),
    'fieldConfig.defaults.custom.lineInterpolation': builtin(
        'eChartsConfig.series[].smooth',
        'smooth is true; linear and the step modes are false (Lightdash has no stepped lines).',
    ),
    'fieldConfig.defaults.custom.lineStyle.fill': dropped(
        'Lightdash series lines are always solid; dashed and dotted lines are not available.',
    ),
    'fieldConfig.defaults.custom.lineWidth': dropped(
        'Lightdash draws series lines at a fixed width.',
    ),
    'fieldConfig.defaults.custom.pointSize': dropped(
        'Lightdash draws point symbols at a fixed size.',
    ),
    'fieldConfig.defaults.custom.scaleDistribution.type': dropped(
        'Lightdash value axes are linear; log scales are not available.',
    ),
    'fieldConfig.defaults.custom.showPoints': builtin(
        'eChartsConfig.series[].showSymbol',
        'always is true, never is false, auto keeps the Lightdash default.',
    ),
    'fieldConfig.defaults.custom.showValues': builtin(
        'eChartsConfig.series[].label.show',
    ),
    'fieldConfig.defaults.custom.spanNulls': builtin(
        'layout.connectNulls',
        'true connects across nulls; a time threshold also becomes true.',
    ),
    'fieldConfig.defaults.custom.stacking.group': builtin(
        'eChartsConfig.series[].stack',
        'The group name becomes the stack name.',
    ),
    'fieldConfig.defaults.custom.stacking.mode': builtin(
        'layout.stack',
        'normal stacks; percent also stacks, but as absolute values (Lightdash has no 100% stacking); none does not stack.',
    ),
    'fieldConfig.defaults.custom.thresholdsStyle.mode': builtin(
        'thresholds.style',
        'line, dashed, area, line+area and dashed+area keep their names; off drops the thresholds.',
    ),
    'fieldConfig.defaults.decimals': DECIMALS_FORMAT,
    'fieldConfig.defaults.displayName': builtin('eChartsConfig.series[].name'),
    'fieldConfig.defaults.fieldMinMax': NO_FIELD_MIN_MAX,
    'fieldConfig.defaults.links': NO_LINKS,
    'fieldConfig.defaults.mappings': dropped(
        'Cartesian charts do not apply value mappings; only tables and the stat entry do.',
    ),
    'fieldConfig.defaults.max': builtin('eChartsConfig.yAxis[].max'),
    'fieldConfig.defaults.min': builtin('eChartsConfig.yAxis[].min'),
    'fieldConfig.defaults.noValue': NO_NO_VALUE,
    'fieldConfig.defaults.thresholds.mode': builtin('thresholds.mode'),
    'fieldConfig.defaults.thresholds.steps': builtin(
        'thresholds.steps',
        'Kept only when thresholdsStyle.mode draws them.',
    ),
    'fieldConfig.defaults.unit': UNIT_FORMAT,
    'fieldConfig.defaults.unitScale': NO_UNIT_SCALE,
    'fieldConfig.overrides.color': builtin(
        'eChartsConfig.series[].color',
        'Set on each series the override matches.',
    ),
    'fieldConfig.overrides.custom.axisPlacement': builtin(
        'eChartsConfig.series[].yAxisIndex',
        'Set on each series the override matches.',
    ),
    'fieldConfig.overrides.custom.fillOpacity': builtin(
        'eChartsConfig.series[].areaStyle',
        'Set on each series the override matches.',
    ),
    'fieldConfig.overrides.custom.hideFrom': builtin(
        'eChartsConfig.series[].hidden',
        'Only viz: true is kept; legend and tooltip hiding are dropped.',
    ),
    'fieldConfig.overrides.custom.lineStyle': dropped(
        'Lightdash series lines are always solid; dashed and dotted lines are not available.',
    ),
    'fieldConfig.overrides.displayName': builtin(
        'eChartsConfig.series[].name',
        'Set on each series the override matches.',
    ),
    'fieldConfig.overrides.unit': fieldFormat(
        FORMAT,
        'Set on each field the override matches, with grafanaUnitToCustomFormat.',
    ),
    'options.legend.calcs': dropped(
        'Lightdash legends show series names only, not per-series statistics.',
    ),
    'options.legend.displayMode': builtin(
        'eChartsConfig.legend.show',
        'hidden is false; list and table are true (table shows as a list).',
    ),
    'options.legend.placement': builtin(
        'eChartsConfig.legend.placement',
        "bottom keeps the default legend position; right is 'outsideRight'.",
    ),
    'options.legend.showLegend': builtin('eChartsConfig.legend.show'),
    'options.legend.sortBy': dropped(
        'Lightdash legend entries follow the series order.',
    ),
    'options.legend.sortDesc': dropped(
        'Lightdash legend entries follow the series order.',
    ),
    'options.legend.width': builtin('eChartsConfig.legend.width'),
    'options.tooltip.hideZeros': NO_TOOLTIP_OPTIONS,
    'options.tooltip.mode': dropped(
        "Lightdash tooltips always list every series at the hovered x (Grafana's all mode).",
    ),
    'options.tooltip.sort': builtin(
        'eChartsConfig.tooltipSort',
        'asc is value_ascending, desc is value_descending, none is default.',
    ),
};

const BARCHART_OPTIONS: GrafanaPanelOptionTable = {
    ...CARTESIAN_FIELD_OPTIONS,
    'fieldConfig.defaults.custom.drawStyle': builtin(
        'eChartsConfig.series[].type',
        'Always bar.',
    ),
    'options.barRadius': dropped('Lightdash bars have square corners.'),
    'options.barWidth': dropped(
        'Bar width follows the category width; Lightdash has no bar width option.',
    ),
    'options.fullHighlight': dropped(
        'Lightdash highlights the hovered bar only.',
    ),
    'options.groupWidth': dropped('Lightdash has no bar group width option.'),
    'options.orientation': builtin(
        'layout.flipAxes',
        'horizontal is true; vertical and auto are false.',
    ),
    'options.showValue': builtin(
        'eChartsConfig.series[].label.show',
        'always and auto are true; never is false.',
    ),
    'options.stacking': builtin(
        'layout.stack',
        'normal stacks; percent also stacks, but as absolute values (Lightdash has no 100% stacking); none does not stack.',
    ),
    'options.text': dropped('Value label font sizes are fixed in Lightdash.'),
    'options.xTickLabelRotation': builtin('eChartsConfig.xAxis[].rotate'),
    'options.xTickLabelSpacing': dropped(
        'ECharts spaces x axis labels itself; there is no spacing option.',
    ),
};

const NO_DASHES = dropped(
    'Lightdash series lines are always solid; dashed lines are not available.',
);

const GRAPH_OPTIONS: GrafanaPanelOptionTable = {
    aliasColors: builtin(
        'eChartsConfig.series[].color',
        'Each alias colour is set on the series with that name.',
    ),
    bars: builtin('eChartsConfig.series[].type', 'true makes bar series.'),
    dashLength: NO_DASHES,
    dashes: NO_DASHES,
    'fieldConfig.defaults.links': NO_LINKS,
    fill: builtin(
        'eChartsConfig.series[].areaStyle',
        'A fill above 0 makes line series area series; the fill level is not kept.',
    ),
    fillGradient: dropped('Lightdash area fills are flat.'),
    hiddenSeries: builtin('eChartsConfig.series[].hidden'),
    legend: builtin(
        'eChartsConfig.legend.show',
        'legend.show is kept; the value columns (min, max, avg, current) are dropped.',
    ),
    lines: builtin('eChartsConfig.series[].type', 'true makes line series.'),
    linewidth: dropped('Lightdash draws series lines at a fixed width.'),
    nullPointMode: builtin(
        'layout.connectNulls',
        'connected is true; null and null as zero are false.',
    ),
    'options.alertThreshold': dropped(
        'Draws legacy Grafana alert thresholds; Alert Rules move to Lightdash (ADR 0001).',
    ),
    percentage: dropped(
        'Lightdash has no 100% stacking; the series stack as absolute values.',
    ),
    pointradius: dropped('Lightdash draws point symbols at a fixed size.'),
    points: builtin('eChartsConfig.series[].showSymbol'),
    renderer: dropped('Grafana rendering backend (flot); not a chart setting.'),
    seriesOverrides: builtin(
        'eChartsConfig.series[]',
        'Per alias: color, yaxis (yAxisIndex), bars or lines (type), stack and hidden; other keys are dropped.',
    ),
    spaceLength: NO_DASHES,
    stack: builtin('layout.stack'),
    steppedLine: dropped('Lightdash has no stepped lines; they draw linear.'),
    thresholds: builtin(
        'thresholds',
        'Each legacy threshold becomes a step; fill draws area and line draws line.',
    ),
    timeRegions: dropped(
        'Lightdash charts have no time-of-day region shading.',
    ),
    tooltip: builtin(
        'eChartsConfig.tooltipSort',
        'sort 1 is value_ascending, 2 is value_descending, 0 is default; shared and value_type are dropped.',
    ),
    xaxis: builtin(
        'layout.showXAxis',
        'xaxis.show is kept; the x axis is the time dimension.',
    ),
    yaxes: builtin(
        'eChartsConfig.yAxis[]',
        'label is name, min and max are kept, show is layout.showLeftYAxis/showRightYAxis, and format becomes the field format.',
    ),
    yaxis: dropped(
        'Lines up zero on the left and right y axes; Lightdash has no axis alignment.',
    ),
};

const GAUGE_OPTIONS: GrafanaPanelOptionTable = {
    'fieldConfig.defaults.color.mode': dropped(
        'Lightdash gauges are coloured by their sections (from the thresholds); other colour modes have no equivalent.',
    ),
    'fieldConfig.defaults.decimals': DECIMALS_FORMAT,
    'fieldConfig.defaults.mappings': dropped(
        'Lightdash gauges show the number; value mappings are not applied.',
    ),
    'fieldConfig.defaults.max': builtin('max'),
    'fieldConfig.defaults.min': builtin('min'),
    'fieldConfig.defaults.thresholds.mode': builtin(
        'sections',
        'Percentage steps are resolved against min..max by grafanaThresholdsToGaugeSections.',
    ),
    'fieldConfig.defaults.thresholds.steps': builtin(
        'sections',
        'grafanaThresholdsToGaugeSections turns the steps into coloured sections.',
    ),
    'fieldConfig.defaults.unit': UNIT_FORMAT,
    'fieldConfig.defaults.unitScale': NO_UNIT_SCALE,
    'options.minVizHeight': NO_VIZ_SIZING,
    'options.minVizWidth': NO_VIZ_SIZING,
    'options.orientation': dropped(
        'Only lays out several gauges; a Lightdash gauge shows one value.',
    ),
    'options.reduceOptions': builtin(
        'selectedField',
        'The gauge reads the first row of selectedField, so the reduction (calcs) moves into the query.',
    ),
    'options.showThresholdLabels': dropped(
        'Lightdash gauges label min and max only (showAxisLabels), not each threshold.',
    ),
    'options.showThresholdMarkers': builtin(
        'sections',
        'false leaves sections empty; true keeps the threshold sections.',
    ),
    'options.sizing': NO_VIZ_SIZING,
};

const PIE_OPTIONS: GrafanaPanelOptionTable = {
    'fieldConfig.defaults.color.mode': dropped(
        'Pie slices use the project colour palette unless overridden per slice (fieldConfig.overrides.color).',
    ),
    'fieldConfig.defaults.custom.hideFrom.legend': dropped(
        'Lightdash pies cannot hide a slice from the legend alone.',
    ),
    'fieldConfig.defaults.custom.hideFrom.tooltip': dropped(
        'Lightdash pies cannot hide a slice from the tooltip alone.',
    ),
    'fieldConfig.defaults.custom.hideFrom.viz': dropped(
        'Lightdash pies draw every group the query returns; filter the query instead.',
    ),
    'fieldConfig.defaults.mappings': builtin(
        'groupLabelOverrides',
        'Value-to-text mappings rename the matching slices; range, regex and special mappings are dropped.',
    ),
    'fieldConfig.overrides.color': builtin(
        'groupColorOverrides',
        'Set on each slice the override matches, resolved with resolveGrafanaColor.',
    ),
    'options.displayLabels': builtin(
        'showValue',
        'value sets showValue, percent sets showPercentage; name is shown in the legend and tooltip.',
    ),
    'options.legend.displayMode': builtin(
        'showLegend',
        'hidden is false; list and table are true.',
    ),
    'options.legend.placement': builtin(
        'legendPosition',
        'bottom is horizontal; right is vertical.',
    ),
    'options.legend.showLegend': builtin('showLegend'),
    'options.legend.values': dropped(
        'Lightdash pie legends show slice names only.',
    ),
    'options.pieType': builtin('isDonut', 'donut is true; pie is false.'),
    'options.reduceOptions': builtin(
        'metricId',
        'Each slice is one row of metricId, so the reduction (calcs) moves into the query.',
    ),
    'options.tooltip.mode': NO_TOOLTIP_OPTIONS,
    'options.tooltip.sort': NO_TOOLTIP_OPTIONS,
};

const STAT_THRESHOLDS_NOTE =
    'The registry option takes the Grafana thresholds as JSON ({ mode, steps }).';

const STAT_OPTIONS: GrafanaPanelOptionTable = {
    'fieldConfig.defaults.color.fixedColor': registry(
        'thresholds',
        'A fixed colour becomes a single base step in that colour.',
    ),
    'fieldConfig.defaults.color.mode': registry(
        'thresholds',
        'thresholds keeps the steps; fixed becomes a single base step; palette modes keep the steps.',
    ),
    'fieldConfig.defaults.color.seriesBy': NO_SERIES_BY,
    'fieldConfig.defaults.decimals': registry('decimals'),
    'fieldConfig.defaults.fieldMinMax': NO_FIELD_MIN_MAX,
    'fieldConfig.defaults.links': NO_LINKS,
    'fieldConfig.defaults.mappings': registry(
        'valueMappings',
        'The registry option takes the Grafana mappings as JSON.',
    ),
    'fieldConfig.defaults.max': dropped(
        'The stat entry has no min or max; in Grafana they only scale percentage thresholds and the sparkline.',
    ),
    'fieldConfig.defaults.min': dropped(
        'The stat entry has no min or max; in Grafana they only scale percentage thresholds and the sparkline.',
    ),
    'fieldConfig.defaults.noValue': dropped(
        'The stat entry shows "No data" when there is no value.',
    ),
    'fieldConfig.defaults.thresholds.mode': registry(
        'thresholds',
        STAT_THRESHOLDS_NOTE,
    ),
    'fieldConfig.defaults.thresholds.steps': registry(
        'thresholds',
        STAT_THRESHOLDS_NOTE,
    ),
    'fieldConfig.defaults.unit': registry('unit'),
    'fieldConfig.defaults.unitScale': NO_UNIT_SCALE,
    'fieldConfig.overrides.color': dropped(
        'The stat entry shows one value; its colour comes from the thresholds and value mappings.',
    ),
    'options.colorMode': registry(
        'colorMode',
        'value, background and none are kept; background_solid becomes background.',
    ),
    'options.graphMode': registry('graphMode'),
    'options.justifyMode': dropped('The stat entry always centres its value.'),
    'options.orientation': dropped(
        'Only lays out several values; the stat entry shows one.',
    ),
    'options.percentChangeColorMode': dropped(
        'The stat entry does not show a percent change.',
    ),
    'options.reduceOptions': registry(
        'reducer',
        'reduceOptions.calcs[0] is the reducer; values and fields are dropped.',
    ),
    'options.showPercentChange': dropped(
        'The stat entry does not show a percent change.',
    ),
    'options.text': dropped('The stat entry sizes its text to the tile.'),
    'options.textMode': dropped(
        'The stat entry shows the value only; names come from the tile title.',
    ),
    'options.wideLayout': dropped('The stat entry has one layout.'),
};

const BAR_GAUGE_OPTIONS: GrafanaPanelOptionTable = {
    'fieldConfig.defaults.color.mode': registry(
        'thresholds',
        'The bars always take their threshold colours; other colour modes keep the steps.',
    ),
    'fieldConfig.defaults.mappings': dropped(
        'The bar-gauge entry shows numbers; it does not apply value mappings.',
    ),
    'fieldConfig.defaults.max': registry('max'),
    'fieldConfig.defaults.thresholds.mode': registry(
        'thresholds',
        STAT_THRESHOLDS_NOTE,
    ),
    'fieldConfig.defaults.thresholds.steps': registry(
        'thresholds',
        STAT_THRESHOLDS_NOTE,
    ),
    'fieldConfig.defaults.unit': registry('unit'),
    'options.displayMode': registry(
        'displayMode',
        'basic and gradient are kept; lcd becomes gradient.',
    ),
    'options.maxVizHeight': NO_VIZ_SIZING,
    'options.minVizHeight': NO_VIZ_SIZING,
    'options.minVizWidth': NO_VIZ_SIZING,
    'options.namePlacement': dropped(
        'The bar-gauge entry places names in one fixed spot.',
    ),
    'options.orientation': registry(
        'orientation',
        'horizontal and vertical are kept; auto becomes horizontal.',
    ),
    'options.reduceOptions': dropped(
        'The bar-gauge entry draws one bar per row, so the reduction (calcs) moves into the query.',
    ),
    'options.showUnfilled': dropped(
        'The bar-gauge entry always draws the unfilled track.',
    ),
    'options.sizing': NO_VIZ_SIZING,
    'options.valueMode': dropped(
        'The bar-gauge entry always colours the value text with the theme.',
    ),
};

const TABLE_DISPLAY_NOTE =
    'gauge and bar modes are bar; colour-text and colour-background modes become conditionalFormattings; auto is text.';
const NO_SORT = dropped(
    'The table shows rows in query order; the default sort becomes the query sorts (metricQuery.sorts), not table config.',
);
const NO_HEADER_SWITCH = dropped('Lightdash tables always show a header.');

const TABLE_OPTIONS: GrafanaPanelOptionTable = {
    'fieldConfig.defaults.color.mode': builtin(
        'conditionalFormattings',
        'thresholds mode colours cells by the threshold steps; other modes are dropped.',
    ),
    'fieldConfig.defaults.custom.align': dropped(
        'Lightdash aligns numbers right and text left.',
    ),
    'fieldConfig.defaults.custom.cellOptions.type': builtin(
        'columns[field].displayStyle',
        TABLE_DISPLAY_NOTE,
    ),
    'fieldConfig.defaults.custom.cellOptions.wrapText': dropped(
        'Lightdash table cells do not wrap text.',
    ),
    'fieldConfig.defaults.custom.displayMode': builtin(
        'columns[field].displayStyle',
        `Older name for cellOptions.type: ${TABLE_DISPLAY_NOTE}`,
    ),
    'fieldConfig.defaults.custom.filterable': dropped(
        'Lightdash filters come from the dashboard filters, not column filter menus.',
    ),
    'fieldConfig.defaults.custom.inspect': dropped(
        'Lightdash has no cell inspect view; long values show in the cell tooltip.',
    ),
    'fieldConfig.defaults.custom.minWidth': builtin(
        'columns[field].width',
        'The minimum width becomes the fixed column width.',
    ),
    'fieldConfig.defaults.decimals': DECIMALS_FORMAT,
    'fieldConfig.defaults.links': NO_LINKS,
    'fieldConfig.defaults.mappings': builtin(
        'columns[field].valueMappings',
        'Copied to every column the panel shows.',
    ),
    'fieldConfig.defaults.noValue': NO_NO_VALUE,
    'fieldConfig.defaults.thresholds.mode': builtin(
        'conditionalFormattings',
        'Kept only when a colour cell type or colour mode uses the thresholds.',
    ),
    'fieldConfig.defaults.thresholds.steps': builtin(
        'conditionalFormattings',
        'Each step becomes a range rule in its colour, when a colour cell type or colour mode uses them.',
    ),
    'fieldConfig.defaults.unit': UNIT_FORMAT,
    'fieldConfig.overrides.custom.hidden': builtin(
        'columns[field].visible',
        'hidden: true is visible: false.',
    ),
    'fieldConfig.overrides.custom.width': builtin('columns[field].width'),
    'fieldConfig.overrides.decimals': fieldFormat(
        `${FORMAT}.round`,
        'Set on each field the override matches.',
    ),
    'options.cellHeight': dropped('Lightdash table rows have one height.'),
    'options.footer.countRows': builtin(
        'showResultsTotal',
        'Lightdash shows the row count as the results total.',
    ),
    'options.footer.enablePagination': dropped(
        'Lightdash tables always paginate.',
    ),
    'options.footer.fields': dropped(
        'Lightdash totals every numeric column; the field list is not kept.',
    ),
    'options.footer.reducer': builtin(
        'showColumnCalculation',
        'Lightdash column totals are sums; other reducers show as sums.',
    ),
    'options.footer.show': builtin('showColumnCalculation'),
    'options.frameIndex': dropped(
        'A Lightdash chart has one result set; the importer picks the frame when it converts the query.',
    ),
    'options.showHeader': NO_HEADER_SWITCH,
    'options.sortBy': NO_SORT,
};

const TABLE_OLD_OPTIONS: GrafanaPanelOptionTable = {
    columns: builtin(
        'columns[field].visible',
        'Listed columns are visible; the rest are hidden.',
    ),
    fontSize: dropped('Lightdash tables use one font size.'),
    scroll: dropped('Lightdash tables always scroll inside the tile.'),
    showHeader: NO_HEADER_SWITCH,
    sort: NO_SORT,
    styles: builtin(
        'columns[field]',
        'alias is name and type hidden is visible: false; unit and decimals become the field format, and thresholds with colors become conditionalFormattings.',
    ),
    transform: dropped(
        'Reshapes the result in the browser (timeseries to rows or columns); the query returns the shape instead.',
    ),
};

const TEXT_OPTIONS: GrafanaPanelOptionTable = {
    editable: dropped('Grafana editor state, not content.'),
    error: dropped('Grafana render state, not content.'),
    'options.code.language': tile(
        'DashboardMarkdownTileProperties.properties.content',
        'Code mode content is wrapped in a fenced code block with this language.',
    ),
    'options.code.showLineNumbers': dropped(
        'Markdown code blocks have no line numbers.',
    ),
    'options.code.showMiniMap': dropped(
        'Markdown code blocks have no minimap.',
    ),
    'options.content': tile(
        'DashboardMarkdownTileProperties.properties.content',
        'Copied as the markdown tile content.',
    ),
    'options.mode': tile(
        'DashboardMarkdownTileProperties.properties.content',
        'markdown is copied; html is copied as-is into the markdown; code is wrapped in a fenced code block.',
    ),
};

const LOGS_OPTIONS: GrafanaPanelOptionTable = {
    'options.dedupStrategy': dropped(
        'The log stream shows every line; it does not deduplicate.',
    ),
    'options.enableLogDetails': dropped(
        'Every log stream line can be expanded to show its details.',
    ),
    'options.prettifyLogMessage': dropped(
        'The log stream shows each line as stored.',
    ),
    'options.showCommonLabels': dropped(
        'The log stream has no common labels header.',
    ),
    'options.showLabels': native('LogStreamChart.showLabels'),
    'options.showTime': dropped(
        'The log stream always shows each line’s timestamp (LogStreamChart.timestampFieldId).',
    ),
    'options.sortOrder': native(
        'LogStreamChart.newestFirst',
        'Descending is true; Ascending is false.',
    ),
    'options.wrapLogMessage': native('LogStreamChart.wrapLines'),
};

/** Options set on any panel type (listed as `*` in the fixture). */
const COMMON_CHART_OPTIONS: GrafanaPanelOptionTable = {
    collapsed: dropped('Only Grafana rows collapse; other panels ignore it.'),
    description: tile(
        'SavedChart.description',
        'Shown in the chart tile’s description tooltip.',
    ),
    hideTimeOverride: dropped(
        'Only hides the time override badge, and time overrides are dropped.',
    ),
    interval: dropped(
        'Lightdash buckets time by the time dimension’s interval (for example _minute), which the importer picks when it converts the query.',
    ),
    links: NO_LINKS,
    maxDataPoints: dropped(
        'Lightdash limits rows with the query limit, which the importer sets when it converts the query.',
    ),
    timeFrom: dropped(
        'Lightdash tiles have no per-tile time override; dashboard filters apply to the whole dashboard.',
    ),
    timeShift: dropped(
        'Lightdash tiles have no per-tile time shift; dashboard filters apply to the whole dashboard.',
    ),
    transformations: dropped(
        'Grafana transformations reshape data in the browser; Lightdash shapes data in the query, which the importer does not generate from transformations.',
    ),
};

const COMMON_TEXT_TILE_OPTIONS: GrafanaPanelOptionTable = {
    ...COMMON_CHART_OPTIONS,
    description: dropped(
        'Markdown and heading tiles have no description; only a title and content.',
    ),
};

const ROW_OPTIONS: GrafanaPanelOptionTable = {
    ...COMMON_TEXT_TILE_OPTIONS,
    collapsed: dropped(
        'Lightdash heading tiles do not collapse; the panels in a collapsed row are imported expanded below the heading.',
    ),
};

const PANEL_OPTION_TABLES: Readonly<
    Partial<Record<GrafanaPanelType, GrafanaPanelOptionTable>>
> = {
    barchart: { ...COMMON_CHART_OPTIONS, ...BARCHART_OPTIONS },
    bargauge: { ...COMMON_CHART_OPTIONS, ...BAR_GAUGE_OPTIONS },
    gauge: { ...COMMON_CHART_OPTIONS, ...GAUGE_OPTIONS },
    graph: { ...COMMON_CHART_OPTIONS, ...GRAPH_OPTIONS },
    logs: { ...COMMON_CHART_OPTIONS, ...LOGS_OPTIONS },
    piechart: { ...COMMON_CHART_OPTIONS, ...PIE_OPTIONS },
    row: ROW_OPTIONS,
    stat: { ...COMMON_CHART_OPTIONS, ...STAT_OPTIONS },
    table: { ...COMMON_CHART_OPTIONS, ...TABLE_OPTIONS },
    'table-old': { ...COMMON_CHART_OPTIONS, ...TABLE_OLD_OPTIONS },
    text: { ...COMMON_TEXT_TILE_OPTIONS, ...TEXT_OPTIONS },
    timeseries: { ...COMMON_CHART_OPTIONS, ...CARTESIAN_FIELD_OPTIONS },
};

/**
 * The option paths the dashboards set on panel types that are dropped
 * (alertlist, dashlist, news). They go with their panel.
 */
const DROPPED_PANEL_OPTION_PATHS: Readonly<
    Partial<Record<GrafanaPanelType, readonly string[]>>
> = {
    alertlist: [
        'options.alertInstanceLabelFilter',
        'options.alertName',
        'options.dashboardAlerts',
        'options.groupBy',
        'options.groupMode',
        'options.maxItems',
        'options.sortOrder',
        'options.stateFilter.error',
        'options.stateFilter.firing',
        'options.stateFilter.noData',
        'options.stateFilter.normal',
        'options.stateFilter.pending',
        'options.viewMode',
    ],
    dashlist: [
        'options.includeVars',
        'options.keepTime',
        'options.maxItems',
        'options.query',
        'options.showFolderNames',
        'options.showHeadings',
        'options.showRecentlyViewed',
        'options.showSearch',
        'options.showStarred',
        'options.tags',
    ],
    news: ['options.feedUrl', 'options.showImage'],
};

const hasOwn = (object: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(object, key);

const lookupOption = (
    type: GrafanaPanelType,
    path: string,
): GrafanaPanelOptionEntry | undefined => {
    const panel = GRAFANA_PANEL_MAPPINGS[type];
    if (panel.target === 'dropped') {
        const known =
            hasOwn(COMMON_CHART_OPTIONS, path) ||
            (DROPPED_PANEL_OPTION_PATHS[type] ?? []).includes(path);
        return known
            ? dropped(`The ${type} panel is not imported: ${panel.reason}`)
            : undefined;
    }
    const table = PANEL_OPTION_TABLES[type];
    return table && hasOwn(table, path) ? table[path] : undefined;
};

/**
 * Where a Grafana panel option lands in Lightdash, or why it is dropped.
 * Undefined for an unknown panel type or an option path the dashboards do
 * not use.
 */
export const getGrafanaPanelOptionMapping = (
    type: string,
    path: string,
): GrafanaPanelOptionMapping | undefined => {
    if (!isGrafanaPanelType(type)) return undefined;
    const entry = lookupOption(type, path);
    return entry ? { ...entry, grafanaType: type, path } : undefined;
};
