/**
 * Feature viz-trace-waterfall-clock-skew: when clocks disagree, a child that
 * starts before its parent or ends after it is clamped into the parent's
 * window, and marked as clamped.
 */
import { describe, expect, it } from 'vitest';
import { SPAN_FIELD_IDS, traceWaterfallModel } from './fixtures';

describe('clock skew', () => {
    const spans = traceWaterfallModel(
        [
            {
                spanId: 'root',
                parentSpanId: null,
                service: 'gateway',
                name: 'GET /checkout',
                at: 0,
                durationMs: 200,
            },
            {
                spanId: 'early',
                parentSpanId: 'root',
                service: 'cart',
                name: 'cart.load',
                at: -20,
                durationMs: 30,
            },
            {
                spanId: 'late',
                parentSpanId: 'root',
                service: 'payments',
                name: 'payments.authorize',
                at: 190,
                durationMs: 50,
            },
            {
                spanId: 'fine',
                parentSpanId: 'root',
                service: 'cart',
                name: 'cart.price',
                at: 40,
                durationMs: 20,
            },
        ],
        SPAN_FIELD_IDS,
    ).traces[0];
    const byId = Object.fromEntries(
        spans.spans.map((s: { spanId: string }) => [s.spanId, s]),
    );

    it('measures the trace from its root, not the skewed child', () => {
        expect(byId.root.offsetMs).toBe(0);
        expect(spans.durationMs).toBe(200);
    });

    it('clamps a child that starts before its parent', () => {
        expect(byId.early.offsetMs).toBe(0);
        expect(byId.early.durationMs).toBe(10);
        expect(byId.early.isClamped).toBe(true);
    });

    it('clamps a child that ends after its parent', () => {
        expect(byId.late.offsetMs).toBe(190);
        expect(byId.late.durationMs).toBe(10);
        expect(byId.late.isClamped).toBe(true);
    });

    it('leaves a child inside its parent alone', () => {
        expect(byId.fine.offsetMs).toBe(40);
        expect(byId.fine.durationMs).toBe(20);
        expect(byId.fine.isClamped).toBe(false);
    });

    it('keeps the reported duration for the detail view', () => {
        expect(byId.late.reportedDurationMs).toBe(50);
    });
});
