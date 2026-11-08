import {
    buildCloudWatchMetricDataQuery,
    buildTelemetrySql,
} from './telemetrySql';

describe('buildTelemetrySql', () => {
    describe('promql', () => {
        it('passes the reserved time parameters as start, end and step', () => {
            expect(buildTelemetrySql({ kind: 'promql', query: 'up' })).toBe(
                "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
            );
        });

        it('keeps double quotes and braces in the query as they are', () => {
            expect(
                buildTelemetrySql({
                    kind: 'promql',
                    query: 'rate(http_requests_total{job="api"}[5m])',
                }),
            ).toBe(
                'SELECT * FROM promql(\'rate(http_requests_total{job="api"}[5m])\', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})',
            );
        });

        it('appends a named source as a string literal', () => {
            expect(
                buildTelemetrySql({
                    kind: 'promql',
                    query: 'up',
                    source: 'prometheus-production',
                }),
            ).toBe(
                "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}, 'prometheus-production')",
            );
        });

        it('leaves out an empty source so the engine default applies', () => {
            expect(
                buildTelemetrySql({ kind: 'promql', query: 'up', source: '' }),
            ).toBe(
                "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
            );
        });

        it('doubles single quotes in the query and the source', () => {
            expect(
                buildTelemetrySql({
                    kind: 'promql',
                    query: "label_replace(up, 'x', 'y', '', '')",
                    source: "o'brien",
                }),
            ).toBe(
                "SELECT * FROM promql('label_replace(up, ''x'', ''y'', '''', '''')', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}, 'o''brien')",
            );
        });
    });

    describe('logql', () => {
        it('writes out the default limit 1000 and direction backward', () => {
            expect(
                buildTelemetrySql({ kind: 'logql', query: '{app="api"}' }),
            ).toBe(
                "SELECT * FROM logql('{app=\"api\"}', ${ld.parameters.__from}, ${ld.parameters.__to}, 1000, 'backward')",
            );
        });

        it('honours limit, direction and source, escaping quotes', () => {
            expect(
                buildTelemetrySql({
                    kind: 'logql',
                    query: '{app="api"} |= `it\'s`',
                    limit: 50,
                    direction: 'forward',
                    source: 'loki-production',
                }),
            ).toBe(
                "SELECT * FROM logql('{app=\"api\"} |= `it''s`', ${ld.parameters.__from}, ${ld.parameters.__to}, 50, 'forward', 'loki-production')",
            );
        });

        it('refuses a limit that is not a positive integer', () => {
            expect(() =>
                buildTelemetrySql({
                    kind: 'logql',
                    query: '{a="b"}',
                    limit: 0,
                }),
            ).toThrow(/positive integer/);
            expect(() =>
                buildTelemetrySql({
                    kind: 'logql',
                    query: '{a="b"}',
                    limit: 1.5,
                }),
            ).toThrow(/positive integer/);
        });

        it('refuses an unknown direction', () => {
            expect(() =>
                buildTelemetrySql({
                    kind: 'logql',
                    query: '{a="b"}',
                    direction: 'sideways' as 'forward',
                }),
            ).toThrow(/direction/);
        });
    });

    describe('logql_metric', () => {
        it('steps by the interval parameter', () => {
            expect(
                buildTelemetrySql({
                    kind: 'logql_metric',
                    query: 'count_over_time({app="api"}[1m])',
                    source: 'loki',
                }),
            ).toBe(
                "SELECT * FROM logql_metric('count_over_time({app=\"api\"}[1m])', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}, 'loki')",
            );
        });
    });

    describe('cloudwatch', () => {
        it('builds the form query and embeds it as compact JSON', () => {
            const metricDataQuery = buildCloudWatchMetricDataQuery({
                namespace: ' AWS/Lambda ',
                metricName: 'Errors',
                dimensions: { FunctionName: 'rx-sync', Resource: 'rx-sync' },
                stat: 'Sum',
                period: 300,
            });
            expect(
                metricDataQuery.MetricStat?.Metric.Dimensions?.map(
                    (d) => d.Name,
                ),
            ).toEqual(['FunctionName', 'Resource']);
            expect(
                buildTelemetrySql({ kind: 'cloudwatch', metricDataQuery }),
            ).toBe(
                'SELECT * FROM cloudwatch(\'{"Id":"m1","MetricStat":{"Metric":{"Namespace":"AWS/Lambda","MetricName":"Errors","Dimensions":[{"Name":"FunctionName","Value":"rx-sync"},{"Name":"Resource","Value":"rx-sync"}]},"Period":300,"Stat":"Sum"},"ReturnData":true}\', ${ld.parameters.__from}, ${ld.parameters.__to})',
            );
        });

        it('allows no dimensions', () => {
            expect(
                buildCloudWatchMetricDataQuery({
                    namespace: 'AWS/SQS',
                    metricName: 'NumberOfMessagesSent',
                    stat: 'Average',
                    period: 60,
                }).MetricStat?.Metric.Dimensions,
            ).toEqual([]);
        });

        it('refuses a missing field or a bad period', () => {
            const form = {
                namespace: 'AWS/SQS',
                metricName: 'NumberOfMessagesSent',
                stat: 'Sum',
                period: 60,
            };
            expect(() =>
                buildCloudWatchMetricDataQuery({ ...form, metricName: ' ' }),
            ).toThrow(/required/);
            expect(() =>
                buildCloudWatchMetricDataQuery({ ...form, period: 0 }),
            ).toThrow(/period/);
            expect(() =>
                buildCloudWatchMetricDataQuery({ ...form, period: 1.5 }),
            ).toThrow(/period/);
        });

        it('doubles single quotes inside the JSON', () => {
            expect(
                buildTelemetrySql({
                    kind: 'cloudwatch',
                    metricDataQuery: {
                        Id: 'e1',
                        Expression: "SEARCH('{AWS/SQS} QueueName', 'Sum')",
                    },
                }),
            ).toContain("SEARCH(''{AWS/SQS} QueueName'', ''Sum'')");
        });
    });

    describe('cloudwatch_logs', () => {
        it('trims log groups and drops blank ones', () => {
            expect(
                buildTelemetrySql({
                    kind: 'cloudwatch_logs',
                    logGroups: [' /ecs/api ', '', '/ecs/worker'],
                    query: 'fields @message',
                }),
            ).toBe(
                "SELECT * FROM cloudwatch_logs('/ecs/api,/ecs/worker', 'fields @message', ${ld.parameters.__from}, ${ld.parameters.__to})",
            );
        });

        it('refuses no log groups and a log group with a comma', () => {
            expect(() =>
                buildTelemetrySql({
                    kind: 'cloudwatch_logs',
                    logGroups: [' '],
                    query: 'fields @message',
                }),
            ).toThrow(/at least one log group/);
            expect(() =>
                buildTelemetrySql({
                    kind: 'cloudwatch_logs',
                    logGroups: ['/ecs/a,b'],
                    query: 'fields @message',
                }),
            ).toThrow(/comma/);
        });
    });
});
