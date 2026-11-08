/**
 * Feature viz-log-stream-show-labels: with "show labels" on, each line shows
 * its labels inline; with it off (the default) it doesn't.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogStreamView } from '../../components/LogStream/LogStreamView';
import { FIVE_LOGS, LOG_FIELD_IDS, logStreamModel, renderWithMantine } from './fixtures';

describe('LogStreamView inline labels', () => {
    it('shows key=value labels on every line when on', () => {
        const model = logStreamModel(FIVE_LOGS, {
            ...LOG_FIELD_IDS,
            showLabels: true,
            newestFirst: false,
        });
        renderWithMantine(<LogStreamView model={model} height={600} />);
        const rows = screen.getAllByTestId('log-stream-row');
        const labels = within(rows[2]).getByTestId('log-stream-labels');
        expect(labels.textContent).toContain('app=cache');
        expect(labels.textContent).toContain('pod=cache-1');
        expect(screen.getAllByTestId('log-stream-labels')).toHaveLength(5);
    });

    it('hides them when off', () => {
        const model = logStreamModel(FIVE_LOGS, LOG_FIELD_IDS);
        renderWithMantine(<LogStreamView model={model} height={600} />);
        expect(screen.queryAllByTestId('log-stream-labels')).toHaveLength(0);
    });
});
