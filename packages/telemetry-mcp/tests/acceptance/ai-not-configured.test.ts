import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queriesMatching, startHarness, type Harness } from './helpers/harness';
import { installPlatformCatalog } from './helpers/platform';

let h: Harness;
beforeAll(async () => {
    // No deps.llm and no ANTHROPIC_API_KEY: the AI features must degrade clearly.
    h = await startHarness({ env: { ANTHROPIC_API_KEY: undefined } });
    installPlatformCatalog(h.engine);
    h.engine.on(/\bplatform_explain\s*\(/i, { columns: [{ name: 'plan', type: 'json' }], rows: [[[{ Plan: { 'Node Type': 'Result' } }]]] });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('AI features without an LLM configured', () => {
    it('ask_data fails clearly and runs no Platform Database query', async () => {
        const r = await h.call('ask_data', { question: 'How many orders are there?' });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/not configured/i);
        expect(queriesMatching(h.engine, /\bplatform_query\s*\(/i)).toHaveLength(0);
    });

    it('platform_explain still returns the plan, with advice null and a not-configured adviceError', async () => {
        const r = await h.call('platform_explain', { sql: 'SELECT 1' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.plan).toBeTruthy();
        expect(r.structured.advice).toBeNull();
        expect(String(r.structured.adviceError)).toMatch(/not configured/i);
    });
});
