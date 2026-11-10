/* eslint-disable */
// @ts-nocheck
// imp-query-cloudwatch-metric-stat: a Grafana CloudWatch metric target (namespace, metric,
// dimensions, statistic, period) becomes cloudwatch() with a MetricDataQuery JSON.
import {
    CW,
    DATASOURCES,
    isTimeRangeAware,
    loadGrafanaQuery,
    onlyCall,
    RESERVED,
} from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

const metricTarget = (extra = {}) => ({
    refId: 'A',
    datasource: CW,
    queryMode: 'Metrics',
    metricQueryType: 0,
    metricEditorMode: 0,
    namespace: 'AWS/ApplicationELB',
    metricName: 'UnHealthyHostCount',
    dimensions: { LoadBalancer: 'app/platform-prod/abc123', TargetGroup: 'targetgroup/api/def456' },
    statistic: 'Average',
    period: '300',
    region: 'default',
    matchExact: true,
    expression: '',
    id: '',
    label: '',
    ...extra,
});

describe('CloudWatch metric targets', () => {
    it('builds a MetricStat MetricDataQuery', () => {
        const result = q.translateGrafanaTarget(metricTarget(), {
            datasources: DATASOURCES,
        });
        expect(result.todo).toBeNull();
        expect(isTimeRangeAware(result.sql)).toBe(true);
        const call = onlyCall(result.sql, 'cloudwatch');
        const mdq = JSON.parse(call.args[0]);
        expect(mdq.Id).toMatch(/^[a-z][a-zA-Z0-9_]*$/);
        expect(mdq.MetricStat).toEqual({
            Metric: {
                Namespace: 'AWS/ApplicationELB',
                MetricName: 'UnHealthyHostCount',
                Dimensions: [
                    { Name: 'LoadBalancer', Value: 'app/platform-prod/abc123' },
                    { Name: 'TargetGroup', Value: 'targetgroup/api/def456' },
                ],
            },
            Period: 300,
            Stat: 'Average',
        });
        expect(mdq.Expression).toBeUndefined();
        expect(call.args[1]).toBe(RESERVED.__from);
        expect(call.args[2]).toBe(RESERVED.__to);
        expect(call.args[3]).toBe('cloudwatch-production');
    });

    it('reads periods written as seconds or durations', () => {
        for (const [period, seconds] of [
            ['60', 60],
            ['5m', 300],
            ['1h', 3600],
            ['86400', 86400],
        ]) {
            const result = q.translateGrafanaTarget(metricTarget({ period }), {
                datasources: DATASOURCES,
            });
            const mdq = JSON.parse(onlyCall(result.sql, 'cloudwatch').args[0]);
            expect(mdq.MetricStat.Period).toBe(seconds);
        }
    });

    it('keeps extended statistics such as p99', () => {
        const result = q.translateGrafanaTarget(
            metricTarget({ statistic: 'p99' }),
            { datasources: DATASOURCES },
        );
        const mdq = JSON.parse(onlyCall(result.sql, 'cloudwatch').args[0]);
        expect(mdq.MetricStat.Stat).toBe('p99');
    });

    it('keeps the alias or label as the MetricDataQuery Label', () => {
        const result = q.translateGrafanaTarget(
            metricTarget({ label: 'Unhealthy hosts' }),
            { datasources: DATASOURCES },
        );
        const mdq = JSON.parse(onlyCall(result.sql, 'cloudwatch').args[0]);
        expect(mdq.Label).toBe('Unhealthy hosts');
    });

    it('warns about what the MetricDataQuery cannot carry', () => {
        // A region other than the source's, a legacy statistics list with several entries and
        // a dimension wildcard each need a person to look; each one is a warning.
        const result = q.translateGrafanaTarget(
            metricTarget({
                region: 'us-west-2',
                statistics: ['Average', 'Maximum'],
                statistic: undefined,
                dimensions: { LoadBalancer: '*' },
                matchExact: false,
            }),
            { datasources: DATASOURCES },
        );
        expect(result.warnings.length).toBeGreaterThanOrEqual(3);
        const text = result.warnings.map((w) => w.message).join('\n');
        expect(text).toMatch(/us-west-2/);
        expect(text).toMatch(/Maximum/);
        expect(text).toMatch(/\*/);
    });
});
