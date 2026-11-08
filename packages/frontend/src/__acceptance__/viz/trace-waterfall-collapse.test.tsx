/**
 * Feature viz-trace-waterfall-collapse: a span with children can be
 * collapsed to hide its whole subtree, and expanded again.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TraceWaterfallView } from '../../components/TraceWaterfall/TraceWaterfallView';
import {
    BASIC_TRACE,
    SPAN_FIELD_IDS,
    renderWithMantine,
    traceWaterfallModel,
} from './fixtures';

const ids = () =>
    screen
        .getAllByTestId('trace-span-row')
        .map((r) => r.getAttribute('data-span-id'));

describe('TraceWaterfallView collapse and expand', () => {
    it('hides and shows a subtree', async () => {
        const user = userEvent.setup();
        const model = traceWaterfallModel(BASIC_TRACE, SPAN_FIELD_IDS);
        renderWithMantine(<TraceWaterfallView model={model} />);
        expect(ids()).toEqual(['a', 'e', 'b', 'c', 'd']);

        await user.click(
            screen.getByRole('button', { name: 'Collapse orders.list' }),
        );
        expect(ids()).toEqual(['a', 'e', 'b']);

        await user.click(
            screen.getByRole('button', { name: 'Expand orders.list' }),
        );
        expect(ids()).toEqual(['a', 'e', 'b', 'c', 'd']);
    });

    it('collapsing the root hides everything under it', async () => {
        const user = userEvent.setup();
        const model = traceWaterfallModel(BASIC_TRACE, SPAN_FIELD_IDS);
        renderWithMantine(<TraceWaterfallView model={model} />);
        await user.click(
            screen.getByRole('button', { name: 'Collapse GET /orders' }),
        );
        expect(ids()).toEqual(['a']);
    });

    it('offers no toggle on a leaf span', () => {
        const model = traceWaterfallModel(BASIC_TRACE, SPAN_FIELD_IDS);
        renderWithMantine(<TraceWaterfallView model={model} />);
        expect(
            screen.queryByRole('button', { name: /collapse cache\.get/i }),
        ).toBeNull();
    });
});
