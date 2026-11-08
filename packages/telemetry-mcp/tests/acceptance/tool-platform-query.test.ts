import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SECRET, identityOf, queriesMatching, startHarness, type Harness } from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';

const SQL = 'SELECT status, count(*) AS n FROM orders GROUP BY 1 ORDER BY 2 DESC';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    h.engine.on(/\bplatform_query\s*\(/i, (q) => {
        if (q.params.some((p) => p?.includes('audit_will_fail'))) {
            return { error: { code: '58000', message: 'audit write failed' } };
        }
        return {
            columns: [
                { name: 'status', type: 'text' },
                { name: 'n', type: 'int8' },
            ],
            rows: [
                ['open', 12],
                ['shipped', 30],
            ],
        };
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const platformQueries = () => queriesMatching(h.engine, /\bplatform_query\s*\(/i);

describe('platform_query (Audited Query)', () => {
    it('runs platform_query($1) with the SQL as a parameter and returns rows', async () => {
        const r = await h.call('platform_query', {
            sql: SQL,
            description: 'Checking the order backlog for ENG-123',
            ticket: 'ENG-123',
        });
        expect(r.isError, r.text).toBe(false);
        const q = platformQueries().at(-1)!;
        expect(q.sql).not.toContain('FROM orders');
        expect(q.params).toContain(SQL);
        expect(r.structured.columns).toEqual(['status', 'n']);
        expect(r.structured.rows.map((x: { n: unknown }) => Number(x.n))).toEqual([12, 30]);
    });

    it('puts description and ticket into the identity audit block (source mcp)', () => {
        const id = verifyIdentityToken(identityOf(platformQueries().at(-1)!), IDENTITY_SECRET);
        expect(id.audit).toEqual({
            description: 'Checking the order backlog for ENG-123',
            ticket: 'ENG-123',
            source: 'mcp',
            resource_uuid: null,
        });
        expect(id.agent).toBe(true);
    });

    it('sends ticket null when none is given', async () => {
        const r = await h.call('platform_query', { sql: SQL, description: 'Weekly support check' });
        expect(r.isError, r.text).toBe(false);
        expect(verifyIdentityToken(identityOf(platformQueries().at(-1)!), IDENTITY_SECRET).audit.ticket).toBeNull();
    });

    it('requires a non-empty description and a Linear-style ticket, before querying', async () => {
        const before = platformQueries().length;
        expect((await h.call('platform_query', { sql: SQL })).isError).toBe(true);
        expect((await h.call('platform_query', { sql: SQL, description: '   ' })).isError).toBe(true);
        expect((await h.call('platform_query', { sql: SQL, description: 'ok', ticket: 'not a ticket' })).isError).toBe(true);
        expect(platformQueries().length).toBe(before);
    });

    it('declares description as required in its input schema', async () => {
        const tool = (await h.listTools()).find((t) => t.name === 'platform_query');
        expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['sql', 'description']));
        expect(tool.inputSchema.required ?? []).not.toContain('ticket');
    });

    it('withholds the result when the engine cannot write the audit record (58000)', async () => {
        const r = await h.call('platform_query', {
            sql: 'SELECT 1 AS audit_will_fail',
            description: 'Audit failure path',
        });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/audit/i);
        expect(r.structured?.rows ?? []).toEqual([]);
    });
});
