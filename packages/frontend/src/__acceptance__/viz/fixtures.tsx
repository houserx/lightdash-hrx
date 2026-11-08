/**
 * Synthetic telemetry results for the viz line's frontend acceptance checks.
 * Shapes follow docs/eng-1799/CONTRACTS.md §1.1: logs are `timestamp, line,
 * labels json` (plus `level`), spans are the `trace()` columns. Every value
 * here is made up.
 */
import {
    DimensionType,
    FieldType,
    MetricType,
    type ChartConfig,
    type ResultRow,
} from '@lightdash/common';
import {
    renderChart,
    type ChartData,
    type ChartFields,
    type RenderedChart,
} from '@lightdash/visualization';
import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
import { type ReactElement } from 'react';

export const renderWithMantine = (ui: ReactElement) =>
    render(
        <MantineProvider env="test" forceColorScheme="light">
            {ui}
        </MantineProvider>,
    );

const cell = (raw: unknown, formatted?: string) => ({
    value: {
        raw,
        formatted:
            formatted ??
            (raw === null || raw === undefined
                ? ''
                : typeof raw === 'object'
                  ? JSON.stringify(raw)
                  : String(raw)),
    },
});

const dim = (label: string, type = DimensionType.STRING) => ({
    fieldType: FieldType.DIMENSION,
    type,
    label,
});

// ---------------------------------------------------------------- logs

export const LOG_FIELDS: ChartFields = {
    app_logs_timestamp: dim('Timestamp', DimensionType.TIMESTAMP),
    app_logs_line: dim('Line'),
    app_logs_level: dim('Level'),
    app_logs_labels: dim('Labels'),
};

export const LOG_FIELD_IDS = {
    timestampFieldId: 'app_logs_timestamp',
    lineFieldId: 'app_logs_line',
    levelFieldId: 'app_logs_level',
    labelsFieldId: 'app_logs_labels',
};

export type SyntheticLog = {
    ts: string;
    line: string;
    level?: string | null;
    labels?: Record<string, string> | string;
};

export const logRow = ({ ts, line, level, labels }: SyntheticLog): ResultRow => {
    const row: ResultRow = {
        app_logs_timestamp: cell(ts),
        app_logs_line: cell(line),
        app_logs_labels: cell(labels ?? {}),
    };
    if (level !== undefined) row.app_logs_level = cell(level);
    return row;
};

/** Five lines, oldest first, one second apart. */
export const FIVE_LOGS: SyntheticLog[] = [
    {
        ts: '2026-11-08T10:00:01.000Z',
        line: 'GET /api/items 200 12ms',
        level: 'info',
        labels: { app: 'api', namespace: 'synthetic', pod: 'api-1' },
    },
    {
        ts: '2026-11-08T10:00:02.000Z',
        line: 'upstream request timeout after 30s',
        level: 'error',
        labels: { app: 'api', namespace: 'synthetic', pod: 'api-2' },
    },
    {
        ts: '2026-11-08T10:00:03.000Z',
        line: 'cache miss for key items:42',
        level: 'debug',
        labels: { app: 'cache', namespace: 'synthetic', pod: 'cache-1' },
    },
    {
        ts: '2026-11-08T10:00:04.000Z',
        line: 'retrying after TIMEOUT (attempt 2)',
        level: 'warn',
        labels: { app: 'worker', namespace: 'synthetic', pod: 'worker-1' },
    },
    {
        ts: '2026-11-08T10:00:05.000Z',
        line: 'disk usage at 97%',
        level: 'CRITICAL',
        labels: { app: 'node', namespace: 'synthetic', pod: 'node-1' },
    },
];

export const manyLogs = (count: number): SyntheticLog[] =>
    Array.from({ length: count }, (_, i) => ({
        ts: new Date(Date.UTC(2026, 10, 8, 10, 0, 0) + i * 1000).toISOString(),
        line: `synthetic line number ${i + 1}`,
        level: ['info', 'error', 'debug', 'warning'][i % 4],
        labels: { app: 'api', seq: String(i + 1) },
    }));

export const logData = (logs: SyntheticLog[]): ChartData => ({
    rows: logs.map(logRow),
    fields: LOG_FIELDS,
});

export const renderLogStream = (
    logs: SyntheticLog[],
    config: Record<string, unknown> = {},
): RenderedChart =>
    renderChart(
        {
            chartConfig: {
                type: 'log_stream',
                config,
            } as unknown as ChartConfig,
        },
        logData(logs),
    );

export const logStreamModel = (
    logs: SyntheticLog[],
    config: Record<string, unknown> = {},
) => {
    const rendered = renderLogStream(logs, config) as RenderedChart & {
        model?: unknown;
    };
    if (rendered.kind !== ('logStream' as string)) {
        throw new Error(`expected a logStream render, got ${rendered.kind}`);
    }
    return (rendered as unknown as { model: any }).model;
};

// -------------------------------------------------------------- traces

export const SPAN_FIELDS: ChartFields = {
    spans_trace_id: dim('Trace ID'),
    spans_span_id: dim('Span ID'),
    spans_parent_span_id: dim('Parent span ID'),
    spans_service: dim('Service'),
    spans_name: dim('Name'),
    spans_start: dim('Start', DimensionType.TIMESTAMP),
    spans_duration_ms: {
        fieldType: FieldType.METRIC,
        type: MetricType.NUMBER,
        label: 'Duration (ms)',
    },
    spans_status: dim('Status'),
    spans_attributes: dim('Attributes'),
};

export const SPAN_FIELD_IDS = {
    traceIdFieldId: 'spans_trace_id',
    spanIdFieldId: 'spans_span_id',
    parentSpanIdFieldId: 'spans_parent_span_id',
    serviceFieldId: 'spans_service',
    nameFieldId: 'spans_name',
    startFieldId: 'spans_start',
    durationMsFieldId: 'spans_duration_ms',
    statusFieldId: 'spans_status',
    attributesFieldId: 'spans_attributes',
};

export type SyntheticSpan = {
    traceId?: string;
    spanId: string;
    parentSpanId: string | null;
    service: string;
    name: string;
    /** ms after T0 */
    at: number;
    durationMs: number;
    status?: string;
    attributes?: Record<string, unknown> | string;
};

export const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

export const spanRow = (span: SyntheticSpan): ResultRow => ({
    spans_trace_id: cell(span.traceId ?? 'trace-a'),
    spans_span_id: cell(span.spanId),
    spans_parent_span_id: cell(span.parentSpanId),
    spans_service: cell(span.service),
    spans_name: cell(span.name),
    spans_start: cell(new Date(T0 + span.at).toISOString()),
    spans_duration_ms: cell(span.durationMs),
    spans_status: cell(span.status ?? 'ok'),
    spans_attributes: cell(span.attributes ?? {}),
});

/**
 * A: GET /orders (gateway) 0..200
 *   E: auth.check (auth) 5..8
 *   B: orders.list (orders-api) 10..160
 *     C: SELECT orders (postgres) 20..70
 *     D: cache.get (redis) 80..85
 */
export const BASIC_TRACE: SyntheticSpan[] = [
    {
        spanId: 'b',
        parentSpanId: 'a',
        service: 'orders-api',
        name: 'orders.list',
        at: 10,
        durationMs: 150,
    },
    {
        spanId: 'c',
        parentSpanId: 'b',
        service: 'postgres',
        name: 'SELECT orders',
        at: 20,
        durationMs: 50,
        attributes: {
            'db.system': 'postgresql',
            'db.statement': 'SELECT * FROM orders WHERE id = $1',
        },
    },
    {
        spanId: 'a',
        parentSpanId: null,
        service: 'gateway',
        name: 'GET /orders',
        at: 0,
        durationMs: 200,
        attributes: '{"http.method":"GET","http.route":"/orders"}',
    },
    {
        spanId: 'd',
        parentSpanId: 'b',
        service: 'redis',
        name: 'cache.get',
        at: 80,
        durationMs: 5,
        status: 'error',
        attributes: '{"cache.key":"orders:recent"}',
    },
    {
        spanId: 'e',
        parentSpanId: 'a',
        service: 'auth',
        name: 'auth.check',
        at: 5,
        durationMs: 3,
    },
];

export const spanData = (spans: SyntheticSpan[]): ChartData => ({
    rows: spans.map(spanRow),
    fields: SPAN_FIELDS,
});

export const renderTraceWaterfall = (
    spans: SyntheticSpan[],
    config: Record<string, unknown> = {},
): RenderedChart =>
    renderChart(
        {
            chartConfig: {
                type: 'trace_waterfall',
                config,
            } as unknown as ChartConfig,
        },
        spanData(spans),
    );

export const traceWaterfallModel = (
    spans: SyntheticSpan[],
    config: Record<string, unknown> = {},
) => {
    const rendered = renderTraceWaterfall(spans, config);
    if (rendered.kind !== ('traceWaterfall' as string)) {
        throw new Error(
            `expected a traceWaterfall render, got ${rendered.kind}`,
        );
    }
    return (rendered as unknown as { model: any }).model;
};

// ------------------------------------------------------ metric series

export const METRIC_FIELDS: ChartFields = {
    m_time: dim('Time', DimensionType.TIMESTAMP),
    m_value: {
        fieldType: FieldType.METRIC,
        type: MetricType.NUMBER,
        label: 'Value',
    },
    m_status: {
        fieldType: FieldType.METRIC,
        type: MetricType.NUMBER,
        label: 'Status',
    },
};

export const metricData = (points: [number, number][]): ChartData => ({
    rows: points.map(([minute, value], i) => ({
        m_time: cell(new Date(T0 + minute * 60_000).toISOString()),
        m_value: cell(value),
        m_status: cell(i % 2),
    })),
    fields: METRIC_FIELDS,
});

/** Reads a Blob in jsdom, where Blob#text may be missing. */
export const readBlob = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
    });
