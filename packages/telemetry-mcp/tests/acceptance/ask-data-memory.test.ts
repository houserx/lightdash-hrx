import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startHarness, type Harness } from './helpers/harness';
import { requestText, ScriptedLlm, toolUse } from './helpers/llm';
import { answered, installPlatformCatalog, ORDERS_COUNT_SQL } from './helpers/platform';

const llm = new ScriptedLlm();
let store: { listNotes(db: string, o?: { includeHidden?: boolean }): Promise<Record<string, unknown>[]> };

let h: Harness;
beforeAll(async () => {
    store = new api.InMemoryAskMemoryStore();
    h = await startHarness({ llm, askMemoryStore: store });
    installPlatformCatalog(h.engine);
}, 30_000);
afterAll(async () => {
    await h?.close();
});

let learnedId = '';

describe('ask_data team memory (port of ask-memory.service.ts)', () => {
    it('stores vetted lessons from a grounded answer and screens out PHI-shaped ones', async () => {
        llm.push(
            toolUse('run_sql', { sql: ORDERS_COUNT_SQL, purpose: 'Count orders' }),
            toolUse(
                'submit_answer',
                answered('There are **42** orders.', {
                    learnings: [
                        {
                            kind: 'definition',
                            topic: 'active order status',
                            insight: 'Orders count as active when status is open or processing.',
                        },
                        {
                            kind: 'gotcha',
                            topic: 'order owner contact',
                            insight: 'Ask jane.doe@example.test about orders before changing them.',
                        },
                    ],
                }),
            ),
        );
        const r = await h.call('ask_data', { question: 'How many orders are there?' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.memory.enabled).toBe(true);
        expect(r.structured.memory.learned).toHaveLength(1);
        expect(r.structured.memory.learned[0]).toMatchObject({ kind: 'definition', topic: 'active order status' });
        learnedId = r.structured.memory.learned[0].id;
        const notes = await store.listNotes('platform');
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({ id: learnedId, database: 'platform', createdByEmail: 'analyst@example.test' });
        expect(JSON.stringify(notes)).not.toContain('jane.doe');
    });

    it('recalls the note for a related question, as an unverified hint in the prompt', async () => {
        const start = llm.requests.length;
        llm.push(
            toolUse('run_sql', { sql: ORDERS_COUNT_SQL, purpose: 'Count orders' }),
            toolUse('submit_answer', answered('There are **42** active orders.')),
        );
        const r = await h.call('ask_data', { question: 'How many active orders are open?' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.memory.recalled.map((n: { id: string }) => n.id)).toContain(learnedId);
        const prompt = requestText(llm.requests[start]!);
        expect(prompt).toContain('Team memory');
        expect(prompt).toContain('Orders count as active when status is open or processing.');
    });

    it('credits a recalled note that backed a grounded answer', async () => {
        const notes = await store.listNotes('platform');
        expect(notes.find((n) => n.id === learnedId)?.uses).toBe(1);
    });

    it('learns nothing from an abstention', async () => {
        llm.push(
            toolUse('submit_answer', {
                status: 'abstained',
                answer: 'Not answerable.',
                confidence: 'low',
                basis: 'none',
                abstain_reason: 'schema_gap',
                learnings: [{ kind: 'definition', topic: 'refund policy', insight: 'Refunds are stored nowhere in this schema.' }],
            }),
        );
        const r = await h.call('ask_data', { question: 'What is the refund policy?' });
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.memory.learned).toEqual([]);
        expect(await store.listNotes('platform')).toHaveLength(1);
    });
});
