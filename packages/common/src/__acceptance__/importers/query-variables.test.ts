/* eslint-disable */
// @ts-nocheck
// imp-query-variables: dashboard variables referenced in a query ($var, ${var}, [[var]])
// become Lightdash parameters (`${ld.parameters.<var>}`); constants are inlined; datasource
// variables resolve to the one Telemetry Source they pick.
import {
    CW,
    DATASOURCES,
    LOKI,
    PROM,
    codes,
    loadGrafanaQuery,
    onlyCall,
    parameterRefs,
} from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

const variables = [
    {
        type: 'custom',
        name: 'env',
        query: 'prod,staging',
        current: { text: 'prod', value: 'prod' },
        options: [
            { text: 'prod', value: 'prod', selected: true },
            { text: 'staging', value: 'staging', selected: false },
        ],
    },
    { type: 'constant', name: 'cluster', query: 'prod-eks', hide: 2 },
    {
        type: 'query',
        name: 'pod',
        datasource: PROM,
        query: 'label_values(kube_pod_info, pod)',
        multi: true,
        includeAll: true,
        current: { text: 'All', value: '$__all' },
    },
    { type: 'textbox', name: 'search', query: 'timeout', current: { text: 'timeout', value: 'timeout' } },
    {
        type: 'interval',
        name: 'agg',
        auto: true,
        query: '1m,5m,1h',
        current: { text: '5m', value: '5m' },
        options: [
            { text: 'auto', value: '$__auto_interval_agg' },
            { text: '1m', value: '1m' },
            { text: '5m', value: '5m' },
            { text: '1h', value: '1h' },
        ],
    },
    {
        type: 'datasource',
        name: 'datasource',
        query: 'cloudwatch',
        current: { text: 'Cloudwatch Staging', value: 'uHbTebEVk' },
    },
];
const ctx = { datasources: DATASOURCES, variables };

describe('variables in queries', () => {
    it('turns $var, ${var} and [[var]] into the same parameter', () => {
        for (const expr of ['up{env="$env"}', 'up{env="${env}"}', 'up{env="[[env]]"}']) {
            const result = q.translateGrafanaTarget({ refId: 'A', datasource: PROM, expr }, ctx);
            expect(result.todo).toBeNull();
            expect(parameterRefs(result.sql)).toContain('env');
            expect(onlyCall(result.sql, 'promql', { env: 'staging' }).args[0]).toBe('up{env="staging"}');
        }
    });

    it('inlines constants', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: PROM, expr: 'up{cluster="$cluster", env="$env"}' },
            ctx,
        );
        expect(parameterRefs(result.sql)).not.toContain('cluster');
        expect(onlyCall(result.sql, 'promql', { env: 'prod' }).args[0]).toBe(
            'up{cluster="prod-eks", env="prod"}',
        );
    });

    it('uses textbox and query variables as parameters', () => {
        const logs = q.translateGrafanaTarget(
            { refId: 'A', datasource: LOKI, expr: '{app="api"} |= "$search"' },
            ctx,
        );
        expect(onlyCall(logs.sql, 'logql', { search: 'refused' }).args[0]).toBe('{app="api"} |= "refused"');
        const pods = q.translateGrafanaTarget(
            { refId: 'A', datasource: PROM, expr: 'sum by (pod) (rate(restarts{pod=~"$pod"}[5m]))' },
            ctx,
        );
        expect(parameterRefs(pods.sql)).toContain('pod');
        // A multi-value or All variable becomes a single-value parameter, with a warning.
        expect(codes(pods.warnings)).toContain('variable-multi-value');
    });

    it('uses an interval variable as a step', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: PROM, expr: 'sum(rate(x[$agg]))' },
            ctx,
        );
        const inner = onlyCall(result.sql, 'promql', { agg: '1h' }).args[0];
        expect(['sum(rate(x[1h]))', 'sum(rate(x[1m]))']).toContain(inner);
        expect(inner).not.toContain('$');
    });

    it('resolves a datasource variable to the Telemetry Source it picks', () => {
        const result = q.translateGrafanaTarget(
            {
                refId: 'A',
                datasource: { type: 'cloudwatch', uid: '${datasource}' },
                queryMode: 'Metrics',
                namespace: 'AWS/SQS',
                metricName: 'ApproximateNumberOfMessagesVisible',
                dimensions: { QueueName: 'fills' },
                statistic: 'Maximum',
                period: '300',
            },
            ctx,
        );
        expect(parameterRefs(result.sql)).not.toContain('datasource');
        expect(onlyCall(result.sql, 'cloudwatch').args[3]).toBe('cloudwatch-staging');
    });

    it('warns about a variable the dashboard does not define', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: PROM, expr: 'up{job="$nope"}' },
            ctx,
        );
        expect(result.warnings.map((w) => w.message).join(' ')).toContain('nope');
    });
});
