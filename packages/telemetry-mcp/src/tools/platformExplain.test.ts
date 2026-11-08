import { describe, expect, it, vi } from 'vitest';
import type { LlmClient, LlmResponse } from '../ask/llm.js';
import {
    ADVICE_NOT_CONFIGURED,
    ADVICE_TOO_LARGE,
    GENERATED_EXPLAIN_DESCRIPTION,
    PLATFORM_EXPLAIN_SQL,
    adviseOnPlan,
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

const reply = (text: string): LlmResponse => ({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1, output_tokens: 1 },
});
const llmOf = (impl: LlmClient['createMessage']): LlmClient => ({ createMessage: vi.fn(impl) });

describe('adviseOnPlan', () => {
    it('returns the parsed advice and sends the SQL, the plan and "estimates only"', async () => {
        const llm = llmOf(async () => reply('{"summary":"Seq scan","suggestions":[],"indexes":[]}'));
        const r = await adviseOnPlan(llm, SQL, PLAN, []);
        expect(r.adviceError).toBeUndefined();
        expect(r.advice).toMatchObject({ summary: 'Seq scan', suggestions: [], indexes: [] });
        expect(r.advice?.model).toBeTruthy();
        const sent = JSON.stringify(vi.mocked(llm.createMessage).mock.calls[0]![0]);
        expect(sent).toContain('orders');
        expect(sent).toContain('Seq Scan');
        expect(sent).toContain('estimates only');
    });

    it('returns advice null with the not-configured reason, and calls nothing, without a client', async () => {
        expect(await adviseOnPlan(undefined, SQL, PLAN, [])).toEqual({ advice: null, adviceError: ADVICE_NOT_CONFIGURED });
    });

    it('returns advice null with the model error, secrets and tokens redacted, when the call fails', async () => {
        const llm = llmOf(async () => {
            throw new Error('upstream overloaded for sk-ant-secret and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig');
        });
        const r = await adviseOnPlan(llm, SQL, PLAN, ['sk-ant-secret']);
        expect(r.advice).toBeNull();
        expect(r.adviceError).toMatch(/^AI suggestion request failed: upstream overloaded/);
        expect(r.adviceError).not.toContain('sk-ant-secret');
        expect(r.adviceError).not.toContain('eyJ');
    });
});

describe('platformExplainResult with advice', () => {
    const advice = { summary: 'x'.repeat(500), suggestions: [], indexes: [], model: 'm' };

    it('keeps advice that fits', () => {
        const r = platformExplainResult({ plan: PLAN, advice }, 10_000);
        expect(r.structuredContent).toEqual({ plan: PLAN, advice });
    });

    it('drops advice that would pass the output cap, keeping the plan', () => {
        const r = platformExplainResult({ plan: PLAN, advice }, 300);
        expect(r.isError).toBeUndefined();
        expect(r.structuredContent).toEqual({ plan: PLAN, advice: null, adviceError: ADVICE_TOO_LARGE });
    });
});
