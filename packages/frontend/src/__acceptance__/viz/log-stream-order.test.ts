/**
 * Feature viz-log-stream-order: lines are ordered by timestamp, newest
 * first by default (Grafana's "Descending"), oldest first when the chart
 * turns newest-first off, whatever order the query returned.
 */
import { describe, expect, it } from 'vitest';
import { FIVE_LOGS, LOG_FIELD_IDS, logStreamModel } from './fixtures';

const shuffled = [FIVE_LOGS[2], FIVE_LOGS[0], FIVE_LOGS[4], FIVE_LOGS[1], FIVE_LOGS[3]];
const times = (model: { lines: { timestamp: string }[] }) =>
    model.lines.map((l) => new Date(l.timestamp).toISOString().slice(17, 19));

describe('log stream order', () => {
    it('puts the newest line first by default', () => {
        expect(times(logStreamModel(shuffled, LOG_FIELD_IDS))).toEqual([
            '05',
            '04',
            '03',
            '02',
            '01',
        ]);
    });

    it('puts the oldest line first when newestFirst is off', () => {
        expect(
            times(
                logStreamModel(shuffled, {
                    ...LOG_FIELD_IDS,
                    newestFirst: false,
                }),
            ),
        ).toEqual(['01', '02', '03', '04', '05']);
    });

    it('keeps query order for lines with the same timestamp', () => {
        const same = [
            { ts: '2026-11-08T10:00:00.000Z', line: 'first', level: 'info' },
            { ts: '2026-11-08T10:00:00.000Z', line: 'second', level: 'info' },
        ];
        const model = logStreamModel(same, {
            ...LOG_FIELD_IDS,
            newestFirst: false,
        });
        expect(model.lines.map((l: { line: string }) => l.line)).toEqual([
            'first',
            'second',
        ]);
    });
});
