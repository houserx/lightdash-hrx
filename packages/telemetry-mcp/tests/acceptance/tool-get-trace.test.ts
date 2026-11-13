import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queriesMatching, startHarness, type Harness } from './helpers/harness';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    h.engine.on(/\btrace\s*\(/i, {
        columns: [
            { name: 'trace_id', type: 'text' },
            { name: 'span_id', type: 'text' },
            { name: 'parent_span_id', type: 'text' },
            { name: 'service', type: 'text' },
            { name: 'name', type: 'text' },
            { name: 'start', type: 'timestamptz' },
            { name: 'duration_ms', type: 'float8' },
            { name: 'status', type: 'text' },
            { name: 'attributes', type: 'json' },
        ],
        rows: [
            [TRACE_ID, '00f067aa0ba902b7', null, 'api', 'GET /orders', '2026-11-08T10:00:00Z', 120.5, 'ok', { 'http.status_code': 200 }],
            [TRACE_ID, '00f067aa0ba902b8', '00f067aa0ba902b7', 'db', 'SELECT', '2026-11-08T10:00:00.010Z', 80, 'ok', {}],
        ],
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('get_trace', () => {
    it('runs trace(trace_id) with the id as a parameter and returns every span', async () => {
        const r = await h.call('get_trace', { trace_id: TRACE_ID });
        expect(r.isError, r.text).toBe(false);
        const q = queriesMatching(h.engine, /\btrace\s*\(/i).at(-1)!;
        expect(q.sql).not.toContain(TRACE_ID);
        expect(q.params).toContain(TRACE_ID);
        expect(r.structured.rows).toHaveLength(2);
        expect(r.structured.rows[0].parent_span_id).toBeNull();
        expect(r.structured.rows[1].parent_span_id).toBe('00f067aa0ba902b7');
    });

    it('rejects a trace id that is not 16-32 hex characters, without querying', async () => {
        const before = h.engine.dataQueries().length;
        for (const id of ['xyz', "4bf92f35'); --", '4bf92f3577b34da6a3ce929d0e0e47364bf92f35']) {
            expect((await h.call('get_trace', { trace_id: id })).isError).toBe(true);
        }
        expect(h.engine.dataQueries().length).toBe(before);
    });
});
