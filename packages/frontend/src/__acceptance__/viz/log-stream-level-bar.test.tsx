/**
 * Feature viz-log-stream-level-bar: each row has a colour bar for its
 * level, using the Grafana default colours or the chart's overrides.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogStreamView } from '../../components/LogStream/LogStreamView';
import { FIVE_LOGS, LOG_FIELD_IDS, logStreamModel, renderWithMantine } from './fixtures';

describe('LogStreamView level colour bar', () => {
    it('colours each row by level', () => {
        const model = logStreamModel(FIVE_LOGS, {
            ...LOG_FIELD_IDS,
            newestFirst: false,
        });
        renderWithMantine(<LogStreamView model={model} height={600} />);
        const rows = screen.getAllByTestId('log-stream-row');
        const expected = [
            ['info', '#7eb26d'],
            ['error', '#e24d42'],
            ['debug', '#1f78c1'],
            ['warning', '#eab839'],
            ['critical', '#705da0'],
        ];
        rows.forEach((row, i) => {
            expect(row).toHaveAttribute('data-level', expected[i][0]);
            expect(within(row).getByTestId('log-stream-level-bar')).toHaveStyle({
                backgroundColor: expected[i][1],
            });
        });
    });

    it('uses a level colour override', () => {
        const model = logStreamModel(FIVE_LOGS, {
            ...LOG_FIELD_IDS,
            levelColors: { error: '#000000' },
        });
        renderWithMantine(<LogStreamView model={model} height={600} />);
        const errorRow = screen
            .getAllByTestId('log-stream-row')
            .find((row) => row.getAttribute('data-level') === 'error')!;
        expect(within(errorRow).getByTestId('log-stream-level-bar')).toHaveStyle({
            backgroundColor: '#000000',
        });
    });
});
