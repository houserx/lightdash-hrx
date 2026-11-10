import { alertLabelsFingerprint, splitAlertSeries } from './series';

describe('splitAlertSeries', () => {
    it('gives one series per distinct non-value, non-time column set', () => {
        const series = splitAlertSeries([
            { time: 't1', job_name: 'a', env: 'prod', value: 1 },
            { time: 't1', job_name: 'b', env: 'prod', value: '5' },
            { time: 't2', job_name: 'a', env: 'prod', value: 2 },
            { time: 't2', job_name: 'b', env: 'prod', value: null },
        ]);
        expect(series).toEqual([
            {
                labels: { job_name: 'a', env: 'prod' },
                fingerprint: alertLabelsFingerprint({
                    env: 'prod',
                    job_name: 'a',
                }),
                values: [1, 2],
                timestamps: ['t1', 't2'],
            },
            {
                labels: { job_name: 'b', env: 'prod' },
                fingerprint: alertLabelsFingerprint({
                    env: 'prod',
                    job_name: 'b',
                }),
                values: [5, null],
                timestamps: ['t1', 't2'],
            },
        ]);
    });

    it('treats Date columns as time and gives one unlabelled series', () => {
        const at = new Date('2026-11-08T09:00:00Z');
        const series = splitAlertSeries([{ bucket: at, value: 3 }]);
        expect(series).toHaveLength(1);
        expect(series[0].labels).toEqual({});
        expect(series[0].timestamps).toEqual([at]);
    });

    it('uses the labels json column and ignores the series text', () => {
        const series = splitAlertSeries([
            {
                timestamp: 't1',
                value: 0.5,
                labels: '{"pod":"api-1"}',
                series: '{pod="api-1"}',
            },
            {
                timestamp: 't2',
                value: 0.7,
                labels: { pod: 'api-1' },
                series: 'whatever',
            },
        ]);
        expect(series).toHaveLength(1);
        expect(series[0].labels).toEqual({ pod: 'api-1' });
        expect(series[0].values).toEqual([0.5, 0.7]);
    });

    it('rejects a labels column that is not a json object', () => {
        expect(() =>
            splitAlertSeries([{ timestamp: 't', value: 1, labels: '[1]' }]),
        ).toThrow();
    });

    it('honours valueColumn and drops null labels', () => {
        expect(
            splitAlertSeries([{ queue: 'fills', shard: null, depth: 12 }], {
                valueColumn: 'depth',
            }),
        ).toEqual([
            expect.objectContaining({
                labels: { queue: 'fills' },
                values: [12],
            }),
        ]);
        expect(splitAlertSeries([])).toEqual([]);
    });
});

describe('alertLabelsFingerprint', () => {
    it('is 16 hex chars, order-independent and separator-safe', () => {
        const fp = alertLabelsFingerprint({ a: '1', b: '2' });
        expect(fp).toMatch(/^[0-9a-f]{16}$/);
        expect(alertLabelsFingerprint({ b: '2', a: '1' })).toBe(fp);
        expect(alertLabelsFingerprint({ a: 'bc' })).not.toBe(
            alertLabelsFingerprint({ ab: 'c' }),
        );
    });

    it('matches the 64-bit FNV-1a offset basis for no labels', () => {
        expect(alertLabelsFingerprint({})).toBe('cbf29ce484222325');
    });
});
