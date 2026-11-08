/**
 * Feature viz-trace-waterfall-service-colours: bars are coloured by
 * service, with a legend naming each service in its colour.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TraceWaterfallView } from '../../components/TraceWaterfall/TraceWaterfallView';
import {
    BASIC_TRACE,
    SPAN_FIELD_IDS,
    renderWithMantine,
    traceWaterfallModel,
} from './fixtures';

describe('TraceWaterfallView service colours', () => {
    const spans = [
        ...BASIC_TRACE,
        {
            spanId: 'f',
            parentSpanId: 'b',
            service: 'postgres',
            name: 'SELECT items',
            at: 90,
            durationMs: 10,
        },
    ];

    it('uses the model colour of each span service for its bar', () => {
        const model = traceWaterfallModel(spans, SPAN_FIELD_IDS);
        renderWithMantine(<TraceWaterfallView model={model} />);
        const colours = new Map<string, Set<string>>();
        for (const row of screen.getAllByTestId('trace-span-row')) {
            const span = model.traces[0].spans.find(
                (s: { spanId: string }) =>
                    s.spanId === row.getAttribute('data-span-id'),
            );
            const bar = within(row).getByTestId('trace-span-bar');
            expect(bar).toHaveStyle({ backgroundColor: span.color });
            const set = colours.get(span.service) ?? new Set();
            set.add(bar.style.backgroundColor);
            colours.set(span.service, set);
        }
        expect(colours.get('postgres')!.size).toBe(1);
        const distinct = new Set(
            [...colours.values()].map((s) => [...s][0]),
        );
        expect(distinct.size).toBe(colours.size);
    });

    it('shows a legend entry per service', () => {
        const model = traceWaterfallModel(spans, SPAN_FIELD_IDS);
        renderWithMantine(<TraceWaterfallView model={model} />);
        const legend = screen.getByTestId('trace-service-legend');
        for (const service of ['gateway', 'auth', 'orders-api', 'postgres', 'redis']) {
            expect(within(legend).getByText(service)).toBeInTheDocument();
        }
    });
});
