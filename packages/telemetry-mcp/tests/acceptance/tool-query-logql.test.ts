import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queriesMatching, startHarness, TS_SERIES_COLUMNS, type Harness } from './helpers/harness';

const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';
const LOGQL = '{app="api", namespace="default"} |= "timeout" | json';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    h.engine.on(/\blogql\s*\(/i, {
        columns: [
            { name: 'timestamp', type: 'timestamptz' },
            { name: 'line', type: 'text' },
            { name: 'labels', type: 'json' },
            { name: 'stream', type: 'text' },
        ],
        rows: [['2026-11-08T10:05:00Z', 'synthetic: upstream timeout', { app: 'api' }, '{app="api"}']],
    });
    h.engine.on(/\blogql_metric\s*\(/i, { columns: TS_SERIES_COLUMNS, rows: [['2026-11-08T10:05:00Z', 3, { app: 'api' }, '{app="api"}']] });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('query_logql', () => {
    it('runs logql(query, start, end, limit, direction) with parameters', async () => {
        const r = await h.call('query_logql', { query: LOGQL, start: START, end: END, limit: 50, direction: 'forward' });
        expect(r.isError, r.text).toBe(false);
        const q = queriesMatching(h.engine, /\blogql\s*\(/i).at(-1)!;
        expect(q.sql).not.toContain('timeout');
        expect(q.params).toContain(LOGQL);
        expect(q.params).toContain('50');
        expect(q.params).toContain('forward');
        expect(r.structured.columns).toEqual(['timestamp', 'line', 'labels', 'stream']);
        expect(r.structured.rows[0].line).toBe('synthetic: upstream timeout');
    });

    it('runs logql_metric(query, start, end, step) when a step is given', async () => {
        const r = await h.call('query_logql', {
            query: 'sum(count_over_time({app="api"} |= "timeout" [5m]))',
            start: START,
            end: END,
            step: '5m',
        });
        expect(r.isError, r.text).toBe(false);
        const q = queriesMatching(h.engine, /\blogql_metric\s*\(/i).at(-1)!;
        expect(q.params).toContain('5m');
        expect(r.structured.columns).toEqual(['timestamp', 'value', 'labels', 'series']);
    });

    it('validates direction and limit before querying', async () => {
        const before = h.engine.dataQueries().length;
        expect((await h.call('query_logql', { query: LOGQL, start: START, end: END, direction: 'sideways' })).isError).toBe(true);
        expect((await h.call('query_logql', { query: LOGQL, start: START, end: END, limit: -1 })).isError).toBe(true);
        expect((await h.call('query_logql', { query: LOGQL, start: START, end: END, limit: 'ten' })).isError).toBe(true);
        expect(h.engine.dataQueries().length).toBe(before);
    });
});
