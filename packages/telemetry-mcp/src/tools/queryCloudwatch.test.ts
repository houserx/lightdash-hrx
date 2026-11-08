import { describe, expect, it } from 'vitest';
import type { SourceConfig } from '../config.js';
import { buildCloudwatchQuery } from './queryCloudwatch.js';
import { ToolInputError } from './telemetryArgs.js';

const sources: SourceConfig[] = [
    { name: 'loki-production', kind: 'loki', default: true, restricted: false },
    { name: 'cloudwatch-production', kind: 'cloudwatch', default: true, restricted: false },
];
const config = { sources };
const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';
const S = '2026-11-08T10:00:00.000Z';
const E = '2026-11-08T11:00:00.000Z';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const STAT = {
    Id: 'm1',
    MetricStat: {
        Metric: { Namespace: 'AWS/SQS', MetricName: 'NumberOfMessagesSent', Dimensions: [{ Name: 'QueueName', Value: "a'; --" }] },
        Period: 60,
        Stat: 'Sum',
    },
    Label: 'sent',
};

describe('buildCloudwatchQuery', () => {
    it('sends the MetricDataQuery as one JSON parameter equal to the input, never in the SQL', () => {
        const q = buildCloudwatchQuery(config, { metric_data_query: STAT, start: START, end: END }, NOW);
        expect(q.sql).toBe('SELECT * FROM cloudwatch($1::json, $2, $3)');
        expect(q.params).toHaveLength(3);
        expect(JSON.parse(q.params[0])).toEqual(STAT);
        expect(q.params.slice(1)).toEqual([S, E]);
    });

    it('accepts an expression query and a cloudwatch source', () => {
        const expr = { Id: 'e1', Expression: 'SUM(METRICS())', Period: 300 };
        const q = buildCloudwatchQuery(
            config,
            { metric_data_query: expr, start: 'now-1h', end: 'now', source: 'cloudwatch-production' },
            NOW,
        );
        expect(q.sql).toBe('SELECT * FROM cloudwatch($1::json, $2, $3, $4)');
        expect(q.params).toEqual([JSON.stringify(expr), '2026-11-08T11:00:00.000Z', '2026-11-08T12:00:00.000Z', 'cloudwatch-production']);
    });

    it.each([
        ['an array', [1, 2]],
        ['a string', '{"Id":"m1"}'],
        ['null', null],
        ['a query without Id', { Stat: 'Average' }],
        ['an empty Id', { Id: ' ', Expression: 'SUM(METRICS())' }],
        ['a numeric Id', { Id: 1, Expression: 'SUM(METRICS())' }],
        ['neither MetricStat nor Expression', { Id: 'm1' }],
        ['both MetricStat and Expression', { Id: 'm1', MetricStat: {}, Expression: 'x' }],
        ['a non-object MetricStat', { Id: 'm1', MetricStat: 'Average' }],
        ['an empty Expression', { Id: 'e1', Expression: '' }],
    ])('refuses %s', (_label, mdq) => {
        expect(() => buildCloudwatchQuery(config, { metric_data_query: mdq, start: START, end: END }, NOW)).toThrow(
            ToolInputError,
        );
    });

    it.each([
        ['a loki source', { source: 'loki-production' }],
        ['an unknown source', { source: 'nope' }],
        ['end before start', { start: END, end: START }],
    ])('refuses %s', (_label, extra) => {
        expect(() =>
            buildCloudwatchQuery(config, { metric_data_query: STAT, start: START, end: END, ...extra }, NOW),
        ).toThrow(ToolInputError);
    });
});
