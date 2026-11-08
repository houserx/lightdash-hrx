// ldq-investigate-sql-cloudwatch: the CloudWatch metric form builds a MetricDataQuery
// and the query becomes cloudwatch(...) SQL.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

describe('CloudWatch metric query', () => {
    it('builds a MetricDataQuery from the form', () => {
        expect(
            common.buildCloudWatchMetricDataQuery({
                namespace: 'AWS/SQS',
                metricName: 'ApproximateNumberOfMessagesVisible',
                dimensions: { QueueName: 'fills' },
                stat: 'Maximum',
                period: 60,
            }),
        ).toEqual({
            Id: 'm1',
            MetricStat: {
                Metric: {
                    Namespace: 'AWS/SQS',
                    MetricName: 'ApproximateNumberOfMessagesVisible',
                    Dimensions: [{ Name: 'QueueName', Value: 'fills' }],
                },
                Period: 60,
                Stat: 'Maximum',
            },
            ReturnData: true,
        });
    });

    it('embeds the compact JSON in cloudwatch(...)', () => {
        const metricDataQuery = {
            Id: 'm1',
            MetricStat: {
                Metric: {
                    Namespace: 'AWS/SQS',
                    MetricName: 'NumberOfMessagesSent',
                    Dimensions: [{ Name: 'QueueName', Value: 'rx-events' }],
                },
                Period: 300,
                Stat: 'Sum',
            },
            ReturnData: true,
        };
        expect(
            common.buildTelemetrySql({ kind: 'cloudwatch', metricDataQuery }),
        ).toBe(
            `SELECT * FROM cloudwatch('${JSON.stringify(metricDataQuery)}', \${ld.parameters.__from}, \${ld.parameters.__to})`,
        );
        expect(
            common.buildTelemetrySql({
                kind: 'cloudwatch',
                metricDataQuery: { Id: 'e1', Expression: "SEARCH('x', 'Sum')" },
                source: 'cloudwatch-production',
            }),
        ).toBe(
            "SELECT * FROM cloudwatch('{\"Id\":\"e1\",\"Expression\":\"SEARCH(''x'', ''Sum'')\"}', ${ld.parameters.__from}, ${ld.parameters.__to}, 'cloudwatch-production')",
        );
    });
});
