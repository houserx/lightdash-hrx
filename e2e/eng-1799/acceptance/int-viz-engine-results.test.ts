/* eslint-disable */
// @ts-nocheck
// int-viz-engine-results: the viz line's chart types render what the engine really returns through
// the Lightdash client: a Log stream over logql() rows (level from labels) and over
// cloudwatch_logs() rows (message as the line), and a Trace waterfall over trace() rows (parent and
// child spans, offsets and durations, attributes parsed from json).
import { syntheticTrace, TRACE_ID } from './fixtures';
import { disposeAll, federationCredentials, harness, iso, load, T0, track, windowSql } from './support';

afterAll(disposeAll);

/** WarehouseResults -> the ChartData the frontend hands to @lightdash/visualization. */
const toChartData = (results: any) => ({
    fields: Object.fromEntries(Object.entries(results.fields).map(([name, f]: any) => [name, { fieldType: 'dimension', type: f.type, label: name }])),
    rows: results.rows.map((row: any) =>
        Object.fromEntries(
            Object.entries(row).map(([k, raw]: any) => [k, { value: { raw, formatted: raw === null ? '' : raw instanceof Date ? raw.toISOString() : typeof raw === 'object' ? JSON.stringify(raw) : String(raw) } }]),
        ),
    ),
});

describe('int-viz-engine-results', () => {
    it('renders log streams and trace waterfalls from engine results', async () => {
        const h = await harness();
        const loki = track(
            await h.startFakeLoki({
                streams: [
                    { labels: { app: 'api', level: 'error' }, lines: [[iso(T0 + 2_000), 'synthetic boom']] },
                    { labels: { app: 'api', detected_level: 'info' }, lines: [[iso(T0 + 1_000), 'synthetic fine']] },
                ],
            }),
        );
        const cwLogs = track(await h.startFakeCloudWatchLogs({ results: [{ '@timestamp': '2026-11-08 10:00:03.000', '@message': 'synthetic lambda line', '@ptr': 'p' }] }));
        const tempo = track(await h.startFakeTempo({ traces: [syntheticTrace] }));
        const engine = track(await h.startEngine({ loki, cloudwatchLogs: cwLogs, tempo }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const { renderChart } = await load('packages/visualization/src/render.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine));

        const logql = toChartData(await client.runQuery(`SELECT * FROM logql('{app="api"}', ${windowSql(1)})`));
        const logs = renderChart({ chartConfig: { type: 'log_stream', config: {} } }, logql);
        expect(logs.kind).toBe('logStream');
        const byLine = Object.fromEntries(logs.model.lines.map((l) => [l.line, l]));
        expect(byLine['synthetic boom'].level).toBe('error');
        expect(byLine['synthetic fine'].level).toBe('info');
        expect(byLine['synthetic boom'].timestamp).toBe(T0 + 2_000);
        expect(byLine['synthetic boom'].labels).toMatchObject({ app: 'api', level: 'error' });

        const cw = toChartData(await client.runQuery(`SELECT * FROM cloudwatch_logs('/aws/lambda/synthetic', 'fields @timestamp, @message', ${windowSql(1)})`));
        const cwRendered = renderChart({ chartConfig: { type: 'log_stream', config: {} } }, cw);
        expect(cwRendered.kind).toBe('logStream');
        expect(cwRendered.model.lines.map((l) => l.line)).toEqual(['synthetic lambda line']);
        expect(cwRendered.model.lines[0].timestamp).toBe(T0 + 3_000);

        const spans = toChartData(await client.runQuery(`SELECT * FROM trace('${TRACE_ID}')`));
        const waterfall = renderChart({ chartConfig: { type: 'trace_waterfall', config: {} } }, spans);
        expect(waterfall.kind).toBe('traceWaterfall');
        const [trace] = waterfall.model.traces;
        expect(trace.traceId).toBe(TRACE_ID);
        expect(trace.durationMs).toBe(120);
        const child = trace.spans.find((s) => s.service === 'pharmacy-db');
        expect(child.parentSpanId).toBe('b7ad6b7169203331');
        expect(child.depth).toBe(1);
        expect(child.offsetMs).toBe(10);
        expect(child.durationMs).toBe(80);
        expect(child.status).toBe('error');
        expect(child.attributes['db.system']).toBe('postgresql');
    });
});
