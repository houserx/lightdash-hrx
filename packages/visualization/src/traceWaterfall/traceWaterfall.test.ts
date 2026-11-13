import {
    ChartType,
    DimensionType,
    FieldType,
    type ResultRow,
} from '@lightdash/common';
import { describe, expect, test } from 'vitest';
import { type ChartData } from '../chartData';
import { renderChart } from '../render';
import { parseSpanAttributes } from './model';

const cell = (raw: unknown) => ({
    value: { raw, formatted: raw === null ? '' : String(raw) },
});

const dim = (label: string, type = DimensionType.STRING) => ({
    fieldType: FieldType.DIMENSION,
    type,
    label,
});

const T0 = Date.UTC(2026, 0, 1);

type Span = {
    trace?: string;
    id: string;
    parent: string | null;
    at: number;
    ms: unknown;
    service?: string;
};

// The bare columns of a SQL runner query over `trace()`; `start` arrives as
// a Date (pg parses timestamptz), `parent_span_id` is listed before `span_id`.
const traceData = (spans: Span[]): ChartData => ({
    rows: spans.map(
        (s): ResultRow => ({
            trace_id: cell(s.trace ?? 't1'),
            parent_span_id: cell(s.parent),
            span_id: cell(s.id),
            service: cell(s.service ?? 'api'),
            name: cell(`op ${s.id}`),
            start: cell(new Date(T0 + s.at)),
            duration_ms: cell(s.ms),
            status: cell('ok'),
            attributes: cell(null),
        }),
    ),
    fields: {
        trace_id: dim('trace_id'),
        parent_span_id: dim('parent_span_id'),
        span_id: dim('span_id'),
        service: dim('service'),
        name: dim('name'),
        start: dim('start', DimensionType.TIMESTAMP),
        duration_ms: dim('duration_ms', DimensionType.NUMBER),
        status: dim('status'),
        attributes: dim('attributes'),
    },
});

const render = (data: ChartData, config: Record<string, unknown> = {}) =>
    renderChart(
        { chartConfig: { type: ChartType.TRACE_WATERFALL, config } },
        data,
    );

const modelOf = (data: ChartData, config: Record<string, unknown> = {}) => {
    const rendered = render(data, config);
    if (rendered.kind !== 'traceWaterfall') throw new Error(rendered.kind);
    return rendered.model;
};

describe('trace waterfall', () => {
    test('binds bare trace() columns, never span_id to parent_span_id', () => {
        const model = modelOf(
            traceData([
                { id: 'child', parent: 'root', at: 5, ms: '10.5' },
                { id: 'root', parent: null, at: 0, ms: 20 },
            ]),
        );
        expect(
            model.traces[0].spans.map((s) => [
                s.spanId,
                s.parentSpanId,
                s.depth,
                s.offsetMs,
                s.durationMs,
            ]),
        ).toEqual([
            ['root', null, 0, 0, 20],
            ['child', 'root', 1, 5, 10.5],
        ]);
        expect(model.traces[0].startMs).toBe(T0);
    });

    test('groups traces in row order of first appearance', () => {
        const model = modelOf(
            traceData([
                { trace: 'late', id: 'x', parent: null, at: 100, ms: 1 },
                { trace: 'early', id: 'y', parent: null, at: 0, ms: 1 },
                { trace: 'late', id: 'z', parent: 'x', at: 100, ms: 1 },
            ]),
        );
        expect(model.traces.map((t) => t.traceId)).toEqual(['late', 'early']);
        expect(model.traces[0].spans).toHaveLength(2);
    });

    test('a span in a parent cycle is still drawn', () => {
        const model = modelOf(
            traceData([
                { id: 'root', parent: null, at: 0, ms: 50 },
                { id: 'p', parent: 'q', at: 10, ms: 5 },
                { id: 'q', parent: 'p', at: 20, ms: 5 },
            ]),
        );
        expect(model.traces[0].spans.map((s) => s.spanId)).toEqual([
            'root',
            'p',
            'q',
        ]);
    });

    test('keeps a configured field the data has', () => {
        const data = traceData([{ id: 'a', parent: null, at: 0, ms: 1 }]);
        const rendered = render(data, { serviceFieldId: 'name' });
        if (rendered.kind !== 'traceWaterfall') throw new Error(rendered.kind);
        expect(rendered.model.traces[0].spans[0].service).toBe('op a');
    });

    test('says the config is incomplete with no span id column', () => {
        const data = traceData([{ id: 'a', parent: null, at: 0, ms: 1 }]);
        const { span_id: _, ...fields } = data.fields;
        const rows = data.rows.map(({ span_id: __, ...row }) => row);
        expect(render({ rows, fields })).toMatchObject({
            kind: 'empty',
            reason: 'incompleteConfig',
        });
    });

    test('attributes come from objects or JSON text', () => {
        expect(parseSpanAttributes({ a: 1 })).toEqual({ a: 1 });
        expect(parseSpanAttributes('{"a":"x"}')).toEqual({ a: 'x' });
        expect(parseSpanAttributes('not json')).toEqual({});
        expect(parseSpanAttributes('[1]')).toEqual({});
        expect(parseSpanAttributes(null)).toEqual({});
    });
});
