import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queriesMatching, startHarness, type Harness } from './helpers/harness';
import { ScriptedLlm, textReply, toolUse } from './helpers/llm';
import { installPlatformCatalog, ORDERS_COUNT_SQL } from './helpers/platform';

const llm = new ScriptedLlm();

let h: Harness;
beforeAll(async () => {
    h = await startHarness({ llm, env: { MCP_ASK_MAX_STEPS: '4' } });
    installPlatformCatalog(h.engine);
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const platformRuns = () => queriesMatching(h.engine, /\bplatform_query\s*\(/i).length;

describe('ask_data abstentions and guard rails', () => {
    it('passes an abstention through with its reason and what would help, running no query', async () => {
        const before = platformRuns();
        llm.push(
            toolUse('submit_answer', {
                status: 'abstained',
                answer: 'Changing data is not something I can do.',
                confidence: 'high',
                basis: 'none',
                abstain_reason: 'unsafe_request',
                what_would_help: ['Use Write Mode in Investigate.'],
            }),
        );
        const r = await h.call('ask_data', { question: 'Delete all cancelled orders' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.answer.status).toBe('abstained');
        expect(r.structured.answer.abstainReason).toBe('unsafe_request');
        expect(r.structured.answer.whatWouldHelp).toEqual(['Use Write Mode in Investigate.']);
        expect(platformRuns()).toBe(before);
    });

    it('downgrades an "answered" result that cites no successful query', async () => {
        llm.push(
            toolUse('submit_answer', {
                status: 'answered',
                answer: 'There are **7** orders.',
                confidence: 'high',
                basis: 'query_results',
                evidence_queries: [1],
            }),
            toolUse('submit_answer', {
                status: 'answered',
                answer: 'There are **7** orders.',
                confidence: 'high',
                basis: 'query_results',
                evidence_queries: [1],
            }),
            toolUse('submit_answer', {
                status: 'answered',
                answer: 'There are **7** orders.',
                confidence: 'high',
                basis: 'query_results',
                evidence_queries: [1],
            }),
        );
        const r = await h.call('ask_data', { question: 'How many orders?' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.answer.status).toBe('abstained');
        expect(r.structured.answer.abstainReason).toBe('unsupported_answer');
    });

    it('abstains with budget_exceeded when the model never submits within the step budget', async () => {
        // MCP_ASK_MAX_STEPS=4: exactly four model calls, then an abstention.
        for (let i = 0; i < 4; i += 1) llm.push(textReply('Let me think more about this.'));
        const before = llm.requests.length;
        const r = await h.call('ask_data', { question: 'How many orders?' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.answer.status).toBe('abstained');
        expect(r.structured.answer.abstainReason).toBe('budget_exceeded');
        expect(r.structured.usage.steps).toBe(4);
        expect(llm.requests.length - before).toBe(4);
    });

    it('records a failed query and lets the model recover', async () => {
        llm.push(
            toolUse('run_sql', { sql: 'SELECT count(*) FROM no_such_table', purpose: 'Try a table' }),
            toolUse('run_sql', { sql: ORDERS_COUNT_SQL, purpose: 'Count orders' }),
            toolUse('submit_answer', {
                status: 'answered',
                answer: 'There are **42** orders.',
                confidence: 'medium',
                basis: 'query_results',
                evidence_queries: [2],
            }),
        );
        const r = await h.call('ask_data', { question: 'How many orders?' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.queries.map((q: { status: string }) => q.status)).toEqual(['error', 'ok']);
        expect(r.structured.answer.status).toBe('answered');
    });
});
