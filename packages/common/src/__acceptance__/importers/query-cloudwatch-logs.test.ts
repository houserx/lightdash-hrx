/* eslint-disable */
// @ts-nocheck
// imp-query-cloudwatch-logs: a CloudWatch Logs Insights target (queryMode Logs) becomes
// cloudwatch_logs(log_groups, query, start, end[, source]).
import { CW, DATASOURCES, isTimeRangeAware, loadGrafanaQuery, onlyCall, RESERVED } from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

describe('CloudWatch Logs Insights targets', () => {
    it('reads log group names from logGroups', () => {
        const expression =
            'fields @message, @timestamp | filter @message like /match failed/ | stats count(*) by bin(1h)';
        const result = q.translateGrafanaTarget(
            {
                refId: 'A',
                datasource: CW,
                queryMode: 'Logs',
                region: 'default',
                expression,
                logGroups: [
                    {
                        accountId: '000000000000',
                        arn: 'arn:aws:logs:us-east-2:000000000000:log-group:/aws/lambda/fills-a:*',
                        name: '/aws/lambda/fills-a',
                    },
                    {
                        accountId: '000000000000',
                        arn: 'arn:aws:logs:us-east-2:000000000000:log-group:/aws/lambda/fills-b:*',
                        name: '/aws/lambda/fills-b',
                    },
                ],
                statsGroups: ['bin(1h)'],
            },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        expect(isTimeRangeAware(result.sql)).toBe(true);
        const call = onlyCall(result.sql, 'cloudwatch_logs');
        expect(call.args[0]).toBe('/aws/lambda/fills-a,/aws/lambda/fills-b');
        expect(call.args[1]).toBe(expression);
        expect(call.args[2]).toBe(RESERVED.__from);
        expect(call.args[3]).toBe(RESERVED.__to);
        expect(call.args[4]).toBe('cloudwatch-production');
    });

    it('reads the legacy logGroupNames list too', () => {
        const result = q.translateGrafanaTarget(
            {
                refId: 'A',
                datasource: CW,
                queryMode: 'Logs',
                expression: 'fields @message | limit 50',
                logGroupNames: ['/ecs/platform-api'],
            },
            { datasources: DATASOURCES },
        );
        expect(onlyCall(result.sql, 'cloudwatch_logs').args[0]).toBe('/ecs/platform-api');
    });

    it('turns a Logs target without log groups into a TODO with a warning', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: CW, queryMode: 'Logs', expression: 'fields @message' },
            { datasources: DATASOURCES },
        );
        expect(result.sql).toBeNull();
        expect(result.todo).toMatch(/log group/i);
        expect(result.warnings.length).toBeGreaterThan(0);
    });
});
