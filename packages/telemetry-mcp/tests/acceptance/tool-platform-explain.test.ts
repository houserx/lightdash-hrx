import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SECRET, identityOf, queriesMatching, startHarness, VIEWER, type Harness } from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';

const PLAN = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 500000, 'Total Cost': 9123.5 } }];
const SQL = "SELECT id FROM orders WHERE status = 'open'";

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    // Engine §1.2: platform_explain needs platform_read or platform_explain.
    h.engine.on(/\bplatform_explain\s*\(/i, (q) => {
        const id = verifyIdentityToken(identityOf(q), IDENTITY_SECRET);
        if (!id.attrs.platform_read && !id.attrs.platform_explain) {
            return { error: { code: '42501', message: 'platform_explain requires attrs.platform_read or attrs.platform_explain' } };
        }
        return { columns: [{ name: 'plan', type: 'json' }], rows: [[PLAN]] };
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('platform_explain', () => {
    it('returns the estimate-only plan from platform_explain($1), SQL as a parameter', async () => {
        const r = await h.call('platform_explain', { sql: SQL, advise: false });
        expect(r.isError, r.text).toBe(false);
        const plan = typeof r.structured.plan === 'string' ? JSON.parse(r.structured.plan) : r.structured.plan;
        expect(plan).toEqual(PLAN);
        expect(r.structured.advice).toBeNull();
        const q = queriesMatching(h.engine, /\bplatform_explain\s*\(/i).at(-1)!;
        expect(q.params).toContain(SQL);
        expect(q.sql).not.toContain('orders');
        expect(q.sql).not.toMatch(/\bANALYZE\b/i);
    });

    it('runs as an Audited Query with a description', () => {
        const id = verifyIdentityToken(
            identityOf(queriesMatching(h.engine, /\bplatform_explain\s*\(/i).at(-1)!),
            IDENTITY_SECRET,
        );
        expect(id.audit.source).toBe('mcp');
        expect((id.audit.description ?? '').trim().length).toBeGreaterThan(0);
    });

    it('offers no way to request EXPLAIN ANALYZE', async () => {
        const tool = (await h.listTools()).find((t) => t.name === 'platform_explain');
        expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('analyze');
    });

    it('reports access denied for a user without platform_read or platform_explain', async () => {
        const r = await h.call('platform_explain', { sql: SQL, advise: false }, h.okta.sign({ sub: '00u-v', email: VIEWER.email }));
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/access denied|permission/i);
    });
});
