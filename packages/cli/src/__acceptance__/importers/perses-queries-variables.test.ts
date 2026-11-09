/* eslint-disable */
// @ts-nocheck
// imp-perses-queries-variables: PrometheusTimeSeriesQuery queries become promql() SQL through
// the same query translation, Perses variables (ListVariable with label-values or static
// options, TextVariable) become Lightdash parameters, and duration/refreshInterval become the
// Dashboard Time Range.
import path from 'node:path';
import { PERSES, calls, importPerses, isTimeRangeAware, parameterRefs, validateProjectConfig } from './support';

let run: any;
let latency: any;
beforeAll(async () => {
    run = await importPerses([path.join(PERSES, 'node-overview.yaml')]);
    latency = await importPerses([path.join(PERSES, 'api-latency.json')]);
});
afterAll(async () => {
    await run?.cleanup();
    await latency?.cleanup();
});

const chart = (r, name) => r.charts().find((c) => c.doc.name === name).doc;

describe('Perses queries and variables', () => {
    it('translates Prometheus queries with variables and macros', () => {
        const cpu = chart(run, 'CPU usage');
        expect(isTimeRangeAware(cpu.sql)).toBe(true);
        expect(parameterRefs(cpu.sql)).toEqual(expect.arrayContaining(['job', 'env']));
        const call = calls(cpu.sql, 'promql', { job: 'node', env: 'staging' })[0];
        expect(call.args[0]).toBe('sum by (mode) (rate(node_cpu_seconds_total{job="node", env="staging", mode!="idle"}[1m]))');
        expect(call.args[4]).toBe('prometheus-production');
    });

    it('combines several queries in one panel', () => {
        const p = chart(latency, 'Request latency p50 and p99');
        expect(calls(p.sql, 'promql')).toHaveLength(2);
    });

    it('turns variables into parameters', () => {
        const config = run.projectConfig();
        expect(validateProjectConfig(config).valid).toBe(true);
        expect(config.parameters.env.options.map((o) => (typeof o === 'object' ? o.value : o))).toEqual(['prod', 'staging']);
        expect(config.parameters.job.allow_custom_values).toBe(true);
        expect(config.parameters.instance.allow_custom_values).toBe(true);
        const dashboard = run.dashboards()[0].doc;
        expect(dashboard.parameters.env.value).toBe('prod');
        expect(dashboard.parameters.job.value).toBe('node');
        expect(dashboard.parameters.instance.value).toBe('node-1');
    });

    it('maps duration and refresh to the Dashboard Time Range', () => {
        expect(run.dashboards()[0].doc.timeRange).toMatchObject({ from: 'now-6h', to: 'now', refreshInterval: '1m' });
        expect(latency.dashboards()[0].doc.timeRange).toMatchObject({ from: 'now-1h', to: 'now' });
    });
});
