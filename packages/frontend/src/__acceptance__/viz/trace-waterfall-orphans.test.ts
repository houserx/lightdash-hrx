/**
 * Feature viz-trace-waterfall-orphans: a span whose parent is not in the
 * results is rooted at depth 0 (marked as an orphan) instead of vanishing.
 */
import { describe, expect, it } from 'vitest';
import { BASIC_TRACE, SPAN_FIELD_IDS, traceWaterfallModel } from './fixtures';

describe('orphan spans', () => {
    const spans = traceWaterfallModel(
        [
            ...BASIC_TRACE,
            {
                spanId: 'f',
                parentSpanId: 'span-not-in-results',
                service: 'billing',
                name: 'charge',
                at: 50,
                durationMs: 30,
            },
            {
                spanId: 'g',
                parentSpanId: 'f',
                service: 'billing',
                name: 'charge.db',
                at: 55,
                durationMs: 10,
            },
        ],
        SPAN_FIELD_IDS,
    ).traces[0].spans;

    it('keeps every span', () => {
        expect(spans).toHaveLength(7);
    });

    it('roots the orphan after the true root, ordered by start, with its children', () => {
        expect(spans.map((s: { spanId: string }) => s.spanId)).toEqual([
            'a',
            'e',
            'b',
            'c',
            'd',
            'f',
            'g',
        ]);
        const f = spans.find((s: { spanId: string }) => s.spanId === 'f');
        const g = spans.find((s: { spanId: string }) => s.spanId === 'g');
        expect(f.depth).toBe(0);
        expect(f.isOrphan).toBe(true);
        expect(g.depth).toBe(1);
        expect(g.isOrphan).toBe(false);
    });

    it('does not mark connected spans as orphans', () => {
        expect(
            spans
                .filter((s: { isOrphan: boolean }) => s.isOrphan)
                .map((s: { spanId: string }) => s.spanId),
        ).toEqual(['f']);
    });
});
