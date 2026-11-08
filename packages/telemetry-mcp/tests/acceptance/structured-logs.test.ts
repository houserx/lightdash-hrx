import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SECRET, SERVICE_TOKEN, startHarness, TS_SERIES_COLUMNS, type Harness } from './helpers/harness';

const ROW_SENTINEL = 'ROW-SENTINEL-7d1f';
const SQL_SENTINEL = 'SQL-SENTINEL-93ab';
const MRN_LIKE = 'MRN-SYNTHETIC-000123';

let h: Harness;
let accessToken = '';
const identityTokens: string[] = [];

beforeAll(async () => {
    h = await startHarness();
    h.engine.on(/\bpromql\s*\(/i, (q) => {
        identityTokens.push(q.sets['hrx.identity'] ?? '');
        return { columns: TS_SERIES_COLUMNS, rows: [['2026-11-08T10:00:00Z', 1, { pod: ROW_SENTINEL }, `{pod="${ROW_SENTINEL}"}`]] };
    });
    h.engine.on(/\bplatform_query\s*\(/i, (q) => {
        identityTokens.push(q.sets['hrx.identity'] ?? '');
        return { columns: [{ name: 'note', type: 'text' }], rows: [[`${ROW_SENTINEL} ${MRN_LIKE}`]] };
    });
    accessToken = h.token();
    await h.call('query_promql', { query: 'up', start: '2026-11-08T10:00:00Z', end: '2026-11-08T11:00:00Z', step: '1m' }, accessToken);
    await h.call(
        'platform_query',
        { sql: `SELECT note FROM notes WHERE mrn = '${MRN_LIKE}' -- ${SQL_SENTINEL}`, description: 'Log hygiene check' },
        accessToken,
    );
    await h.call('query_promql', { query: 'up', start: 'bad', end: 'now', step: '1m' }, accessToken);
    // An unauthenticated request should be logged too.
    await fetch(h.mcpUrl, { method: 'POST', headers: { authorization: 'Bearer junk' }, body: '{}' });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('structured logs never contain query results, tokens or PHI', () => {
    it('writes one JSON object per line with level and msg', () => {
        expect(h.logs.length).toBeGreaterThan(0);
        for (const line of h.logs) {
            const o = JSON.parse(line) as Record<string, unknown>;
            expect(typeof o.level).toBe('string');
            expect(typeof o.msg).toBe('string');
        }
    });

    it('logs each tool call with the tool name and outcome', () => {
        const toolLines = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => o.tool);
        expect(toolLines.some((o) => o.tool === 'query_promql')).toBe(true);
        expect(toolLines.some((o) => o.tool === 'platform_query')).toBe(true);
    });

    it('contains no result values, SQL text, access or identity tokens, or secrets', () => {
        const all = h.logs.join('\n');
        expect(identityTokens.length).toBeGreaterThan(0);
        expect(all).not.toContain(ROW_SENTINEL);
        expect(all).not.toContain(SQL_SENTINEL);
        expect(all).not.toContain(MRN_LIKE);
        expect(all).not.toContain(accessToken);
        expect(all).not.toContain(accessToken.split('.')[2]!);
        for (const t of identityTokens) {
            expect(all).not.toContain(t);
            expect(all).not.toContain(t.split('.')[1]!);
        }
        expect(all).not.toContain(IDENTITY_SECRET);
        expect(all).not.toContain(SERVICE_TOKEN);
        expect(all).not.toContain('test-pg-password-not-real');
    });
});
