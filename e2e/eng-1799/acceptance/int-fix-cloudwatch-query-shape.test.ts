/* eslint-disable */
// @ts-nocheck
// int-fix-cloudwatch-query-shape: every producer of a cloudwatch() metric_data_query is understood
// by the engine: Grafana's stored CloudWatch target (what CONTRACTS §1.1 names, and what ported
// Grafana panels and alerts carry), the query Investigate builds from its CloudWatch metrics form
// (buildCloudWatchMetricDataQuery + buildTelemetrySql), and the MetricDataQuery an MCP caller sends.
// Each reaches CloudWatch as the same MetricStat.
import { disposeAll, federationCredentials, harness, iso, load, T0, track, windowSql } from './support';

afterAll(disposeAll);

describe('int-fix-cloudwatch-query-shape', () => {
    it('Grafana targets and Investigate / MCP MetricDataQuery JSON all query CloudWatch', async () => {
        const h = await harness();
        const cw = track(await h.startFakeCloudWatch({ metrics: [{ label: 'cpu', points: [[iso(T0), 55]] }] }));
        const engine = track(await h.startEngine({ cloudwatch: cw }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const { buildTelemetrySql, buildCloudWatchMetricDataQuery } = await load('packages/common/src/utils/telemetrySql.ts');
        const { withTimeRangeParameters } = await load('packages/backend/src/services/AsyncQueryService/queryTimeRange.ts');
        const { safeReplaceParametersWithSqlBuilder } = await load('packages/backend/src/utils/QueryBuilder/parameters.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine));

        const form = { namespace: 'AWS/EC2', metricName: 'CPUUtilization', dimensions: { InstanceId: 'i-synthetic' }, stat: 'Average', period: 60 };
        const investigateSql = buildTelemetrySql({ kind: 'cloudwatch', metricDataQuery: buildCloudWatchMetricDataQuery(form) });
        const parameters = withTimeRangeParameters({}, { from: iso(T0), to: iso(T0 + 600_000) }, new Date(T0 + 600_000));
        const investigate = await client.runQuery(safeReplaceParametersWithSqlBuilder(investigateSql, parameters, client).replacedSql);
        expect(investigate.rows.map((r) => r.value)).toEqual([55]);

        const grafana = JSON.stringify({ refId: 'A', namespace: 'AWS/EC2', metricName: 'CPUUtilization', dimensions: { InstanceId: 'i-synthetic' }, statistic: 'Average', period: '60', metricEditorMode: 0, expression: '', label: 'cpu', region: 'default' });
        const fromGrafana = await client.runQuery(`SELECT value FROM cloudwatch('${grafana}', ${windowSql(10)})`);
        expect(fromGrafana.rows.map((r) => r.value)).toEqual([55]);

        const mcpShape = JSON.stringify({ Id: 'm1', MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: 'i-synthetic' }] }, Period: 60, Stat: 'Average' }, Label: 'cpu' });
        const fromMcp = await client.runQuery(`SELECT value, series FROM cloudwatch('${mcpShape}', ${windowSql(10)})`);
        expect(fromMcp.rows.map((r) => [r.value, r.series])).toEqual([[55, 'cpu']]);

        const stats = cw.metricDataQueries().map((q) => q.MetricStat);
        expect(stats).toHaveLength(3);
        for (const stat of stats) {
            expect(stat.Metric.Namespace).toBe('AWS/EC2');
            expect(stat.Metric.MetricName).toBe('CPUUtilization');
            expect(stat.Metric.Dimensions).toEqual([{ Name: 'InstanceId', Value: 'i-synthetic' }]);
            expect(stat.Stat).toBe('Average');
            expect(Number(stat.Period)).toBe(60);
        }
    });
});
