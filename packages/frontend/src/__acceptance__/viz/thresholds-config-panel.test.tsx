/**
 * Feature viz-thresholds-config-panel: the cartesian chart config gets a
 * thresholds panel to add, edit and remove steps and choose the style.
 */
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ThresholdsConfig } from '../../components/VisualizationConfigs/ThresholdsConfig/ThresholdsConfig';
import { renderWithMantine } from './fixtures';

const THRESHOLDS = {
    mode: 'absolute' as const,
    style: 'line' as const,
    steps: [
        { value: null, color: '#73BF69' },
        { value: 80, color: '#F2495C' },
    ],
};

describe('ThresholdsConfig', () => {
    it('adds a step above the highest one', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithMantine(
            <ThresholdsConfig thresholds={THRESHOLDS} onChange={onChange} />,
        );
        await user.click(screen.getByRole('button', { name: /add threshold/i }));
        const next = onChange.mock.lastCall![0];
        expect(next.steps).toHaveLength(3);
        expect(next.steps[2].value).toBeGreaterThan(80);
    });

    it('edits a step value', () => {
        const onChange = vi.fn();
        renderWithMantine(
            <ThresholdsConfig thresholds={THRESHOLDS} onChange={onChange} />,
        );
        fireEvent.change(screen.getByLabelText('Threshold 2 value'), {
            target: { value: '75' },
        });
        expect(onChange.mock.lastCall![0].steps[1].value).toBe(75);
    });

    it('removes a step but never the base', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithMantine(
            <ThresholdsConfig thresholds={THRESHOLDS} onChange={onChange} />,
        );
        expect(
            screen.queryByRole('button', { name: 'Remove threshold 1' }),
        ).toBeNull();
        await user.click(
            screen.getByRole('button', { name: 'Remove threshold 2' }),
        );
        expect(onChange.mock.lastCall![0].steps).toHaveLength(1);
    });

    it('switches the style', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithMantine(
            <ThresholdsConfig thresholds={THRESHOLDS} onChange={onChange} />,
        );
        await user.click(screen.getByLabelText('Dashed'));
        expect(onChange.mock.lastCall![0].style).toBe('dashed');
        for (const label of ['Line', 'Area', 'Line + area', 'Dashed + area']) {
            expect(screen.getByLabelText(label)).toBeInTheDocument();
        }
    });

    it('starts from nothing when the chart has no thresholds', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithMantine(
            <ThresholdsConfig thresholds={undefined} onChange={onChange} />,
        );
        await user.click(screen.getByRole('button', { name: /add threshold/i }));
        const next = onChange.mock.lastCall![0];
        expect(next.steps.length).toBeGreaterThanOrEqual(1);
        expect(next.steps[0].value).toBeNull();
    });
});
