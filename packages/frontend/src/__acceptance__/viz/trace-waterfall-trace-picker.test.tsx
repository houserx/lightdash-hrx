/**
 * Feature viz-trace-waterfall-trace-picker: when the results hold several
 * traces, the first trace in the results is shown and a "Trace" picker
 * switches between them. A single trace shows no picker.
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

const TRACE_B = [
    {
        traceId: 'trace-b',
        spanId: 'b-root',
        parentSpanId: null,
        service: 'worker',
        name: 'job.run',
        at: 3_600_000,
        durationMs: 40,
    },
    {
        traceId: 'trace-b',
        spanId: 'b-child',
        parentSpanId: 'b-root',
        service: 'worker',
        name: 'job.step',
        at: 3_600_010,
        durationMs: 20,
    },
];

describe('TraceWaterfallView trace picker', () => {
    it('groups spans by trace', () => {
        const model = traceWaterfallModel(
            [...BASIC_TRACE, ...TRACE_B],
            SPAN_FIELD_IDS,
        );
        expect(model.traces.map((t: { traceId: string }) => t.traceId)).toEqual([
            'trace-a',
            'trace-b',
        ]);
    });

    it('shows the first trace and switches to another', async () => {
        const user = userEvent.setup();
        const model = traceWaterfallModel(
            [...BASIC_TRACE, ...TRACE_B],
            SPAN_FIELD_IDS,
        );
        renderWithMantine(<TraceWaterfallView model={model} />);
        expect(screen.getAllByTestId('trace-span-row')).toHaveLength(5);
        expect(screen.queryByText('job.run')).toBeNull();

        await user.click(screen.getByLabelText('Trace'));
        await user.click(await screen.findByRole('option', { name: /trace-b/ }));
        expect(screen.getAllByTestId('trace-span-row')).toHaveLength(2);
        expect(screen.getByText('job.run')).toBeInTheDocument();
    });

    it('has no picker for a single trace', () => {
        const model = traceWaterfallModel(BASIC_TRACE, SPAN_FIELD_IDS);
        renderWithMantine(<TraceWaterfallView model={model} />);
        expect(screen.queryByLabelText('Trace')).toBeNull();
    });
});
