import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, TS_SERIES_COLUMNS, type Harness } from './helpers/harness';

let h: Harness;
beforeAll(async () => {
    h = await startHarness({ env: { MCP_MAX_ROWS: '50' } });
    const rows = Array.from({ length: 120 }, (_, i) => [
        new Date(Date.UTC(2026, 10, 8, 10, i)).toISOString(),
        i,
        { job: 'api' },
        '{job="api"}',
    ]);
    h.engine.on(/\bpromql\s*\(/i, { columns: TS_SERIES_COLUMNS, rows });
    h.engine.on(/\bpromql_instant\s*\(/i, { columns: TS_SERIES_COLUMNS, rows: rows.slice(0, 3) });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('row cap (MCP_MAX_ROWS)', () => {
    it('returns at most MCP_MAX_ROWS rows and says the result was truncated', async () => {
        const r = await h.call('query_promql', {
            query: 'up',
            start: '2026-11-08T10:00:00Z',
            end: '2026-11-08T12:00:00Z',
            step: '1m',
        });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.rows).toHaveLength(50);
        expect(r.structured.rowCount).toBe(50);
        expect(r.structured.truncated).toBe(true);
        expect(r.structured.rows[0].value).toBe(0);
    });

    it('does not flag a small result as truncated', async () => {
        const r = await h.call('query_promql', { query: 'up', at: '2026-11-08T10:00:00Z' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.rows).toHaveLength(3);
        expect(r.structured.truncated).toBe(false);
    });
});
