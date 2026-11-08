/**
 * Feature viz-log-stream-wrap-lines: "wrap lines" wraps long lines; off
 * (the default) keeps each line on one row.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogStreamView } from '../../components/LogStream/LogStreamView';
import { FIVE_LOGS, LOG_FIELD_IDS, logStreamModel, renderWithMantine } from './fixtures';

describe('LogStreamView line wrapping', () => {
    it('wraps when on', () => {
        const model = logStreamModel(FIVE_LOGS, {
            ...LOG_FIELD_IDS,
            wrapLines: true,
        });
        renderWithMantine(<LogStreamView model={model} height={600} />);
        for (const line of screen.getAllByTestId('log-stream-line')) {
            expect(line).toHaveStyle({ whiteSpace: 'pre-wrap' });
        }
    });

    it('keeps one row per line when off', () => {
        const model = logStreamModel(FIVE_LOGS, LOG_FIELD_IDS);
        renderWithMantine(<LogStreamView model={model} height={600} />);
        for (const line of screen.getAllByTestId('log-stream-line')) {
            expect(['pre', 'nowrap']).toContain(line.style.whiteSpace);
        }
    });
});
