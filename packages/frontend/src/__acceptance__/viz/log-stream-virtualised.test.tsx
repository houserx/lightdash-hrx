/**
 * Feature viz-log-stream-virtualised: 5,000 lines render without putting
 * 5,000 rows in the DOM; only the visible window (plus overscan) is drawn.
 * jsdom has no layout, so the view sizes itself from its `height` prop.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogStreamView } from '../../components/LogStream/LogStreamView';
import { LOG_FIELD_IDS, logStreamModel, manyLogs, renderWithMantine } from './fixtures';

describe('LogStreamView virtualisation', () => {
    it('draws a window of rows for 5,000 lines', () => {
        const model = logStreamModel(manyLogs(5000), LOG_FIELD_IDS);
        expect(model.lines).toHaveLength(5000);
        const started = performance.now();
        renderWithMantine(<LogStreamView model={model} height={400} />);
        const elapsed = performance.now() - started;
        const rows = screen.getAllByTestId('log-stream-row');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThanOrEqual(200);
        // newest first: line 5000 is on top, line 1 is far below the window
        expect(screen.getByText('synthetic line number 5000')).toBeInTheDocument();
        expect(screen.queryByText('synthetic line number 1')).toBeNull();
        expect(screen.getByText(/5,?000 of 5,?000 lines/)).toBeInTheDocument();
        expect(elapsed).toBeLessThan(5000);
    });
});
