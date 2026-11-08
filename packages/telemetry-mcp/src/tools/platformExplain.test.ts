import { describe, expect, it } from 'vitest';
import {
    GENERATED_EXPLAIN_DESCRIPTION,
    PLATFORM_EXPLAIN_SQL,
    buildPlatformExplainQuery,
    planOf,
    platformExplainResult,
} from './platformExplain.js';
import { ToolInputError } from './telemetryArgs.js';

const SQL = "SELECT id FROM orders WHERE note = 'x'; --";
const PLAN = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders' } }];

describe('buildPlatformExplainQuery', () => {
    it('sends the SQL only as the bind parameter of platform_explain($1), never ANALYZE', () => {
        const q = buildPlatformExplainQuery({ sql: SQL });
        expect(q.sql).toBe(PLATFORM_EXPLAIN_SQL);
        expect(q.sql).not.toContain('orders');
        expect(q.sql).not.toMatch(/\bANALYZE\b/i);
        expect(q.params).toEqual([SQL]);
    });

    it('uses the caller description, or a generated one when missing or blank', () => {
        expect(buildPlatformExplainQuery({ sql: SQL, description: 'Why slow' }).description).toBe('Why slow');
        expect(buildPlatformExplainQuery({ sql: SQL }).description).toBe(GENERATED_EXPLAIN_DESCRIPTION);
        expect(buildPlatformExplainQuery({ sql: SQL, description: '  ' }).description).toBe(GENERATED_EXPLAIN_DESCRIPTION);
    });

    it('defaults advise to true', () => {
        expect(buildPlatformExplainQuery({ sql: SQL }).advise).toBe(true);
        expect(buildPlatformExplainQuery({ sql: SQL, advise: false }).advise).toBe(false);
    });

    it.each([
        ['a missing sql', {}],
        ['a blank sql', { sql: ' \n ' }],
        ['a non-string description', { sql: SQL, description: 5 }],
        ['a non-boolean advise', { sql: SQL, advise: 'yes' }],
    ])('refuses %s', (_label, args) => {
        expect(() => buildPlatformExplainQuery(args)).toThrow(ToolInputError);
    });
});

describe('planOf', () => {
    it('returns a parsed json cell as is', () => {
        expect(planOf({ columns: ['plan'], rows: [{ plan: PLAN }], truncated: false })).toEqual(PLAN);
    });

    it('parses a plan that arrives as JSON text, and keeps other text', () => {
        expect(planOf({ columns: ['plan'], rows: [{ plan: JSON.stringify(PLAN) }], truncated: false })).toEqual(PLAN);
        expect(planOf({ columns: ['plan'], rows: [{ plan: 'Seq Scan' }], truncated: false })).toBe('Seq Scan');
    });

    it('throws when the engine returned no plan', () => {
        expect(() => planOf({ columns: ['plan'], rows: [], truncated: false })).toThrow();
    });
});

describe('platformExplainResult', () => {
    it('returns the plan as structured content and text', () => {
        const r = platformExplainResult({ plan: PLAN, advice: null }, 10_000);
        expect(r.isError).toBeUndefined();
        expect(r.structuredContent).toEqual({ plan: PLAN, advice: null });
        expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ plan: PLAN, advice: null });
    });

    it('refuses a plan larger than the output cap', () => {
        const r = platformExplainResult({ plan: PLAN, advice: null }, 20);
        expect(r.isError).toBe(true);
        expect(r.structuredContent).toBeUndefined();
    });
});
