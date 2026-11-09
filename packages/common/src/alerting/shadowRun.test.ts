import { describe, expect, it } from 'vitest';
import { ParameterError } from '../types/errors';
import { compareShadowRun, parseGrafanaStateHistory } from './shadowRun';

const frame = (
    rows: Array<[number | string, unknown]>,
): Record<string, unknown> => ({
    schema: {
        fields: [
            { name: 'time', type: 'time' },
            { name: 'line', type: 'other' },
            { name: 'labels', type: 'other' },
        ],
    },
    data: {
        values: [
            rows.map(([time]) => time),
            rows.map(([, line]) => line),
            rows.map(() => ({})),
        ],
    },
});
const line = (ruleTitle: string, current: string, labels = {}) => ({
    schemaVersion: 1,
    previous: 'Normal',
    current,
    ruleTitle,
    labels,
});
const ms = (iso: string) => Date.parse(iso);

describe('parseGrafanaStateHistory', () => {
    it('keeps only transitions into Alerting, with their labels', () => {
        const firings = parseGrafanaStateHistory(
            frame([
                [ms('2026-11-08T09:00:00Z'), line('A', 'Alerting', { x: '1' })],
                [ms('2026-11-08T09:01:00Z'), line('A', 'Normal')],
                [ms('2026-11-08T09:02:00Z'), line('B', 'Pending')],
                [
                    '2026-11-08T09:03:00Z',
                    JSON.stringify(line('B', 'Alerting (Error)')),
                ],
            ]),
        );
        expect(firings).toEqual([
            {
                ruleName: 'A',
                at: ms('2026-11-08T09:00:00Z'),
                labels: { x: '1' },
            },
            { ruleName: 'B', at: ms('2026-11-08T09:03:00Z'), labels: {} },
        ]);
    });

    it.each([
        ['not a frame', 'nope'],
        ['no line column', { schema: { fields: [] }, data: { values: [] } }],
        ['line without ruleTitle', frame([[0, { current: 'Alerting' }]])],
        ['bad time', frame([['yesterday', line('A', 'Alerting')]])],
        [
            'columns of different lengths',
            {
                schema: { fields: [{ name: 'time' }, { name: 'line' }] },
                data: { values: [[1, 2], [line('A', 'Alerting')]] },
            },
        ],
    ])('rejects %s with a ParameterError', (_name, input) => {
        expect(() => parseGrafanaStateHistory(input)).toThrow(ParameterError);
    });
});

describe('compareShadowRun', () => {
    const grafanaHistory = frame([
        [ms('2026-11-08T09:00:00Z'), line('A', 'Alerting')],
        [ms('2026-11-08T09:08:00Z'), line('A', 'Alerting')],
    ]);

    it('matches one-to-one, the earliest shadow firing first', () => {
        const report = compareShadowRun({
            since: '2026-11-08T00:00:00Z',
            shadow: [
                {
                    ruleName: 'A',
                    labels: {},
                    status: 'firing',
                    at: '2026-11-08T09:04:00Z',
                },
                {
                    ruleName: 'A',
                    labels: {},
                    status: 'firing',
                    at: '2026-11-08T09:02:00Z',
                },
                {
                    ruleName: 'A',
                    labels: {},
                    status: 'resolved',
                    at: '2026-11-08T09:05:00Z',
                },
            ],
            grafanaHistory,
            expectedDifferences: [],
        });
        expect(report.matched).toEqual([
            expect.objectContaining({
                at: '2026-11-08T09:00:00.000Z',
                lightdashAt: '2026-11-08T09:02:00.000Z',
                deltaMs: 120_000,
            }),
            expect.objectContaining({
                at: '2026-11-08T09:08:00.000Z',
                lightdashAt: '2026-11-08T09:04:00.000Z',
                deltaMs: -240_000,
            }),
        ]);
        expect(report.missingInLightdash).toEqual([]);
        expect(report.extraInLightdash).toEqual([]);
        expect(report.unexpectedCount).toBe(0);
    });

    it('does not match across rule names and ignores events before since', () => {
        const report = compareShadowRun({
            since: '2026-11-08T09:05:00Z',
            shadow: [
                {
                    ruleName: 'B',
                    labels: { y: '2' },
                    status: 'firing',
                    at: '2026-11-08T09:10:00Z',
                },
                {
                    ruleName: 'A',
                    labels: {},
                    status: 'firing',
                    at: '2026-11-08T09:00:00Z',
                },
            ],
            grafanaHistory,
            expectedDifferences: [
                {
                    ruleName: 'B',
                    kind: 'missing_in_lightdash',
                    reason: 'wrong kind',
                },
            ],
        });
        expect(report.matched).toEqual([]);
        expect(report.missingInLightdash).toEqual([
            {
                ruleName: 'A',
                at: '2026-11-08T09:08:00.000Z',
                labels: {},
                expected: false,
            },
        ]);
        expect(report.extraInLightdash).toEqual([
            {
                ruleName: 'B',
                at: '2026-11-08T09:10:00.000Z',
                labels: { y: '2' },
                expected: false,
            },
        ]);
        expect(report.unexpectedCount).toBe(2);
    });

    it('rejects an invalid since', () => {
        expect(() =>
            compareShadowRun({
                since: 'last week',
                shadow: [],
                grafanaHistory,
                expectedDifferences: [],
            }),
        ).toThrow(ParameterError);
    });
});
