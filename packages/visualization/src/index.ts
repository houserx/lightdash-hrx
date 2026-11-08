/**
 * `@lightdash/visualization`: draws a Lightdash chart from its data.
 *
 * A chart (`ChartView`) and its data (`ChartData`) go in; what to draw comes
 * out (`RenderedChart`): an ECharts option, a table, big number or log
 * stream model, a Vega-Lite spec, or `empty` with the reason. The engine never runs a query.
 */

// Drawing
export {
    buildChart,
    renderChart,
    resolveChart,
    type ChartColors,
    type EChartsChartType,
    type EmptyReason,
    type LegendSelection,
    type RenderedChart,
    type RenderOptions,
    type RenderOutput,
    type ResolvedChart,
} from './render';

// What goes in
export type {
    ChartData,
    ChartField,
    ChartFieldDefinition,
    ChartFields,
    ChartQuery,
    ChartView,
} from './chartData';
export { toResultRows, type ToResultRowsOptions } from './results';
export { computeLimitedRowCount, sliceRows } from './rows';

// How it looks
export {
    DARK_VISUALIZATION_THEME,
    LIGHT_VISUALIZATION_THEME,
    type VisualizationTheme,
} from './theme';
export type { ColorAssignments } from './colors/assignments';

// What comes out, beyond ECharts options
export type {
    BigNumberComparisonModel,
    BigNumberModel,
} from './bigNumber/model';
export type {
    TableColumnHeader,
    TableModel,
    TableModelColumn,
    TableSubtotalCell,
    TableTotalCell,
} from './table/model';
export type { CustomVisualizationData } from './custom/config';
export type { LogStreamLine, LogStreamModel } from './logStream/model';
export type {
    TraceWaterfallModel,
    TraceWaterfallSpan,
    TraceWaterfallTrace,
} from './traceWaterfall/model';
