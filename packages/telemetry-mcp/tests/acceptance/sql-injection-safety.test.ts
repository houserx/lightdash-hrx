import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, TS_SERIES_COLUMNS, type Harness } from './helpers/harness';

const HOSTILE = "x'); DROP TABLE users; SELECT ('";
const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    // Answer every table-function query with an empty result of a plausible shape.
    h.engine.on(/\b(promql|promql_instant|logql|logql_metric|cloudwatch|traceql|trace)\s*\(/i, {
        columns: TS_SERIES_COLUMNS,
        rows: [],
    });
    h.engine.on(/\bcloudwatch_logs\s*\(/i, {
        columns: [
            { name: 'timestamp', type: 'timestamptz' },
            { name: 'message', type: 'text' },
            { name: 'fields', type: 'json' },
        ],
        rows: [],
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('SQL is built with parameters, never by pasting user input', () => {
    const calls: [string, Record<string, unknown>][] = [
        ['query_promql', { query: HOSTILE, start: START, end: END, step: '1m' }],
        ['query_promql', { query: HOSTILE, at: END }],
        ['query_logql', { query: HOSTILE, start: START, end: END }],
        ['query_logql', { query: HOSTILE, start: START, end: END, step: '1m' }],
        ['query_cloudwatch', { metric_data_query: { Id: 'm1', Expression: HOSTILE }, start: START, end: END }],
        ['query_cloudwatch_logs', { log_groups: ['/aws/lambda/a'], query: HOSTILE, start: START, end: END }],
        ['search_traces', { query: HOSTILE, start: START, end: END }],
    ];
    for (const [tool, args] of calls) {
        it(`${tool} sends hostile input only as a bind parameter`, async () => {
            const before = h.engine.dataQueries().length;
            const r = await h.call(tool, args);
            expect(r.isError, r.text).toBe(false);
            const sent = h.engine.dataQueries().slice(before);
            expect(sent.length).toBeGreaterThan(0);
            for (const q of sent) {
                expect(q.sql).not.toContain('DROP TABLE');
                expect(q.protocol).toBe('extended');
            }
            expect(sent.some((q) => q.params.some((p) => p !== null && p.includes(HOSTILE)))).toBe(true);
        });
    }

    it('only accepts a source that is configured for the tool\'s kind, before querying', async () => {
        const before = h.engine.dataQueries().length;
        const unknown = await h.call('query_promql', { query: 'up', start: START, end: END, step: '1m', source: HOSTILE });
        const wrongKind = await h.call('query_promql', { query: 'up', start: START, end: END, step: '1m', source: 'loki-production' });
        expect(unknown.isError).toBe(true);
        expect(wrongKind.isError).toBe(true);
        expect(h.engine.dataQueries().length).toBe(before);
    });
});
