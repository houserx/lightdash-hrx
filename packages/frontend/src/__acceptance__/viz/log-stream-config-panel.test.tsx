/**
 * Feature viz-log-stream-config-panel: the log stream config panel binds
 * the line, timestamp, level and labels fields, toggles wrap / newest first
 * / show labels, and edits the colour of each level.
 */
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LogStreamConfigPanel } from '../../components/VisualizationConfigs/LogStreamConfig/LogStreamConfigPanel';
import { LOG_FIELD_IDS, renderWithMantine } from './fixtures';

const FIELDS = [
    { id: 'app_logs_timestamp', label: 'Timestamp' },
    { id: 'app_logs_line', label: 'Line' },
    { id: 'app_logs_level', label: 'Level' },
    { id: 'app_logs_labels', label: 'Labels' },
    { id: 'app_logs_message', label: 'Message' },
];

const setup = (config = { ...LOG_FIELD_IDS, wrapLines: false }) => {
    const onChange = vi.fn();
    renderWithMantine(
        <LogStreamConfigPanel
            config={config}
            fields={FIELDS}
            onChange={onChange}
        />,
    );
    return onChange;
};

describe('LogStreamConfigPanel', () => {
    it('has a picker for each field binding', () => {
        setup();
        for (const label of [
            /line field/i,
            /timestamp field/i,
            /level field/i,
            /labels field/i,
        ]) {
            expect(screen.getByLabelText(label)).toBeInTheDocument();
        }
    });

    it('rebinds the line field', async () => {
        const user = userEvent.setup();
        const onChange = setup();
        await user.click(screen.getByLabelText(/line field/i));
        await user.click(await screen.findByRole('option', { name: 'Message' }));
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ lineFieldId: 'app_logs_message' }),
        );
    });

    it.each([
        [/wrap lines/i, 'wrapLines', true],
        [/newest first/i, 'newestFirst', false],
        [/show labels/i, 'showLabels', true],
    ])('toggles %s', async (label, key, value) => {
        const user = userEvent.setup();
        const onChange = setup();
        await user.click(screen.getByLabelText(label));
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ [key]: value }),
        );
    });

    it('edits a level colour, with an input for each of the seven levels', () => {
        const onChange = setup();
        for (const level of [
            'Critical',
            'Error',
            'Warning',
            'Info',
            'Debug',
            'Trace',
            'Unknown',
        ]) {
            expect(
                screen.getByLabelText(new RegExp(`^${level} colou?r$`, 'i')),
            ).toBeInTheDocument();
        }
        fireEvent.change(screen.getByLabelText(/^error colou?r$/i), {
            target: { value: '#000000' },
        });
        expect(onChange).toHaveBeenLastCalledWith(
            expect.objectContaining({
                levelColors: expect.objectContaining({ error: '#000000' }),
            }),
        );
    });
});
