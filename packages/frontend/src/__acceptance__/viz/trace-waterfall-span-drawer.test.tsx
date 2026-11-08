/**
 * Feature viz-trace-waterfall-span-drawer: clicking a span opens a detail
 * drawer with its name, service, status, duration, ids and every attribute.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TraceWaterfallView } from '../../components/TraceWaterfall/TraceWaterfallView';
import {
    BASIC_TRACE,
    SPAN_FIELD_IDS,
    renderWithMantine,
    traceWaterfallModel,
} from './fixtures';

describe('TraceWaterfallView span detail drawer', () => {
    it('shows the clicked span details and attributes', async () => {
        const user = userEvent.setup();
        const model = traceWaterfallModel(BASIC_TRACE, SPAN_FIELD_IDS);
        renderWithMantine(<TraceWaterfallView model={model} />);
        const row = screen
            .getAllByTestId('trace-span-row')
            .find((r) => r.getAttribute('data-span-id') === 'c')!;
        await user.click(within(row).getByText('SELECT orders'));

        const drawer = await screen.findByRole('dialog');
        expect(within(drawer).getAllByText('SELECT orders').length).toBeGreaterThan(0);
        expect(within(drawer).getByText('postgres')).toBeInTheDocument();
        expect(within(drawer).getByText('ok')).toBeInTheDocument();
        expect(within(drawer).getByText(/50\s?ms/)).toBeInTheDocument();
        expect(within(drawer).getByText('c')).toBeInTheDocument();
        expect(within(drawer).getByText('db.system')).toBeInTheDocument();
        expect(within(drawer).getByText('postgresql')).toBeInTheDocument();
        expect(within(drawer).getByText('db.statement')).toBeInTheDocument();
        expect(
            within(drawer).getByText('SELECT * FROM orders WHERE id = $1'),
        ).toBeInTheDocument();
    });

    it('shows attributes that arrived as JSON text', async () => {
        const user = userEvent.setup();
        const model = traceWaterfallModel(BASIC_TRACE, SPAN_FIELD_IDS);
        renderWithMantine(<TraceWaterfallView model={model} />);
        await user.click(screen.getByText('cache.get'));
        const drawer = await screen.findByRole('dialog');
        expect(within(drawer).getByText('cache.key')).toBeInTheDocument();
        expect(within(drawer).getByText('orders:recent')).toBeInTheDocument();
        expect(within(drawer).getByText('error')).toBeInTheDocument();
    });

    it('notes when a span was clamped for clock skew', async () => {
        const user = userEvent.setup();
        const model = traceWaterfallModel(
            [
                ...BASIC_TRACE,
                {
                    spanId: 'late',
                    parentSpanId: 'a',
                    service: 'payments',
                    name: 'payments.authorize',
                    at: 190,
                    durationMs: 50,
                },
            ],
            SPAN_FIELD_IDS,
        );
        renderWithMantine(<TraceWaterfallView model={model} />);
        await user.click(screen.getByText('payments.authorize'));
        const drawer = await screen.findByRole('dialog');
        expect(within(drawer).getByText(/clamped|clock skew/i)).toBeInTheDocument();
        expect(within(drawer).getByText(/50\s?ms/)).toBeInTheDocument();
    });
});
