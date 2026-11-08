import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness';
import { requestText, ScriptedLlm, textReply } from './helpers/llm';

const PLAN = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 500000 } }];
const llm = new ScriptedLlm();

let h: Harness;
beforeAll(async () => {
    h = await startHarness({ llm });
    h.engine.on(/\bplatform_explain\s*\(/i, { columns: [{ name: 'plan', type: 'json' }], rows: [[PLAN]] });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const explain = (sql = 'SELECT * FROM orders') => h.call('platform_explain', { sql });

describe('platform_explain plan advice (port of the portal plan-advisor)', () => {
    it('parses a JSON advice response into summary, suggestions and indexes', async () => {
        llm.push(
            textReply(
                JSON.stringify({
                    summary: 'Sequential scan dominates.',
                    suggestions: [
                        { title: 'Add index', detail: 'Index orders(status).', severity: 'high', category: 'index', relation: 'orders' },
                    ],
                    indexes: [
                        {
                            table: 'orders',
                            columns: ['status'],
                            statement: 'CREATE INDEX orders_status_idx ON orders (status)',
                            rationale: 'Removes the sequential scan.',
                        },
                    ],
                }),
            ),
        );
        const r = await explain();
        expect(r.isError, r.text).toBe(false);
        const advice = r.structured.advice;
        expect(advice.summary).toBe('Sequential scan dominates.');
        expect(advice.suggestions).toHaveLength(1);
        expect(advice.suggestions[0]).toMatchObject({ title: 'Add index', severity: 'high', category: 'index', relation: 'orders' });
        expect(advice.indexes[0].statement).toBe('CREATE INDEX orders_status_idx ON orders (status)');
        expect(typeof advice.model).toBe('string');
        expect(advice.model.length).toBeGreaterThan(0);
        // The prompt carries the SQL, the plan and says it was estimate-only.
        const sent = requestText(llm.requests.at(-1)!);
        expect(sent).toContain('SELECT * FROM orders');
        expect(sent).toContain('Seq Scan');
        expect(sent).toContain('estimates only');
    });

    it('extracts the JSON object even when wrapped in prose and backticks', async () => {
        llm.push(textReply('Here you go:\n```json\n{"summary":"ok","suggestions":[]}\n```\nHope that helps!'));
        const r = await explain();
        expect(r.structured.advice.summary).toBe('ok');
        expect(r.structured.advice.suggestions).toEqual([]);
    });

    it('normalizes an unknown severity to low and defaults missing fields', async () => {
        llm.push(textReply(JSON.stringify({ summary: 's', suggestions: [{ title: 'T', severity: 'urgent' }] })));
        const r = await explain();
        expect(r.structured.advice.suggestions[0]).toMatchObject({ severity: 'low', detail: '', category: 'general' });
    });

    it('falls back to the raw text when the response is not JSON', async () => {
        llm.push(textReply('The plan looks healthy; no changes needed.'));
        const r = await explain();
        expect(r.structured.advice.summary).toBe('The plan looks healthy; no changes needed.');
        expect(r.structured.advice.suggestions).toEqual([]);
    });

    it('still returns the plan, with advice null and adviceError, when the model call fails', async () => {
        llm.push(() => {
            throw new Error('upstream overloaded');
        });
        const r = await explain();
        expect(r.isError, r.text).toBe(false);
        expect(r.structured.plan).toBeTruthy();
        expect(r.structured.advice).toBeNull();
        expect(String(r.structured.adviceError)).toMatch(/upstream overloaded|failed/i);
    });
});
