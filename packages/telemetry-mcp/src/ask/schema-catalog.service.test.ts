import { describe, expect, it, vi } from 'vitest';
import { EngineError, type EngineClient, type EngineQueryOptions, type EngineResult } from '../engine/client.js';
import {
    PLATFORM_COLUMNS_SQL,
    PLATFORM_TABLES_SQL,
    createPlatformCatalog,
    formatCatalogForPrompt,
    qualifiedName,
} from './schema-catalog.service.js';

const audit = { description: 'AI Ask (m; rows shared with model): q', ticket: null };

type Call = [sql: string, params?: readonly unknown[], options?: EngineQueryOptions];

function fakeEngine(tables: [string, string][], columns: Record<string, [string, string, boolean][]>) {
    const query = vi.fn<(...args: Call) => Promise<EngineResult>>(async (sql, params = []) => {
        if (sql === PLATFORM_TABLES_SQL) {
            return {
                columns: ['table_schema', 'table_name'],
                rows: tables.map(([table_schema, table_name]) => ({ table_schema, table_name })),
                truncated: false,
            };
        }
        if (sql === PLATFORM_COLUMNS_SQL) {
            const cols = columns[`${String(params[0])}.${String(params[1])}`] ?? [];
            return {
                columns: ['column_name', 'data_type', 'is_nullable'],
                rows: cols.map(([column_name, data_type, is_nullable]) => ({ column_name, data_type, is_nullable })),
                truncated: false,
            };
        }
        throw new EngineError('unexpected statement', 'XX000');
    });
    const engine: EngineClient = { query: (...args: Call) => query(...args) };
    return { engine, query };
}

const TABLES: [string, string][] = [
    ['public', 'orders'],
    ['billing', 'claims'],
    ['public', 'claim_rejects'],
];
const COLUMNS: Record<string, [string, string, boolean][]> = {
    'public.orders': [
        ['id', 'bigint', false],
        ['patientId', 'bigint', true],
        ['status', 'text', false],
        ['payload', 'jsonb', true],
        ['last_name', 'text', true],
    ],
    'billing.claims': [['reject_code', 'text', true]],
};

describe('platform catalog (engine-backed schema catalog)', () => {
    it('lists relations from platform_tables() once, audited, with unknown size and no comment', async () => {
        const { engine, query } = fakeEngine(TABLES, COLUMNS);
        const catalog = createPlatformCatalog({ engine, audit });

        const entries = await catalog.loadCatalog();
        await catalog.loadCatalog();

        expect(entries.map(qualifiedName)).toEqual(['billing.claims', 'claim_rejects', 'orders']);
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0]?.[2]).toEqual({ audit });
        expect(formatCatalogForPrompt(entries, 30_000)).toBe(
            ['billing.claims [table, row count unknown]', 'claim_rejects [table, row count unknown]', 'orders [table, row count unknown]'].join(
                '\n',
            ),
        );
    });

    it('describes tables from platform_columns(schema, table) as bind parameters, and names the missing ones', async () => {
        const { engine, query } = fakeEngine(TABLES, COLUMNS);
        const catalog = createPlatformCatalog({ engine, audit });

        const text = await catalog.describeTables(['ORDERS', '"billing"."claims"', 'ghost']);

        expect(text).toContain('orders (table, row count unknown)\n  "id" bigint NOT NULL\n  "patientId" bigint\n');
        expect(text).toContain('billing.claims (table, row count unknown)\n  "reject_code" text');
        expect(text).toContain('Not found (or not readable): ghost.');
        const columnCalls = query.mock.calls.filter((c) => c[0] === PLATFORM_COLUMNS_SQL);
        expect(columnCalls.map((c) => c[1])).toEqual([
            ['public', 'orders'],
            ['billing', 'claims'],
        ]);
        expect(columnCalls.every((c) => c[2]?.audit === audit)).toBe(true);
    });

    it('searches relation names, and the columns of tables already described, without reading other columns', async () => {
        const { engine, query } = fakeEngine(TABLES, COLUMNS);
        const catalog = createPlatformCatalog({ engine, audit });

        expect(await catalog.searchSchema('claim reject')).toBe(
            'billing.claims [table] (matched by name/comment)\nclaim_rejects [table] (matched by name/comment)',
        );
        expect(query.mock.calls.some((c) => c[0] === PLATFORM_COLUMNS_SQL)).toBe(false);

        await catalog.describeTables(['claims']);
        expect(await catalog.searchSchema('reject code')).toContain(
            'billing.claims [table] matching columns: "reject_code" text',
        );
        expect(await catalog.searchSchema('x')).toBe('Provide at least one keyword (2+ letters).');
        expect(await catalog.searchSchema('fax carrier')).toBe('No tables or columns matched: fax, carrier.');
    });

    it('says a join path cannot be computed without foreign keys, after resolving both names', async () => {
        const { engine } = fakeEngine(TABLES, COLUMNS);
        const catalog = createPlatformCatalog({ engine, audit });

        expect(await catalog.findJoinPath('orders', 'claims')).toMatch(
            /^Foreign keys are not visible through the Federation Engine, so no join path between orders and billing\.claims can be computed\..*naming convention/,
        );
        expect(await catalog.findJoinPath('orders', 'orders')).toBe('orders is the same table; no join is needed.');
        expect(await catalog.findJoinPath('orders', 'ghost')).toContain('Not found (or not readable): ghost.');
    });

    it('resolves a sampleable column to quoted identifiers and refuses blobs, personal data and unknown columns', async () => {
        const { engine } = fakeEngine(TABLES, COLUMNS);
        const catalog = createPlatformCatalog({ engine, audit });

        expect(await catalog.resolveColumn('orders', 'STATUS')).toEqual({
            ok: true,
            relation: '"public"."orders"',
            column: '"status"',
            type: 'text',
        });
        expect(await catalog.resolveColumn('orders', 'payload')).toEqual({
            ok: false,
            error: "Values of jsonb columns can't be sampled.",
        });
        expect(await catalog.resolveColumn('orders', 'last_name')).toMatchObject({
            ok: false,
            error: expect.stringContaining('personal data') as unknown as string,
        });
        expect(await catalog.resolveColumn('orders', 'nope')).toMatchObject({
            ok: false,
            error: 'Column "nope" not found on orders. Use describe_tables for its columns.',
        });
    });

    it('does not cache a failed catalog read', async () => {
        const { engine, query } = fakeEngine(TABLES, COLUMNS);
        query.mockRejectedValueOnce(new EngineError('permission denied: platform_read', '42501'));
        const catalog = createPlatformCatalog({ engine, audit });

        await expect(catalog.loadCatalog()).rejects.toMatchObject({ code: '42501' });
        expect(await catalog.loadCatalog()).toHaveLength(3);
    });
});
