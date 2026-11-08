import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SECRET, identityOf, queriesMatching, startHarness, type Harness } from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';
import { requestText, ScriptedLlm, toolUse } from './helpers/llm';
import { answered, installPlatformCatalog, ORDERS_COUNT_SQL } from './helpers/platform';

const QUESTION = 'How many orders are there in total?';
const llm = new ScriptedLlm();

let h: Harness;
beforeAll(async () => {
    h = await startHarness({ llm });
    installPlatformCatalog(h.engine);
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('ask_data (port of the portal data assistant)', () => {
    it('answers from an audited read-only query run through the engine', async () => {
        llm.push(
            toolUse('run_sql', { sql: ORDERS_COUNT_SQL, purpose: 'Count all orders' }),
            toolUse('submit_answer', answered('There are **42** orders.')),
        );
        const r = await h.call('ask_data', { question: QUESTION });
        expect(r.isError, r.text).toBe(false);
        const res = r.structured;
        expect(res.question).toBe(QUESTION);
        expect(res.database).toBe('platform');
        expect(typeof res.askId).toBe('string');
        expect(res.answer.status).toBe('answered');
        expect(res.answer.answer).toContain('42');
        expect(res.answer.evidenceQueries).toEqual([1]);
        expect(res.queries).toHaveLength(1);
        expect(res.queries[0]).toMatchObject({ index: 1, status: 'ok', sql: ORDERS_COUNT_SQL, columns: ['n'] });
        expect(Number(res.queries[0].rows[0].n)).toBe(42);
        expect(res.usage.steps).toBe(2);
    });

    it('offers the model the portal tools, with the catalog from platform_tables()', () => {
        const first = llm.requests[0]!;
        const names = ((first.tools as { name: string }[]) ?? []).map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['search_schema', 'describe_tables', 'run_sql', 'submit_answer']));
        expect(requestText(first)).toContain('orders');
        expect(queriesMatching(h.engine, /\bplatform_tables\s*\(/i).length).toBeGreaterThan(0);
    });

    it('runs the model SQL inside platform_query as a parameter, audited with the question and source mcp', () => {
        const runs = queriesMatching(h.engine, /\bplatform_query\s*\(/i).filter((q) =>
            q.params.some((p) => p?.includes(ORDERS_COUNT_SQL)),
        );
        expect(runs.length).toBe(1);
        expect(runs[0]!.sql).not.toContain('FROM orders');
        const id = verifyIdentityToken(identityOf(runs[0]!), IDENTITY_SECRET);
        expect(id.agent).toBe(true);
        expect(id.audit.source).toBe('mcp');
        expect(id.audit.description).toContain(QUESTION);
    });

    it('rejects an empty question and one over 1000 characters, without calling the model', async () => {
        const before = llm.requests.length;
        expect((await h.call('ask_data', { question: '' })).isError).toBe(true);
        expect((await h.call('ask_data', { question: 'x'.repeat(1001) })).isError).toBe(true);
        expect(llm.requests.length).toBe(before);
    });

    it('sends earlier turns as context for a follow-up', async () => {
        llm.push(toolUse('run_sql', { sql: ORDERS_COUNT_SQL, purpose: 'Recount' }), toolUse('submit_answer', answered('Still **42**.')));
        const r = await h.call('ask_data', {
            question: 'And now?',
            history: [{ question: QUESTION, answer: 'There are 42 orders.' }],
        });
        expect(r.isError, r.text).toBe(false);
        const msgs = JSON.stringify(llm.requests.at(-2)!.messages);
        expect(msgs).toContain(QUESTION);
        expect(msgs).toContain('And now?');
    });
});
