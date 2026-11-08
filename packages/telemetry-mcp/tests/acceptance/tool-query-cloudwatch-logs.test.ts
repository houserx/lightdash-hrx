import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queriesMatching, startHarness, type Harness } from './helpers/harness';

const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';
const INSIGHTS = 'fields @timestamp, @message | filter @message like /timeout/ | limit 20';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    h.engine.on(/\bcloudwatch_logs\s*\(/i, {
        columns: [
            { name: 'timestamp', type: 'timestamptz' },
            { name: 'message', type: 'text' },
            { name: 'fields', type: 'json' },
        ],
        rows: [['2026-11-08T10:01:00Z', 'synthetic: Task timed out', { '@logStream': 'stream-a' }]],
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('query_cloudwatch_logs', () => {
    it('runs cloudwatch_logs(log_groups, query, start, end) with comma-joined log groups as one parameter', async () => {
        const r = await h.call('query_cloudwatch_logs', {
            log_groups: ['/aws/lambda/orders-worker', '/aws/lambda/fills-worker'],
            query: INSIGHTS,
            start: START,
            end: END,
        });
        expect(r.isError, r.text).toBe(false);
        const q = queriesMatching(h.engine, /\bcloudwatch_logs\s*\(/i).at(-1)!;
        expect(q.sql).not.toContain('/aws/lambda');
        expect(q.params).toContain('/aws/lambda/orders-worker,/aws/lambda/fills-worker');
        expect(q.params).toContain(INSIGHTS);
        expect(r.structured.columns).toEqual(['timestamp', 'message', 'fields']);
        expect(r.structured.rows[0].message).toBe('synthetic: Task timed out');
    });

    it('rejects an empty log group list and a log group containing a comma, without querying', async () => {
        const before = h.engine.dataQueries().length;
        const a = await h.call('query_cloudwatch_logs', { log_groups: [], query: INSIGHTS, start: START, end: END });
        const b = await h.call('query_cloudwatch_logs', { log_groups: ['/aws/a,/aws/b'], query: INSIGHTS, start: START, end: END });
        expect(a.isError).toBe(true);
        expect(b.isError).toBe(true);
        expect(h.engine.dataQueries().length).toBe(before);
    });
});
