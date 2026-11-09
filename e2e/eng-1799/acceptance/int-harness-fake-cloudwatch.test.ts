/* eslint-disable */
// @ts-nocheck
// int-harness-fake-cloudwatch: a fake CloudWatch (GetMetricData over the protocol the engine's AWS
// SDK speaks) serves fixed datapoints; the real engine's cloudwatch() reads them, signed with the
// fake AWS credentials and never leaving 127.0.0.1.
import { disposeAll, harness, iso, pgRun, T0, track, windowSql } from './support';

afterAll(disposeAll);

const grafanaTarget = {
    refId: 'A',
    id: '',
    namespace: 'AWS/RDS',
    metricName: 'CPUUtilization',
    dimensions: { DBInstanceIdentifier: 'synthetic-db-1' },
    statistic: 'Average',
    period: '300',
    metricEditorMode: 0,
    expression: '',
    label: 'cpu-synthetic-db-1',
    region: 'default',
};

describe('int-harness-fake-cloudwatch', () => {
    it('cloudwatch() over the fake returns its datapoints and the fake sees the MetricStat', async () => {
        const h = await harness();
        const cw = track(
            await h.startFakeCloudWatch({
                metrics: [{ label: 'cpu-synthetic-db-1', points: [[iso(T0), 41.5], [iso(T0 + 300_000), 43.25]] }],
            }),
        );
        const engine = track(await h.startEngine({ cloudwatch: cw }));
        const json = JSON.stringify(grafanaTarget).replaceAll("'", "''");
        const result = await pgRun(engine, [
            `SELECT timestamp, value, series FROM cloudwatch('${json}', ${windowSql(10)}) ORDER BY timestamp`,
        ]);
        expect(result.error).toBeUndefined();
        expect(result.fields.map((f) => f.dataTypeID)).toEqual([1184, 701, 25]);
        expect(result.rows.map((r) => [new Date(r.timestamp).toISOString(), r.value, r.series])).toEqual([
            [iso(T0), 41.5, 'cpu-synthetic-db-1'],
            [iso(T0 + 300_000), 43.25, 'cpu-synthetic-db-1'],
        ]);

        const queries = cw.metricDataQueries();
        expect(queries.length).toBeGreaterThanOrEqual(1);
        const q = queries[0];
        expect(q.MetricStat.Metric.Namespace).toBe('AWS/RDS');
        expect(q.MetricStat.Metric.MetricName).toBe('CPUUtilization');
        expect(q.MetricStat.Metric.Dimensions).toEqual([{ Name: 'DBInstanceIdentifier', Value: 'synthetic-db-1' }]);
        expect(q.MetricStat.Stat).toBe('Average');
        expect(Number(q.MetricStat.Period)).toBe(300);
        // Every request the engine sent was SigV4-signed with the harness's fake credentials.
        expect(cw.requests.length).toBeGreaterThan(0);
        expect(cw.requests.every((r) => /AWS4-HMAC-SHA256 Credential=AKID[A-Z0-9]*NOTREAL/i.test(r.headers.authorization ?? ''))).toBe(true);
    });
});
