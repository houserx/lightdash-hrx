import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness';
import { requestText, ScriptedLlm, toolUse } from './helpers/llm';
import { answered, installPlatformCatalog, ORDERS_COUNT_SQL } from './helpers/platform';

const llm = new ScriptedLlm();

let h: Harness;
beforeAll(async () => {
    h = await startHarness({ llm });
    installPlatformCatalog(h.engine);
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('ask_data answer verification (port of answer-verification.ts)', () => {
    it('sends back an answer whose figures its queries cannot support, then accepts the fix', async () => {
        const start = llm.requests.length;
        llm.push(
            toolUse('run_sql', { sql: ORDERS_COUNT_SQL, purpose: 'Count orders' }),
            toolUse('submit_answer', answered('There are **97** orders.')),
            toolUse('submit_answer', answered('There are **42** orders.')),
        );
        const r = await h.call('ask_data', { question: 'How many orders are there?' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.answer.status).toBe('answered');
        expect(r.structured.answer.answer).toContain('42');
        expect(r.structured.answer.confidence).toBe('high');
        // The model was told which figure was unsupported.
        const third = llm.requests[start + 2]!;
        expect(requestText(third)).toContain('97');
        expect(requestText(third)).toMatch(/Rejected/);
    });

    it('keeps a still-unverified answer but marks it low confidence with the figures called out', async () => {
        llm.push(
            toolUse('run_sql', { sql: ORDERS_COUNT_SQL, purpose: 'Count orders' }),
            toolUse('submit_answer', answered('There are **97** orders.')),
            toolUse('submit_answer', answered('There are **97** orders.')),
            toolUse('submit_answer', answered('There are **97** orders.')),
        );
        const r = await h.call('ask_data', { question: 'How many orders are there?' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.answer.status).toBe('answered');
        expect(r.structured.answer.confidence).toBe('low');
        expect(r.structured.answer.caveats.join(' ')).toContain('97');
    });

    it('accepts figures that are plain arithmetic over the results', async () => {
        llm.push(
            toolUse('run_sql', { sql: ORDERS_COUNT_SQL, purpose: 'Count orders' }),
            toolUse('submit_answer', answered('There are **42** orders, so **84** with the mirror set.')),
        );
        const r = await h.call('ask_data', { question: 'How many orders are there?' });
        expect(r.structured.answer.confidence).toBe('high');
        expect(r.structured.answer.caveats).toEqual([]);
    });
});
