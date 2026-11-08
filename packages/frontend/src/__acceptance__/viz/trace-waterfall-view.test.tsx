/**
 * Feature viz-trace-waterfall-view: the waterfall shows one row per span in
 * tree order, indented by depth, with a bar placed on a time axis that runs
 * from 0 to the trace duration. Error spans are marked.
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

describe('TraceWaterfallView', () => {
    const model = traceWaterfallModel(BASIC_TRACE, SPAN_FIELD_IDS);

    it('shows a row per span in tree order with name and service', () => {
        renderWithMantine(<TraceWaterfallView model={model} />);
        const rows = screen.getAllByTestId('trace-span-row');
        expect(rows.map((r) => r.getAttribute('data-span-id'))).toEqual([
            'a',
            'e',
            'b',
            'c',
            'd',
        ]);
        expect(rows.map((r) => r.getAttribute('data-depth'))).toEqual([
            '0',
            '1',
            '1',
            '2',
            '2',
        ]);
        expect(within(rows[3]).getByText('SELECT orders')).toBeInTheDocument();
        expect(within(rows[3]).getByText('postgres')).toBeInTheDocument();
        expect(within(rows[3]).getByText(/50\s?ms/)).toBeInTheDocument();
    });

    it('places each bar by offset and duration as a share of the trace', () => {
        renderWithMantine(<TraceWaterfallView model={model} />);
        const row = screen
            .getAllByTestId('trace-span-row')
            .find((r) => r.getAttribute('data-span-id') === 'c')!;
        const bar = within(row).getByTestId('trace-span-bar');
        expect(bar.style.left).toBe('10%');
        expect(bar.style.width).toBe('25%');
        const root = screen
            .getAllByTestId('trace-span-row')
            .find((r) => r.getAttribute('data-span-id') === 'a')!;
        expect(within(root).getByTestId('trace-span-bar').style.width).toBe(
            '100%',
        );
    });

    it('draws a time axis from 0 ms to the trace duration', () => {
        renderWithMantine(<TraceWaterfallView model={model} />);
        const axis = screen.getByTestId('trace-time-axis');
        expect(within(axis).getByText('0 ms')).toBeInTheDocument();
        expect(within(axis).getByText('200 ms')).toBeInTheDocument();
    });

    it('marks error spans', () => {
        renderWithMantine(<TraceWaterfallView model={model} />);
        const row = screen
            .getAllByTestId('trace-span-row')
            .find((r) => r.getAttribute('data-span-id') === 'd')!;
        expect(row).toHaveAttribute('data-status', 'error');
    });

    it('says so when there are no spans', () => {
        renderWithMantine(<TraceWaterfallView model={{ traces: [] }} />);
        expect(screen.getByText(/no spans/i)).toBeInTheDocument();
    });
});
