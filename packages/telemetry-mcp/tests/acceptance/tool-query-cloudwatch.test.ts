import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queriesMatching, startHarness, TS_SERIES_COLUMNS, type Harness } from './helpers/harness';

const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';
const MDQ = {
    Id: 'm1',
    MetricStat: {
        Metric: {
            Namespace: 'AWS/SQS',
            MetricName: 'ApproximateNumberOfMessagesVisible',
            Dimensions: [{ Name: 'QueueName', Value: "orders'); DROP TABLE x; --" }],
        },
        Period: 60,
        Stat: 'Average',
    },
    Label: 'queue depth',
};

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    h.engine.on((q) => /\bcloudwatch\s*\(/i.test(q.sql) && !/cloudwatch_logs/i.test(q.sql), {
        columns: TS_SERIES_COLUMNS,
        rows: [['2026-11-08T10:00:00Z', 12, { QueueName: 'orders' }, 'queue depth']],
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('query_cloudwatch', () => {
    it('runs cloudwatch(metric_data_query json, start, end) with the MetricDataQuery as a JSON parameter', async () => {
        const r = await h.call('query_cloudwatch', { metric_data_query: MDQ, start: START, end: END });
        expect(r.isError, r.text).toBe(false);
        const q = queriesMatching(h.engine, /\bcloudwatch\s*\(/i).at(-1)!;
        expect(q.sql).not.toMatch(/cloudwatch_logs/i);
        expect(q.sql).not.toContain('ApproximateNumberOfMessagesVisible');
        expect(q.sql).not.toContain('DROP TABLE');
        const jsonParam = q.params.find((p) => p !== null && p.trim().startsWith('{'));
        expect(JSON.parse(jsonParam!)).toEqual(MDQ);
        expect(r.structured.rows[0].value).toBe(12);
        expect(r.structured.rows[0].series).toBe('queue depth');
    });

    it('accepts a metric-math expression query', async () => {
        const expr = { Id: 'e1', Expression: 'SUM(METRICS())', Label: 'total', Period: 300 };
        const r = await h.call('query_cloudwatch', { metric_data_query: expr, start: START, end: END });
        expect(r.isError, r.text).toBe(false);
    });

    it('rejects a metric_data_query that is not an object with an Id, without querying', async () => {
        const before = h.engine.dataQueries().length;
        expect((await h.call('query_cloudwatch', { metric_data_query: [1, 2], start: START, end: END })).isError).toBe(true);
        expect((await h.call('query_cloudwatch', { metric_data_query: { Stat: 'Average' }, start: START, end: END })).isError).toBe(true);
        expect(h.engine.dataQueries().length).toBe(before);
    });
});
