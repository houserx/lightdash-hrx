import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness';

const CAP = 20_000;
const LOG_COLUMNS = [
    { name: 'timestamp', type: 'timestamptz' as const },
    { name: 'line', type: 'text' as const },
    { name: 'labels', type: 'json' as const },
    { name: 'stream', type: 'text' as const },
];

let h: Harness;
beforeAll(async () => {
    h = await startHarness({ env: { MCP_MAX_OUTPUT_BYTES: String(CAP), MCP_MAX_ROWS: '1000' } });
    const rows = Array.from({ length: 500 }, (_, i) => [
        new Date(Date.UTC(2026, 10, 8, 10, 0, i)).toISOString(),
        `synthetic log line ${i} ${'x'.repeat(300)}`,
        { app: 'api' },
        '{app="api"}',
    ]);
    h.engine.on(/\blogql\s*\(/i, { columns: LOG_COLUMNS, rows });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('tool output size cap (MCP_MAX_OUTPUT_BYTES)', () => {
    it('keeps both the structured and the text content under the cap and flags truncation', async () => {
        const r = await h.call('query_logql', {
            query: '{app="api"}',
            start: '2026-11-08T10:00:00Z',
            end: '2026-11-08T11:00:00Z',
            limit: 1000,
        });
        expect(r.isError, r.text).toBe(false);
        expect(Buffer.byteLength(JSON.stringify(r.structured))).toBeLessThanOrEqual(CAP);
        expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(CAP);
        expect(r.structured.truncated).toBe(true);
        expect(r.structured.rows.length).toBeGreaterThan(0);
        expect(r.structured.rows.length).toBeLessThan(500);
        expect(r.structured.rowCount).toBe(r.structured.rows.length);
    });
});
