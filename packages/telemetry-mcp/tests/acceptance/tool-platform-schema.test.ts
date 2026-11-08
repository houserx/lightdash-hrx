import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SECRET, identityOf, queriesMatching, startHarness, type Harness } from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    h.engine.on(/\bplatform_tables\s*\(/i, {
        columns: [
            { name: 'table_schema', type: 'text' },
            { name: 'table_name', type: 'text' },
        ],
        rows: [
            ['public', 'orders'],
            ['public', 'fills'],
        ],
    });
    h.engine.on(/\bplatform_columns\s*\(/i, {
        columns: [
            { name: 'column_name', type: 'text' },
            { name: 'data_type', type: 'text' },
            { name: 'is_nullable', type: 'bool' },
        ],
        rows: [
            ['id', 'bigint', false],
            ['status', 'text', true],
        ],
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('platform_schema', () => {
    it('lists Platform Database tables through platform_tables()', async () => {
        const r = await h.call('platform_schema', {});
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.tables).toEqual([
            { table_schema: 'public', table_name: 'orders' },
            { table_schema: 'public', table_name: 'fills' },
        ]);
    });

    it('describes one table through platform_columns(schema, table) with parameters', async () => {
        const r = await h.call('platform_schema', { table_schema: 'public', table_name: 'orders' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.columns).toEqual([
            { column_name: 'id', data_type: 'bigint', is_nullable: false },
            { column_name: 'status', data_type: 'text', is_nullable: true },
        ]);
        const q = queriesMatching(h.engine, /\bplatform_columns\s*\(/i).at(-1)!;
        expect(q.sql).not.toContain('orders');
        expect(q.params).toEqual(expect.arrayContaining(['public', 'orders']));
    });

    it('defaults table_schema to public', async () => {
        const r = await h.call('platform_schema', { table_name: 'fills' });
        expect(r.isError, r.text).toBe(false);
        expect(queriesMatching(h.engine, /\bplatform_columns\s*\(/i).at(-1)!.params).toEqual(
            expect.arrayContaining(['public', 'fills']),
        );
    });

    it('runs as an Audited Query: the identity carries a non-empty description and source mcp', () => {
        for (const q of queriesMatching(h.engine, /\bplatform_(tables|columns)\s*\(/i)) {
            const id = verifyIdentityToken(identityOf(q), IDENTITY_SECRET);
            expect(id.audit.source).toBe('mcp');
            expect((id.audit.description ?? '').trim().length).toBeGreaterThan(0);
        }
    });

    it('uses a caller-supplied description when given', async () => {
        await h.call('platform_schema', { description: 'Finding where fills are stored for ENG-123' });
        const q = queriesMatching(h.engine, /\bplatform_tables\s*\(/i).at(-1)!;
        expect(verifyIdentityToken(identityOf(q), IDENTITY_SECRET).audit.description).toBe(
            'Finding where fills are stored for ENG-123',
        );
    });
});
