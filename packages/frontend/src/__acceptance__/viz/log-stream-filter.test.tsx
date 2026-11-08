/**
 * Feature viz-log-stream-filter: a filter box narrows the loaded lines
 * (case-insensitive text match) and the count says how many match.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LogStreamView } from '../../components/LogStream/LogStreamView';
import { FIVE_LOGS, LOG_FIELD_IDS, logStreamModel, renderWithMantine } from './fixtures';

describe('LogStreamView filter box', () => {
    it('filters lines as the user types and restores them when cleared', async () => {
        const user = userEvent.setup();
        const model = logStreamModel(FIVE_LOGS, LOG_FIELD_IDS);
        renderWithMantine(<LogStreamView model={model} height={600} />);
        const box = screen.getByRole('textbox', { name: /filter/i });

        await user.type(box, 'timeout');
        expect(screen.getAllByTestId('log-stream-row')).toHaveLength(2);
        expect(screen.getByText(/2 of 5 lines/)).toBeInTheDocument();
        expect(screen.queryByText('disk usage at 97%')).toBeNull();

        await user.clear(box);
        expect(screen.getAllByTestId('log-stream-row')).toHaveLength(5);
        expect(screen.getByText(/5 of 5 lines/)).toBeInTheDocument();
    });

    it('shows a no-match message', async () => {
        const user = userEvent.setup();
        const model = logStreamModel(FIVE_LOGS, LOG_FIELD_IDS);
        renderWithMantine(<LogStreamView model={model} height={600} />);
        await user.type(
            screen.getByRole('textbox', { name: /filter/i }),
            'zzz-not-there',
        );
        expect(screen.queryAllByTestId('log-stream-row')).toHaveLength(0);
        expect(screen.getByText(/0 of 5 lines/)).toBeInTheDocument();
    });
});
