// ldq-investigate-sql-logs-insights: a Logs Insights query over log groups becomes
// cloudwatch_logs(...) SQL.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

describe('buildTelemetrySql cloudwatch_logs', () => {
    it('joins log groups with commas', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'cloudwatch_logs',
                logGroups: ['/aws/lambda/fills', '/aws/lambda/refills'],
                query: 'fields @timestamp, @message | filter @message like /ERROR/ | limit 50',
            }),
        ).toBe(
            "SELECT * FROM cloudwatch_logs('/aws/lambda/fills,/aws/lambda/refills', 'fields @timestamp, @message | filter @message like /ERROR/ | limit 50', ${ld.parameters.__from}, ${ld.parameters.__to})",
        );
    });

    it('escapes quotes and appends a source', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'cloudwatch_logs',
                logGroups: ['/ecs/api'],
                query: "filter level = 'error'",
                source: 'cloudwatch-logs-production',
            }),
        ).toBe(
            "SELECT * FROM cloudwatch_logs('/ecs/api', 'filter level = ''error''', ${ld.parameters.__from}, ${ld.parameters.__to}, 'cloudwatch-logs-production')",
        );
    });
});
