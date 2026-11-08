/**
 * Feature viz-value-mappings-config-panel: a table column's config gets a
 * value mappings editor to add, edit and remove mappings.
 */
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ValueMappingsConfig } from '../../components/VisualizationConfigs/ValueMappingsConfig/ValueMappingsConfig';
import { renderWithMantine } from './fixtures';

const MAPPINGS = [
    {
        type: 'value' as const,
        options: { '0': { text: 'Down', color: '#F2495C', index: 0 } },
    },
];

describe('ValueMappingsConfig', () => {
    it('adds a value mapping', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithMantine(
            <ValueMappingsConfig mappings={[]} onChange={onChange} />,
        );
        await user.click(
            screen.getByRole('button', { name: /add value mapping/i }),
        );
        const next = onChange.mock.lastCall![0];
        expect(next).toHaveLength(1);
        expect(next[0].type).toBe('value');
    });

    it('edits the display text of a mapping', () => {
        const onChange = vi.fn();
        renderWithMantine(
            <ValueMappingsConfig mappings={MAPPINGS} onChange={onChange} />,
        );
        expect(screen.getByLabelText('Mapping 1 value')).toHaveValue('0');
        fireEvent.change(screen.getByLabelText('Mapping 1 display text'), {
            target: { value: 'Offline' },
        });
        const next = onChange.mock.lastCall![0];
        expect(next[0].options['0'].text).toBe('Offline');
    });

    it('removes a mapping', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        renderWithMantine(
            <ValueMappingsConfig mappings={MAPPINGS} onChange={onChange} />,
        );
        await user.click(screen.getByRole('button', { name: 'Remove mapping 1' }));
        expect(onChange.mock.lastCall![0]).toEqual([]);
    });
});
