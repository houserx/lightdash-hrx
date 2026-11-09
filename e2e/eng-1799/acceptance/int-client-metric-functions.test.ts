/* eslint-disable */
// @ts-nocheck
// int-client-metric-functions: through FederationWarehouseClient.runQuery, promql(),
// promql_instant(), logql_metric() and cloudwatch() return the §1.1 columns with Lightdash types,
// labels arrive as objects, and label() / series_name() work on top.
import { disposeAll, federationCredentials, harness, iso, load, T0, track, windowSql } from './support';

afterAll(disposeAll);

describe('int-client-metric-functions', () => {
    it('reads every metric table function with the right columns and types', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'http_requests', route: '/refills', code: '200' }, value: 4 }] }));
        const loki = track(await h.startFakeLoki({ streams: [], series: [{ labels: { app: 'refills-api' }, value: 2 }] }));
        const cw = track(await h.startFakeCloudWatch({ metrics: [{ label: 'queue-depth', points: [[iso(T0), 7]] }] }));
        const engine = track(await h.startEngine({ prometheus: prom, loki, cloudwatch: cw }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine));

        const metric = await client.runQuery(`SELECT timestamp, value, labels, series FROM promql('http_requests', ${windowSql(2)}, '1m')`);
        expect(Object.keys(metric.fields)).toEqual(['timestamp', 'value', 'labels', 'series']);
        expect(metric.fields.timestamp.type).toBe('timestamp');
        expect(metric.fields.value.type).toBe('number');
        expect(metric.fields.series.type).toBe('string');
        expect(metric.rows).toHaveLength(3);
        const labels = typeof metric.rows[0].labels === 'string' ? JSON.parse(metric.rows[0].labels) : metric.rows[0].labels;
        expect(labels).toEqual({ __name__: 'http_requests', route: '/refills', code: '200' });

        const helpers = await client.runQuery(
            `SELECT label(labels, 'route') AS route, label(labels, 'missing') AS missing, series_name(labels) AS name FROM promql_instant('http_requests', '${iso(T0)}')`,
        );
        expect(helpers.rows).toEqual([{ route: '/refills', missing: null, name: '{__name__="http_requests",code="200",route="/refills"}' }]);

        const logMetric = await client.runQuery(`SELECT value, series FROM logql_metric('sum(rate({app="refills-api"}[1m]))', ${windowSql(1)}, '1m')`);
        expect(logMetric.rows.map((r) => r.value)).toEqual([2, 2]);

        const target = JSON.stringify({ refId: 'A', namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible', dimensions: { QueueName: 'synthetic-queue' }, statistic: 'Maximum', period: '60', metricEditorMode: 0, expression: '', label: 'queue-depth', region: 'default' });
        const cloudwatch = await client.runQuery(`SELECT timestamp, value, series FROM cloudwatch('${target}', ${windowSql(5)})`);
        expect(cloudwatch.rows).toHaveLength(1);
        expect(cloudwatch.rows[0].value).toBe(7);
        expect(cloudwatch.rows[0].series).toBe('queue-depth');
    });
});
