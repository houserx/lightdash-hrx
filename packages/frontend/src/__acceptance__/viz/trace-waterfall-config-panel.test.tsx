/**
 * Feature viz-trace-waterfall-config-panel: the config panel binds each
 * span column (trace id, span id, parent, service, name, start, duration,
 * status, attributes) to a result field.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TraceWaterfallConfigPanel } from '../../components/VisualizationConfigs/TraceWaterfallConfig/TraceWaterfallConfigPanel';
import { SPAN_FIELD_IDS, renderWithMantine } from './fixtures';

const FIELDS = [
    { id: 'spans_trace_id', label: 'Trace ID' },
    { id: 'spans_span_id', label: 'Span ID' },
    { id: 'spans_parent_span_id', label: 'Parent span ID' },
    { id: 'spans_service', label: 'Service' },
    { id: 'spans_service_name', label: 'Service name' },
    { id: 'spans_name', label: 'Name' },
    { id: 'spans_start', label: 'Start' },
    { id: 'spans_duration_ms', label: 'Duration (ms)' },
    { id: 'spans_status', label: 'Status' },
    { id: 'spans_attributes', label: 'Attributes' },
];

describe('TraceWaterfallConfigPanel', () => {
    it('has a picker for every span column', () => {
        renderWithMantine(
            <TraceWaterfallConfigPanel
                config={SPAN_FIELD_IDS}
                fields={FIELDS}
                onChange={vi.fn()}
            />,
        );
        for (const label of [
            /trace id field/i,
            /^span id field/i,
            /parent span id field/i,
            /^service field/i,
            /span name field/i,
            /start field/i,
            /duration field/i,
            /status field/i,
            /attributes field/i,
        ]) {
            expect(screen.getByLabelText(label)).toBeInTheDocument();
        }
    });

    it('rebinds the service field', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithMantine(
            <TraceWaterfallConfigPanel
                config={SPAN_FIELD_IDS}
                fields={FIELDS}
                onChange={onChange}
            />,
        );
        await user.click(screen.getByLabelText(/^service field/i));
        await user.click(
            await screen.findByRole('option', { name: 'Service name' }),
        );
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ serviceFieldId: 'spans_service_name' }),
        );
    });
});
