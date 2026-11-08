import { type TraceWaterfallChart } from '@lightdash/common';
import { type ChartData } from '../chartData';

/** The columns a trace waterfall reads, each bound to a field id of the data. */
export type TraceWaterfallFieldRole =
    | 'traceId'
    | 'spanId'
    | 'parentSpanId'
    | 'service'
    | 'name'
    | 'start'
    | 'durationMs'
    | 'status'
    | 'attributes';

/**
 * The `trace()` column each role binds to when the config names no field
 * (CONTRACTS §1.1: `trace_id, span_id, parent_span_id, service, name, start,
 * duration_ms, status, attributes`).
 */
export const TRACE_WATERFALL_COLUMN_NAMES: Readonly<
    Record<TraceWaterfallFieldRole, string>
> = {
    traceId: 'trace_id',
    spanId: 'span_id',
    parentSpanId: 'parent_span_id',
    service: 'service',
    name: 'name',
    start: 'start',
    durationMs: 'duration_ms',
    status: 'status',
    attributes: 'attributes',
};

const ROLE_CONFIG_KEYS = {
    traceId: 'traceIdFieldId',
    spanId: 'spanIdFieldId',
    parentSpanId: 'parentSpanIdFieldId',
    service: 'serviceFieldId',
    name: 'nameFieldId',
    start: 'startFieldId',
    durationMs: 'durationMsFieldId',
    status: 'statusFieldId',
    attributes: 'attributesFieldId',
} as const satisfies Record<TraceWaterfallFieldRole, keyof TraceWaterfallChart>;

/** A trace waterfall config with its fields bound to the data. */
export type ResolvedTraceWaterfallChartConfig = TraceWaterfallChart;

const fieldIdsOf = (data: ChartData): string[] => {
    const ids = new Set(Object.keys(data.fields));
    Object.keys(data.rows[0] ?? {}).forEach((id) => ids.add(id));
    return [...ids];
};

const labelOf = (data: ChartData, fieldId: string): string | undefined => {
    const label = (data.fields[fieldId] as { label?: unknown } | undefined)
        ?.label;
    return typeof label === 'string'
        ? label.trim().toLowerCase().replace(/\s+/g, '_')
        : undefined;
};

/**
 * Whether a field id names the column: it is the column name or ends in
 * `_<name>` (Lightdash ids are `<table>_<column>`). `span_id` never matches
 * a `parent_span_id` column.
 */
const idNamesColumn = (fieldId: string, name: string): boolean => {
    const id = fieldId.toLowerCase();
    if (name === 'span_id' && id.endsWith('parent_span_id')) return false;
    return id === name || id.endsWith(`_${name}`);
};

/**
 * The field a role binds to by name: a field id naming the `trace()` column,
 * else a field labelled with it (spaces read as underscores).
 */
export const findTraceWaterfallField = (
    data: ChartData,
    role: TraceWaterfallFieldRole,
    exclude: ReadonlySet<string> = new Set(),
): string | undefined => {
    const name = TRACE_WATERFALL_COLUMN_NAMES[role];
    const ids = fieldIdsOf(data).filter((id) => !exclude.has(id));
    return (
        ids.find((id) => idNamesColumn(id, name)) ??
        ids.find((id) => labelOf(data, id) === name)
    );
};

/** Every role key present, `undefined` when unbound, so stale ids drop out. */
const fieldIdsWithUnbound = (
    fieldIds: TraceWaterfallChart,
): TraceWaterfallChart =>
    Object.fromEntries(
        Object.values(ROLE_CONFIG_KEYS).map((key) => [key, fieldIds[key]]),
    );

/**
 * Settles a trace waterfall config against its data: a field the config
 * names is kept while the data has it; otherwise the role binds to the
 * `trace()` column by name, so a `trace()` query draws without any
 * configuration.
 */
export const resolveTraceWaterfallChartConfig = ({
    chartConfig,
    data,
}: {
    chartConfig: TraceWaterfallChart | undefined;
    data: ChartData;
}): ResolvedTraceWaterfallChartConfig => {
    const config = chartConfig ?? {};
    const available = new Set(fieldIdsOf(data));
    const bound = new Set<string>();
    const fieldIds: TraceWaterfallChart = {};
    const roles = Object.keys(ROLE_CONFIG_KEYS) as TraceWaterfallFieldRole[];
    // Configured fields first, so auto-binding never takes one of them.
    roles.forEach((role) => {
        const configured = config[ROLE_CONFIG_KEYS[role]];
        if (configured && available.has(configured)) {
            fieldIds[ROLE_CONFIG_KEYS[role]] = configured;
            bound.add(configured);
        }
    });
    roles.forEach((role) => {
        if (fieldIds[ROLE_CONFIG_KEYS[role]]) return;
        const found = findTraceWaterfallField(data, role, bound);
        if (found) {
            fieldIds[ROLE_CONFIG_KEYS[role]] = found;
            bound.add(found);
        }
    });
    return { ...config, ...fieldIdsWithUnbound(fieldIds) };
};
