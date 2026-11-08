import { describe, expect, it } from 'vitest';
import type { SourceConfig } from '../config.js';
import { buildCloudwatchLogsQuery } from './queryCloudwatchLogs.js';
import { ToolInputError } from './telemetryArgs.js';

const sources: SourceConfig[] = [
    { name: 'cloudwatch-production', kind: 'cloudwatch', default: true, restricted: false },
    { name: 'cloudwatch-logs-production', kind: 'cloudwatch_logs', default: true, restricted: false },
];
const config = { sources };
const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';
const S = '2026-11-08T10:00:00.000Z';
const E = '2026-11-08T11:00:00.000Z';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const QUERY = "fields @timestamp, @message | filter @message like /x'; DROP TABLE t; --/";

describe('buildCloudwatchLogsQuery', () => {
    it('sends the log groups comma-joined as one parameter and the query as another, never in the SQL', () => {
        const q = buildCloudwatchLogsQuery(
            config,
            { log_groups: ['/aws/lambda/a', '/aws/lambda/b'], query: QUERY, start: START, end: END },
            NOW,
        );
        expect(q.sql).toBe('SELECT * FROM cloudwatch_logs($1, $2, $3, $4)');
        expect(q.params).toEqual(['/aws/lambda/a,/aws/lambda/b', QUERY, S, E]);
    });

    it('accepts relative times and a cloudwatch_logs source', () => {
        const q = buildCloudwatchLogsQuery(
            config,
            { log_groups: ['/aws/a'], query: 'fields @message', start: 'now-1h', end: 'now', source: 'cloudwatch-logs-production' },
            NOW,
        );
        expect(q.sql).toBe('SELECT * FROM cloudwatch_logs($1, $2, $3, $4, $5)');
        expect(q.params).toEqual(['/aws/a', 'fields @message', '2026-11-08T11:00:00.000Z', '2026-11-08T12:00:00.000Z', 'cloudwatch-logs-production']);
    });

    it.each([
        ['no log groups', { log_groups: [] }],
        ['a log group with a comma', { log_groups: ['/aws/a,/aws/b'] }],
        ['an empty log group', { log_groups: ['/aws/a', ' '] }],
        ['a non-array log_groups', { log_groups: '/aws/a' }],
        ['an empty query', { query: '  ' }],
        ['a cloudwatch (metrics) source', { source: 'cloudwatch-production' }],
        ['an unknown source', { source: 'nope' }],
        ['end before start', { start: END, end: START }],
    ])('refuses %s', (_label, override) => {
        const args = { log_groups: ['/aws/a'], query: 'fields @message', start: START, end: END, ...override };
        expect(() => buildCloudwatchLogsQuery(config, args as never, NOW)).toThrow(ToolInputError);
    });
});
