/* eslint-disable */
// @ts-nocheck
// int-harness-fake-prometheus: a fake Prometheus HTTP server on an ephemeral port serves fixed
// synthetic series, and the real engine's promql() / promql_instant() read them.
import { disposeAll, durationSeconds, harness, iso, pgRun, T0, track, windowSql } from './support';

afterAll(disposeAll);

describe('int-harness-fake-prometheus', () => {
    it('promql() over the fake returns the fixture series at every step', async () => {
        const h = await harness();
        const prom = track(
            await h.startFakePrometheus({
                series: [
                    { labels: { __name__: 'up', instance: 'db-1', job: 'node' }, value: 1 },
                    { labels: { __name__: 'up', instance: 'db-2', job: 'node' }, value: 0 },
                ],
            }),
        );
        expect(prom.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const engine = track(await h.startEngine({ prometheus: prom }));

        const result = await pgRun(engine, [
            `SELECT timestamp, value, labels, series FROM promql('up', ${windowSql(5)}, '1m') ORDER BY series, timestamp`,
        ]);
        expect(result.error).toBeUndefined();
        expect(result.fields.map((f) => [f.name, f.dataTypeID])).toEqual([
            ['timestamp', 1184],
            ['value', 701],
            ['labels', 114],
            ['series', 25],
        ]);
        // [T0, T0+5m] at 1m is 6 points per series, both ends included.
        expect(result.rows).toHaveLength(12);
        expect(result.rows[0].series).toBe('{__name__="up",instance="db-1",job="node"}');
        expect(result.rows[0].value).toBe(1);
        expect(new Date(result.rows[0].timestamp).toISOString()).toBe(iso(T0));
        expect(result.rows[11].value).toBe(0);

        const call = prom.requests.find((r) => r.path === '/api/v1/query_range');
        expect(call).toBeDefined();
        expect(call.params.query).toBe('up');
        expect(Number(call.params.start)).toBe(T0 / 1000);
        expect(Number(call.params.end)).toBe(T0 / 1000 + 300);
        expect(durationSeconds(call.params.step)).toBe(60);
    });

    it('setSeries changes what the next query sees, and promql_instant reads one point per series', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'load', host: 'a' }, value: 5 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const first = await pgRun(engine, [`SELECT value FROM promql_instant('load', '${iso(T0)}')`]);
        expect(first.error).toBeUndefined();
        expect(first.rows.map((r) => r.value)).toEqual([5]);

        prom.setSeries([
            { labels: { __name__: 'load', host: 'a' }, value: 7 },
            { labels: { __name__: 'load', host: 'b' }, value: 9 },
        ]);
        const second = await pgRun(engine, [`SELECT label(labels, 'host') AS host, value FROM promql_instant('load', '${iso(T0)}') ORDER BY host`]);
        expect(second.error).toBeUndefined();
        expect(second.rows).toEqual([
            { host: 'a', value: 7 },
            { host: 'b', value: 9 },
        ]);
        expect(prom.requests.some((r) => r.path === '/api/v1/query')).toBe(true);
    });
});
