import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queriesMatching, startHarness, type Harness } from './helpers/harness';

const TRACEQL = '{ resource.service.name = "api" && duration > 1s }';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    h.engine.on(/\btraceql\s*\(/i, {
        columns: [
            { name: 'trace_id', type: 'text' },
            { name: 'root_service', type: 'text' },
            { name: 'root_name', type: 'text' },
            { name: 'start', type: 'timestamptz' },
            { name: 'duration_ms', type: 'float8' },
            { name: 'span_count', type: 'int8' },
        ],
        rows: [['4bf92f3577b34da6a3ce929d0e0e4736', 'api', 'GET /orders', '2026-11-08T10:00:00Z', 1834.5, 42]],
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('search_traces', () => {
    it('runs traceql(query, start, end, limit) with parameters and returns trace summaries', async () => {
        const r = await h.call('search_traces', {
            query: TRACEQL,
            start: '2026-11-08T10:00:00Z',
            end: '2026-11-08T11:00:00Z',
            limit: 10,
        });
        expect(r.isError, r.text).toBe(false);
        const q = queriesMatching(h.engine, /\btraceql\s*\(/i).at(-1)!;
        expect(q.sql).not.toContain('resource.service.name');
        expect(q.params).toContain(TRACEQL);
        expect(q.params).toContain('10');
        expect(r.structured.columns).toEqual(['trace_id', 'root_service', 'root_name', 'start', 'duration_ms', 'span_count']);
        expect(r.structured.rows[0].trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(Number(r.structured.rows[0].span_count)).toBe(42);
    });

    it('rejects a limit outside 1..1000 without querying', async () => {
        const before = h.engine.dataQueries().length;
        const r = await h.call('search_traces', { query: TRACEQL, start: 'now-1h', end: 'now', limit: 100000 });
        expect(r.isError).toBe(true);
        expect(h.engine.dataQueries().length).toBe(before);
    });
});
