import { describe, expect, it } from 'vitest';
import { buildPlatformSchemaQuery, platformSchemaResult } from './platformSchema.js';
import { ToolInputError } from './telemetryArgs.js';

describe('buildPlatformSchemaQuery', () => {
    it('lists tables through platform_tables() with a generated description', () => {
        const q = buildPlatformSchemaQuery({});
        expect(q).toMatchObject({ kind: 'tables', sql: 'SELECT * FROM platform_tables()', params: [] });
        expect(q.description.trim().length).toBeGreaterThan(0);
    });

    it('describes a table through platform_columns($1, $2) with bind parameters', () => {
        const q = buildPlatformSchemaQuery({ table_schema: 'sales', table_name: "orders'; --" });
        expect(q.kind).toBe('columns');
        expect(q.sql).toBe('SELECT * FROM platform_columns($1, $2)');
        expect(q.params).toEqual(['sales', "orders'; --"]);
        expect(q.description.trim().length).toBeGreaterThan(0);
    });

    it('defaults table_schema to public', () => {
        expect(buildPlatformSchemaQuery({ table_name: 'fills' }).params).toEqual(['public', 'fills']);
    });

    it('sends the caller description unchanged, and generates one for a blank description', () => {
        expect(buildPlatformSchemaQuery({ description: 'Why: ENG-123' }).description).toBe('Why: ENG-123');
        expect(buildPlatformSchemaQuery({ table_name: 'x', description: 'Why' }).description).toBe('Why');
        expect(buildPlatformSchemaQuery({ description: '   ' }).description.trim().length).toBeGreaterThan(0);
    });

    it.each([
        ['table_schema without table_name', { table_schema: 'public' }],
        ['a blank table_name', { table_name: ' ' }],
        ['a blank table_schema', { table_schema: '', table_name: 'orders' }],
        ['a non-string table_name', { table_name: 5 as unknown as string }],
    ])('refuses %s', (_label, args) => {
        expect(() => buildPlatformSchemaQuery(args)).toThrow(ToolInputError);
    });
});

describe('platformSchemaResult', () => {
    const result = {
        columns: ['table_schema', 'table_name'],
        rows: [
            { table_schema: 'public', table_name: 'orders' },
            { table_schema: 'public', table_name: 'fills' },
        ],
        truncated: false,
    };

    it('returns the rows under the kind key, with rowCount and truncated', () => {
        const r = platformSchemaResult('tables', result, 100_000);
        expect(r.structuredContent).toEqual({ tables: result.rows, rowCount: 2, truncated: false });
        expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual(r.structuredContent);
    });

    it('keeps the engine row-cap flag', () => {
        expect(platformSchemaResult('tables', { ...result, truncated: true }, 100_000).structuredContent).toMatchObject({
            truncated: true,
        });
    });

    it('drops rows to stay within the byte cap', () => {
        const full = JSON.stringify({ tables: result.rows, rowCount: 2, truncated: false });
        const max = Buffer.byteLength(full) - 1;
        const r = platformSchemaResult('tables', result, max);
        const text = (r.content[0] as { text: string }).text;
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(max);
        expect(r.structuredContent).toEqual({ tables: [result.rows[0]], rowCount: 1, truncated: true });
        expect(platformSchemaResult('tables', result, Buffer.byteLength(full) + 20).structuredContent).toMatchObject({
            rowCount: 2,
            truncated: false,
        });
    });

    it('is an error when not even an empty result fits', () => {
        expect(platformSchemaResult('columns', result, 10).isError).toBe(true);
    });
});
