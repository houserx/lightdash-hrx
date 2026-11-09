/* eslint-disable */
// @ts-nocheck
// int-client-log-trace-functions: through FederationWarehouseClient.runQuery, logql(),
// cloudwatch_logs(), traceql() and trace() return their §1.1 columns with Lightdash types.
import { syntheticTrace, TRACE_ID } from './fixtures';
import { disposeAll, federationCredentials, harness, iso, load, T0, track, windowSql } from './support';

afterAll(disposeAll);

describe('int-client-log-trace-functions', () => {
    it('reads logs and traces through the Lightdash client', async () => {
        const h = await harness();
        const loki = track(await h.startFakeLoki({ streams: [{ labels: { app: 'worker', level: 'warn' }, lines: [[iso(T0 + 5_000), 'synthetic retry']] }] }));
        const cwLogs = track(await h.startFakeCloudWatchLogs({ results: [{ '@timestamp': '2026-11-08 10:00:10.000', '@message': 'synthetic lambda line', '@ptr': 'p' }] }));
        const tempo = track(await h.startFakeTempo({ traces: [syntheticTrace] }));
        const engine = track(await h.startEngine({ loki, cloudwatchLogs: cwLogs, tempo }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine));

        const logs = await client.runQuery(`SELECT timestamp, line, labels, stream FROM logql('{app="worker"}', ${windowSql(1)}, 100, 'forward')`);
        expect(Object.keys(logs.fields)).toEqual(['timestamp', 'line', 'labels', 'stream']);
        expect(logs.fields.timestamp.type).toBe('timestamp');
        expect(logs.rows.map((r) => r.line)).toEqual(['synthetic retry']);
        const call = loki.requests.find((r) => r.path === '/loki/api/v1/query_range');
        expect(call.params.limit).toBe('100');
        expect(call.params.direction).toBe('forward');

        const lambda = await client.runQuery(`SELECT timestamp, message, fields FROM cloudwatch_logs('/aws/lambda/synthetic', 'fields @timestamp, @message', ${windowSql(1)})`);
        expect(lambda.rows.map((r) => r.message)).toEqual(['synthetic lambda line']);
        expect(lambda.fields.timestamp.type).toBe('timestamp');

        const traces = await client.runQuery(`SELECT trace_id, root_service, duration_ms, span_count FROM traceql('{}', ${windowSql(5)}, 5)`);
        expect(traces.rows.map((r) => r.trace_id)).toEqual([TRACE_ID]);
        expect(traces.fields.duration_ms.type).toBe('number');
        expect(traces.fields.span_count.type).toBe('number');
        const search = tempo.requests.find((r) => r.path === '/api/search');
        expect(search.params.limit).toBe('5');

        const spans = await client.runQuery(`SELECT span_id, service, status, attributes FROM trace('${TRACE_ID}') ORDER BY start`);
        expect(spans.rows.map((r) => r.service)).toEqual(['refills-api', 'pharmacy-db']);
        const attrs = typeof spans.rows[1].attributes === 'string' ? JSON.parse(spans.rows[1].attributes) : spans.rows[1].attributes;
        expect(attrs['db.system']).toBe('postgresql');
    });
});
