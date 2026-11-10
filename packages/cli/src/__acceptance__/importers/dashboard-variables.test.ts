/* eslint-disable */
// @ts-nocheck
// imp-dashboard-variables: dashboard variables (query, custom, interval, textbox) become
// Lightdash parameters, defined in lightdash.config.yml and set on the dashboard; constants are
// inlined and datasource variables pick the Telemetry Source.
import {
    calls,
    expectValidDashboard,
    grafanaDashboard,
    importGrafanaDashboards,
    panel,
    parameterRefs,
    promTarget,
    validateProjectConfig,
    CW_DS,
} from './support';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard(
            'With Variables',
            [
                panel('timeseries', 'Per env', { x: 0, y: 0, w: 12, h: 8 }, {
                    targets: [promTarget('sum(rate(http_requests_total{env="$env", cluster="$cluster", pod=~"$pod"}[$agg]))')],
                }),
                panel('timeseries', 'Queue', { x: 12, y: 0, w: 12, h: 8 }, {
                    datasource: { type: 'cloudwatch', uid: '${datasource}' },
                    targets: [
                        {
                            refId: 'A',
                            datasource: { type: 'cloudwatch', uid: '${datasource}' },
                            queryMode: 'Metrics',
                            namespace: 'AWS/SQS',
                            metricName: 'ApproximateNumberOfMessagesVisible',
                            dimensions: { QueueName: '$queue' },
                            statistic: 'Maximum',
                            period: '300',
                        },
                    ],
                }),
            ],
            {
                templating: {
                    list: [
                        {
                            type: 'custom', name: 'env', label: 'Environment', query: 'prod,staging',
                            current: { text: 'staging', value: 'staging' },
                            options: [{ text: 'prod', value: 'prod' }, { text: 'staging', value: 'staging' }],
                        },
                        { type: 'constant', name: 'cluster', query: 'prod-eks', hide: 2 },
                        {
                            type: 'query', name: 'pod', label: 'Pod', datasource: { type: 'prometheus', uid: 'tmTXpZC4k' },
                            query: 'label_values(kube_pod_info, pod)', current: { text: 'api-1', value: 'api-1' },
                        },
                        {
                            type: 'interval', name: 'agg', query: '1m,5m,1h', auto: false,
                            current: { text: '5m', value: '5m' },
                            options: [{ text: '1m', value: '1m' }, { text: '5m', value: '5m' }, { text: '1h', value: '1h' }],
                        },
                        { type: 'textbox', name: 'queue', label: 'Queue', query: 'fills', current: { text: 'fills', value: 'fills' } },
                        { type: 'datasource', name: 'datasource', query: 'cloudwatch', current: { text: 'Cloudwatch Staging', value: 'uHbTebEVk' } },
                    ],
                },
            },
        ),
    ]);
});
afterAll(() => run?.cleanup());

describe('variables', () => {
    it('defines a project parameter per variable, valid as lightdash.config.yml', () => {
        const config = run.projectConfig();
        const { valid, errors } = validateProjectConfig(config);
        expect(errors).toBe('');
        expect(valid).toBe(true);
        const params = config.parameters;
        expect(params.env).toMatchObject({ label: 'Environment' });
        expect(params.env.options.map((o) => (typeof o === 'object' ? o.value : o))).toEqual(['prod', 'staging']);
        expect(params.agg.options.map((o) => (typeof o === 'object' ? o.value : o))).toEqual(['1m', '5m', '1h']);
        expect(params.pod.allow_custom_values).toBe(true);
        expect(params.queue.allow_custom_values).toBe(true);
        expect(params.cluster).toBeUndefined();
        expect(params.datasource).toBeUndefined();
    });

    it('sets the variable defaults on the dashboard', () => {
        const dashboard = run.dashboards()[0].doc;
        expectValidDashboard(dashboard);
        expect(dashboard.parameters.env).toEqual({ parameterName: 'env', value: 'staging' });
        expect(dashboard.parameters.agg).toEqual({ parameterName: 'agg', value: '5m' });
        expect(dashboard.parameters.queue).toEqual({ parameterName: 'queue', value: 'fills' });
    });

    it('uses the parameters in the chart SQL', () => {
        const charts = run.charts().map((c) => c.doc);
        const perEnv = charts.find((c) => c.name === 'Per env');
        expect(parameterRefs(perEnv.sql)).toEqual(expect.arrayContaining(['env', 'pod', 'agg']));
        const query = calls(perEnv.sql, 'promql', { env: 'prod', pod: 'api-2', agg: '1h' })[0].args[0];
        expect(query).toBe('sum(rate(http_requests_total{env="prod", cluster="prod-eks", pod=~"api-2"}[1h]))');
        const queue = charts.find((c) => c.name === 'Queue');
        const call = calls(queue.sql, 'cloudwatch', { queue: 'refills' })[0];
        expect(JSON.parse(call.args[0]).MetricStat.Metric.Dimensions).toEqual([{ Name: 'QueueName', Value: 'refills' }]);
        expect(call.args[3]).toBe('cloudwatch-staging');
    });
});
