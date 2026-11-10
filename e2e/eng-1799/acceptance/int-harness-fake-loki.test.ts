/* eslint-disable */
// @ts-nocheck
// int-harness-fake-loki: a fake Loki serves fixed synthetic log streams and metric series; the real
// engine's logql() and logql_metric() read them.
import { disposeAll, harness, iso, pgRun, T0, track, windowSql } from './support';

afterAll(disposeAll);

describe('int-harness-fake-loki', () => {
    it('logql() returns the fixture lines with their labels; logql_metric() returns the series', async () => {
        const h = await harness();
        const loki = track(
            await h.startFakeLoki({
                streams: [
                    {
                        labels: { app: 'refills-api', namespace: 'apps', level: 'error' },
                        lines: [
                            [iso(T0 + 60_000), 'synthetic failure one'],
                            [iso(T0 + 120_000), 'synthetic failure two'],
                        ],
                    },
                    { labels: { app: 'refills-api', namespace: 'apps', level: 'info' }, lines: [[iso(T0 + 30_000), 'synthetic ok']] },
                ],
                series: [{ labels: { app: 'refills-api' }, value: 0.5 }],
            }),
        );
        const engine = track(await h.startEngine({ loki }));

        const logs = await pgRun(engine, [
            `SELECT timestamp, line, label(labels, 'level') AS level, stream FROM logql('{app="refills-api"}', ${windowSql(5)}) ORDER BY timestamp`,
        ]);
        expect(logs.error).toBeUndefined();
        expect(logs.fields.map((f) => f.dataTypeID)).toEqual([1184, 25, 25, 25]);
        expect(logs.rows.map((r) => [new Date(r.timestamp).toISOString(), r.line, r.level])).toEqual([
            [iso(T0 + 30_000), 'synthetic ok', 'info'],
            [iso(T0 + 60_000), 'synthetic failure one', 'error'],
            [iso(T0 + 120_000), 'synthetic failure two', 'error'],
        ]);
        const call = loki.requests.find((r) => r.path === '/loki/api/v1/query_range' && r.params.query === '{app="refills-api"}');
        expect(call).toBeDefined();
        expect(call.params.limit).toBe('1000');
        expect(call.params.direction).toBe('backward');

        const metric = await pgRun(engine, [
            `SELECT value, series FROM logql_metric('sum by (app) (rate({app="refills-api"}[1m]))', ${windowSql(2)}, '1m')`,
        ]);
        expect(metric.error).toBeUndefined();
        expect(metric.rows).toHaveLength(3);
        expect(metric.rows.every((r) => r.value === 0.5 && r.series === '{app="refills-api"}')).toBe(true);
    });
});
