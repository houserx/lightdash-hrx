/**
 * Feature viz-log-stream-view: the log stream renderer shows one row per
 * line with its timestamp and text, in the model's order.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogStreamView } from '../../components/LogStream/LogStreamView';
import { FIVE_LOGS, LOG_FIELD_IDS, logStreamModel, renderWithMantine } from './fixtures';

describe('LogStreamView', () => {
    it('shows every line with a timestamp, newest first', () => {
        const model = logStreamModel(FIVE_LOGS, LOG_FIELD_IDS);
        renderWithMantine(<LogStreamView model={model} height={600} />);
        const rows = screen.getAllByTestId('log-stream-row');
        expect(rows).toHaveLength(5);
        expect(within(rows[0]).getByText('disk usage at 97%')).toBeInTheDocument();
        expect(
            within(rows[4]).getByText('GET /api/items 200 12ms'),
        ).toBeInTheDocument();
        for (const row of rows) {
            expect(
                within(row).getByTestId('log-stream-timestamp').textContent,
            ).not.toBe('');
        }
    });

    it('shows the line count', () => {
        const model = logStreamModel(FIVE_LOGS, LOG_FIELD_IDS);
        renderWithMantine(<LogStreamView model={model} height={600} />);
        expect(screen.getByText(/5 of 5 lines/)).toBeInTheDocument();
    });

    it('says so when there are no lines', () => {
        renderWithMantine(
            <LogStreamView
                model={{
                    lines: [],
                    wrapLines: false,
                    showLabels: false,
                    newestFirst: true,
                }}
                height={600}
            />,
        );
        expect(screen.getByText(/no log lines/i)).toBeInTheDocument();
    });
});
