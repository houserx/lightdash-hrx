/* eslint-disable */
// @ts-nocheck
// imp-query-cloudwatch-expressions: CloudWatch metric math (`expression` in code mode), the
// Metrics Insights query (metricQueryType 1, `sqlExpression`) and the references between a
// panel's CloudWatch targets become MetricDataQuery Expressions for cloudwatch().
import {
    CW,
    DATASOURCES,
    calls,
    codeOutsideLiterals,
    loadGrafanaQuery,
    onlyCall,
} from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

const base = {
    datasource: CW,
    queryMode: 'Metrics',
    region: 'default',
    dimensions: {},
    matchExact: true,
    label: '',
};

describe('CloudWatch expressions', () => {
    it('sends a code-mode expression as the MetricDataQuery Expression', () => {
        const expression =
            "SELECT AVG(SuccessPercent) FROM \"CloudWatch/Synthetics\" WHERE CanaryName = 'platform-us-east-2'";
        const result = q.translateGrafanaTarget(
            {
                ...base,
                refId: 'A',
                metricQueryType: 0,
                metricEditorMode: 0,
                namespace: 'CloudWatchSynthetics',
                metricName: 'SuccessPercent',
                statistic: 'Average',
                period: '5m',
                expression,
            },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        const mdq = JSON.parse(onlyCall(result.sql, 'cloudwatch').args[0]);
        expect(mdq.Expression).toBe(expression);
        expect(mdq.MetricStat).toBeUndefined();
        expect(mdq.Period).toBe(300);
    });

    it('sends a Metrics Insights query (metricQueryType 1) as the Expression', () => {
        const sqlExpression =
            'SELECT MAX(ReplicationLatency) FROM "AWS/S3" GROUP BY DestinationBucket';
        const result = q.translateGrafanaTarget(
            {
                ...base,
                refId: 'A',
                metricQueryType: 1,
                metricEditorMode: 1,
                namespace: 'AWS/S3',
                metricName: 'ReplicationLatency',
                sqlExpression,
                period: '300',
            },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        const mdq = JSON.parse(onlyCall(result.sql, 'cloudwatch').args[0]);
        expect(mdq.Expression).toBe(sqlExpression);
    });

    it('evaluates metric math over the panel targets it references', () => {
        const panel = {
            type: 'timeseries',
            datasource: CW,
            targets: [
                {
                    ...base,
                    refId: 'errors',
                    id: 'errors',
                    hide: true,
                    metricQueryType: 0,
                    metricEditorMode: 0,
                    namespace: 'AWS/Lambda',
                    metricName: 'Errors',
                    statistic: 'Sum',
                    period: '300',
                    expression: '',
                },
                {
                    ...base,
                    refId: 'invocations',
                    id: 'invocations',
                    hide: true,
                    metricQueryType: 0,
                    metricEditorMode: 0,
                    namespace: 'AWS/Lambda',
                    metricName: 'Invocations',
                    statistic: 'Sum',
                    period: '300',
                    expression: '',
                },
                {
                    ...base,
                    refId: 'rate',
                    id: 'rate',
                    metricQueryType: 0,
                    metricEditorMode: 1,
                    expression: '100 * errors / invocations',
                    label: 'Error rate',
                },
            ],
        };
        const result = q.translateGrafanaPanelQueries(panel, {
            datasources: DATASOURCES,
        });
        expect(result.todo).toBeNull();
        // Hidden inputs are only inputs: the panel shows the expression's series.
        const cw = calls(result.sql, 'cloudwatch');
        expect(cw.length).toBeGreaterThanOrEqual(1);
        const queries = cw.flatMap((c) => {
            const parsed = JSON.parse(c.args[0]);
            return Array.isArray(parsed) ? parsed : [parsed];
        });
        const inputs = queries.filter((m) => m.MetricStat);
        expect(inputs.map((m) => m.MetricStat.Metric.MetricName).sort()).toEqual([
            'Errors',
            'Invocations',
        ]);
        const expr = queries.find((m) => m.Expression === '100 * errors / invocations');
        if (expr) {
            // (a) One MetricDataQuery list: the expression returns data, its inputs don't.
            // CONTRACTS §1.1 names one MetricDataQuery; a list is the narrowest extension
            // that lets CloudWatch evaluate the math itself.
            expect(cw).toHaveLength(1);
            expect(expr.ReturnData).not.toBe(false);
            expect(inputs.map((m) => m.Id).sort()).toEqual(['errors', 'invocations']);
            for (const input of inputs) expect(input.ReturnData).toBe(false);
        } else {
            // (b) One cloudwatch() call per input, and the math in SQL over their values.
            expect(cw).toHaveLength(2);
            const code = codeOutsideLiterals(result.sql);
            expect(code).toContain('100');
            expect(code).toContain('*');
            expect(code).toContain('/');
        }
    });
});
