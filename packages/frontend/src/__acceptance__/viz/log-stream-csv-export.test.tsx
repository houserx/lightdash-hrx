/**
 * Feature viz-log-stream-csv-export: "Download CSV" on a log stream saves
 * the lines currently shown (after the filter, in display order) as CSV:
 * timestamp, level, line, labels (as JSON), correctly quoted.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogStreamView } from '../../components/LogStream/LogStreamView';
import { LOG_FIELD_IDS, logStreamModel, readBlob, renderWithMantine } from './fixtures';

const LOGS = [
    {
        ts: '2026-11-08T10:00:01.000Z',
        line: 'GET "/x", 500',
        level: 'error',
        labels: { app: 'api' },
    },
    {
        ts: '2026-11-08T10:00:02.000Z',
        line: 'plain line',
        level: 'info',
        labels: { app: 'web', pod: 'web-1' },
    },
    {
        ts: '2026-11-08T10:00:03.000Z',
        line: 'another plain line',
        level: 'debug',
        labels: {},
    },
];

describe('LogStreamView CSV export', () => {
    const original = URL.createObjectURL;
    afterEach(() => {
        URL.createObjectURL = original;
        vi.restoreAllMocks();
    });

    const capture = () => {
        const blobs: Blob[] = [];
        URL.createObjectURL = vi.fn((blob: Blob) => {
            blobs.push(blob);
            return 'blob:log-stream-csv';
        }) as unknown as typeof URL.createObjectURL;
        URL.revokeObjectURL = vi.fn();
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
            () => undefined,
        );
        return blobs;
    };

    it('downloads the shown lines as CSV', async () => {
        const user = userEvent.setup();
        const blobs = capture();
        const model = logStreamModel(LOGS, {
            ...LOG_FIELD_IDS,
            newestFirst: false,
        });
        renderWithMantine(<LogStreamView model={model} height={600} />);
        await user.click(screen.getByRole('button', { name: /download csv/i }));
        expect(blobs).toHaveLength(1);
        const text = (await readBlob(blobs[0])).replace(/^﻿/, '');
        const lines = text.trim().split(/\r?\n/);
        expect(lines[0]).toBe('timestamp,level,line,labels');
        expect(lines).toHaveLength(4);
        expect(lines[1]).toBe(
            '2026-11-08T10:00:01.000Z,error,"GET ""/x"", 500","{""app"":""api""}"',
        );
        expect(lines[2]).toContain('plain line');
        expect(lines[2]).toContain('""pod"":""web-1""');
    });

    it('exports only the lines the filter leaves', async () => {
        const user = userEvent.setup();
        const blobs = capture();
        const model = logStreamModel(LOGS, LOG_FIELD_IDS);
        renderWithMantine(<LogStreamView model={model} height={600} />);
        await user.type(screen.getByRole('textbox', { name: /filter/i }), 'plain');
        await user.click(screen.getByRole('button', { name: /download csv/i }));
        const text = (await readBlob(blobs[0])).replace(/^﻿/, '');
        const lines = text.trim().split(/\r?\n/);
        expect(lines).toHaveLength(3);
        expect(lines[1]).toContain('another plain line');
        expect(lines[2]).toContain(',plain line,');
    });
});
