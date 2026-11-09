/* eslint-disable */
// @ts-nocheck
// int-harness-fake-cloudwatch-logs: a fake CloudWatch Logs Insights (StartQuery / GetQueryResults)
// serves fixed synthetic results; the real engine's cloudwatch_logs() reads them.
import { disposeAll, harness, iso, pgRun, T0, track, windowSql } from './support';

afterAll(disposeAll);

describe('int-harness-fake-cloudwatch-logs', () => {
    it('cloudwatch_logs() returns timestamp, message and the other fields', async () => {
        const h = await harness();
        const logs = track(
            await h.startFakeCloudWatchLogs({
                results: [
                    { '@timestamp': '2026-11-08 10:01:00.000', '@message': 'synthetic request done', status: '200', '@ptr': 'ptr-1' },
                    { '@timestamp': '2026-11-08 10:02:00.000', '@message': 'synthetic request failed', status: '500', '@ptr': 'ptr-2' },
                ],
            }),
        );
        const engine = track(await h.startEngine({ cloudwatchLogs: logs }));
        const result = await pgRun(engine, [
            `SELECT timestamp, message, fields FROM cloudwatch_logs('/synthetic/app, /synthetic/worker', 'fields @timestamp, @message, status | sort @timestamp asc', ${windowSql(5)}) ORDER BY timestamp`,
        ]);
        expect(result.error).toBeUndefined();
        expect(result.fields.map((f) => [f.name, f.dataTypeID])).toEqual([
            ['timestamp', 1184],
            ['message', 25],
            ['fields', 114],
        ]);
        expect(result.rows.map((r) => [new Date(r.timestamp).toISOString(), r.message])).toEqual([
            [iso(T0 + 60_000), 'synthetic request done'],
            [iso(T0 + 120_000), 'synthetic request failed'],
        ]);
        expect(result.rows[1].fields.status).toBe('500');
        expect(result.rows[1].fields['@ptr']).toBeUndefined();

        const started = logs.startQueries();
        expect(started).toHaveLength(1);
        expect(started[0].logGroupNames).toEqual(['/synthetic/app', '/synthetic/worker']);
        expect(started[0].queryString).toContain('fields @timestamp');
        expect(started[0].startTime).toBe(T0 / 1000);
        expect(started[0].endTime).toBe(T0 / 1000 + 300);
    });
});
