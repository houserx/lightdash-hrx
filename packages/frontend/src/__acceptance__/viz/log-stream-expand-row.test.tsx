/**
 * Feature viz-log-stream-expand-row: clicking a line expands it to show
 * every label (key and value); clicking again collapses it.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LogStreamView } from '../../components/LogStream/LogStreamView';
import { FIVE_LOGS, LOG_FIELD_IDS, logStreamModel, renderWithMantine } from './fixtures';

describe('LogStreamView expandable row', () => {
    it('shows every label of the clicked line and hides them again', async () => {
        const user = userEvent.setup();
        const model = logStreamModel(FIVE_LOGS, {
            ...LOG_FIELD_IDS,
            newestFirst: false,
        });
        renderWithMantine(<LogStreamView model={model} height={600} />);
        expect(screen.queryByTestId('log-stream-details')).toBeNull();

        await user.click(screen.getByText('upstream request timeout after 30s'));
        const details = screen.getByTestId('log-stream-details');
        for (const [key, value] of [
            ['app', 'api'],
            ['namespace', 'synthetic'],
            ['pod', 'api-2'],
        ]) {
            expect(within(details).getByText(key)).toBeInTheDocument();
            expect(within(details).getByText(value)).toBeInTheDocument();
        }
        expect(screen.getAllByTestId('log-stream-details')).toHaveLength(1);

        await user.click(screen.getByText('upstream request timeout after 30s'));
        expect(screen.queryByTestId('log-stream-details')).toBeNull();
    });
});
