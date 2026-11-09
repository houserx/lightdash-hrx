/* eslint-disable */
// @ts-nocheck
// int-mcp-telemetry-tools: every telemetry tool of the MCP server works end to end against the
// real engine and the fake sources: list_sources, query_promql, query_logql, query_cloudwatch,
// query_cloudwatch_logs, search_traces and get_trace. Each query runs on the engine with an MCP
// identity (iss telemetry-mcp, agent true).
import { OPS_MART_TABLES, syntheticTrace, TRACE_ID } from './fixtures';
import { disposeAll, harness, iso, mcpConnect, ORG_UUID, PROJECT_UUID, T0, track, USER_EMAIL, USER_UUID } from './support';

afterAll(disposeAll);

describe('int-mcp-telemetry-tools', () => {
    it('answers every telemetry tool from the real engine', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up', instance: 'db-1' }, value: 1 }] }));
        const loki = track(await h.startFakeLoki({ streams: [{ labels: { app: 'api' }, lines: [[iso(T0 + 1_000), 'synthetic hello']] }], series: [{ labels: { app: 'api' }, value: 3 }] }));
        const cw = track(await h.startFakeCloudWatch({ metrics: [{ label: 'cpu', points: [[iso(T0), 12]] }] }));
        const cwLogs = track(await h.startFakeCloudWatchLogs({ results: [{ '@timestamp': '2026-11-08 10:00:01.000', '@message': 'synthetic lambda', '@ptr': 'p' }] }));
        const tempo = track(await h.startFakeTempo({ traces: [syntheticTrace] }));
        const bigquery = track(await h.startFakeBigQuery({ tables: OPS_MART_TABLES }));
        const engine = track(await h.startEngine({ prometheus: prom, loki, cloudwatch: cw, cloudwatchLogs: cwLogs, tempo, bigquery }));
        const okta = track(await h.startFakeOkta());
        const lightdash = track(await h.startFakeLightdashApi({ projectUuid: PROJECT_UUID, organizationUuid: ORG_UUID, users: [{ userUuid: USER_UUID, email: USER_EMAIL, attributes: {} }] }));
        const mcp = track(await h.startTelemetryMcp({ engine, okta, lightdashUrl: lightdash.url, lightdashApiToken: lightdash.apiToken, projectUuid: PROJECT_UUID }));
        const s = await mcpConnect(mcp.url, await okta.mintAccessToken({ sub: 'okta-sub-1', email: USER_EMAIL }));
        const start = iso(T0);
        const end = iso(T0 + 120_000);

        const sources = await s.call('list_sources');
        expect(sources.isError, sources.text).toBe(false);
        expect(sources.structured.opsMarts).toEqual(['ops_marts.ops_marts.fills_hourly', 'ops_marts.ops_marts.queue_depth']);
        expect(sources.structured.sources.map((x) => x.name)).toEqual(expect.arrayContaining(['prometheus', 'loki', 'cloudwatch', 'cloudwatch-logs', 'tempo']));

        const promql = await s.call('query_promql', { query: 'up', start, end, step: '1m' });
        expect(promql.isError, promql.text).toBe(false);
        expect(promql.structured.columns).toEqual(['timestamp', 'value', 'labels', 'series']);
        expect(promql.structured.rowCount).toBe(3);

        const logs = await s.call('query_logql', { query: '{app="api"}', start, end });
        expect(logs.isError, logs.text).toBe(false);
        expect(logs.structured.rows.map((r) => r.line)).toEqual(['synthetic hello']);
        const logMetric = await s.call('query_logql', { query: 'sum(rate({app="api"}[1m]))', start, end, step: '1m' });
        expect(logMetric.isError, logMetric.text).toBe(false);
        expect(logMetric.structured.rowCount).toBe(3);

        const cloudwatch = await s.call('query_cloudwatch', {
            metric_data_query: { Id: 'm1', MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: 'i-synthetic' }] }, Period: 60, Stat: 'Average' }, Label: 'cpu' },
            start,
            end,
        });
        expect(cloudwatch.isError, cloudwatch.text).toBe(false);
        expect(cloudwatch.structured.rows.map((r) => r.value)).toEqual([12]);

        const lambda = await s.call('query_cloudwatch_logs', { log_groups: ['/aws/lambda/synthetic'], query: 'fields @timestamp, @message', start, end });
        expect(lambda.isError, lambda.text).toBe(false);
        expect(lambda.structured.rows.map((r) => r.message)).toEqual(['synthetic lambda']);

        const traces = await s.call('search_traces', { query: '{}', start, end: iso(T0 + 600_000) });
        expect(traces.isError, traces.text).toBe(false);
        expect(traces.structured.rows.map((r) => r.trace_id)).toEqual([TRACE_ID]);
        const trace = await s.call('get_trace', { trace_id: TRACE_ID });
        expect(trace.isError, trace.text).toBe(false);
        expect(trace.structured.rowCount).toBe(2);
        await s.close();
    });
});
