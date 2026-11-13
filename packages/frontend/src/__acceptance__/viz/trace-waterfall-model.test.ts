/**
 * Feature viz-trace-waterfall-model: `renderChart` turns `trace()` span rows
 * into a waterfall model: spans in tree order (depth first, children by
 * start), with depth, offset from the trace start, duration and a colour per
 * service.
 */
import { describe, expect, it } from 'vitest';
import {
    BASIC_TRACE,
    SPAN_FIELD_IDS,
    renderTraceWaterfall,
    traceWaterfallModel,
} from './fixtures';

type Span = {
    spanId: string;
    parentSpanId: string | null;
    name: string;
    service: string;
    depth: number;
    offsetMs: number;
    durationMs: number;
    status: string;
    color: string;
    attributes: Record<string, unknown>;
    isOrphan: boolean;
    isClamped: boolean;
};

describe('trace waterfall model', () => {
    it('renders as a traceWaterfall', () => {
        expect(renderTraceWaterfall(BASIC_TRACE, SPAN_FIELD_IDS).kind).toBe(
            'traceWaterfall',
        );
    });

    it('orders spans depth first, children by start time', () => {
        const model = traceWaterfallModel(BASIC_TRACE, SPAN_FIELD_IDS);
        expect(model.traces).toHaveLength(1);
        const spans: Span[] = model.traces[0].spans;
        expect(spans.map((s) => s.spanId)).toEqual(['a', 'e', 'b', 'c', 'd']);
        expect(spans.map((s) => s.depth)).toEqual([0, 1, 1, 2, 2]);
    });

    it('measures offsets from the trace start, and the trace duration', () => {
        const model = traceWaterfallModel(BASIC_TRACE, SPAN_FIELD_IDS);
        const trace = model.traces[0];
        expect(trace.traceId).toBe('trace-a');
        expect(trace.durationMs).toBe(200);
        expect(
            trace.spans.map((s: Span) => [s.spanId, s.offsetMs, s.durationMs]),
        ).toEqual([
            ['a', 0, 200],
            ['e', 5, 3],
            ['b', 10, 150],
            ['c', 20, 50],
            ['d', 80, 5],
        ]);
    });

    it('carries service, status and parsed attributes', () => {
        const spans: Span[] = traceWaterfallModel(BASIC_TRACE, SPAN_FIELD_IDS)
            .traces[0].spans;
        const byId = Object.fromEntries(spans.map((s) => [s.spanId, s]));
        expect(byId.c.service).toBe('postgres');
        expect(byId.d.status).toBe('error');
        expect(byId.a.attributes).toEqual({
            'http.method': 'GET',
            'http.route': '/orders',
        });
        expect(byId.c.attributes['db.system']).toBe('postgresql');
    });

    it('gives each service one colour, and different services different colours', () => {
        const spans: Span[] = traceWaterfallModel(
            [
                ...BASIC_TRACE,
                {
                    spanId: 'f',
                    parentSpanId: 'b',
                    service: 'postgres',
                    name: 'SELECT items',
                    at: 90,
                    durationMs: 10,
                },
            ],
            SPAN_FIELD_IDS,
        ).traces[0].spans;
        const colorOf = (service: string) =>
            new Set(spans.filter((s) => s.service === service).map((s) => s.color));
        expect(colorOf('postgres').size).toBe(1);
        const all = new Set(spans.map((s) => s.color));
        expect(all.size).toBe(new Set(spans.map((s) => s.service)).size);
    });

    it('binds the trace() columns by name when the config names none', () => {
        const spans: Span[] = traceWaterfallModel(BASIC_TRACE).traces[0].spans;
        expect(spans.map((s) => s.spanId)).toEqual(['a', 'e', 'b', 'c', 'd']);
        expect(spans[0].parentSpanId).toBeNull();
    });

    it('renders empty when there are no rows', () => {
        expect(renderTraceWaterfall([], SPAN_FIELD_IDS).kind).toBe('empty');
    });
});
