/**
 * Port of the portal's `plan-advisor.service.test.ts` (refs/db-query-portal@aea73de). The portal's jest module
 * mocks (`@anthropic-ai/sdk`, Secrets Manager, `../db/targetDb`) become an injected `LlmClient` and index lookup.
 * The first four cases are the portal's; the rest cover what the port changed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmClient, LlmRequest, LlmResponse } from './llm.js';
import {
    PLAN_CHAR_LIMIT,
    PlanAdviceError,
    collectRelations,
    createPlanAdvisor,
    resolveModel,
    type ExistingIndexLookup,
} from './plan-advisor.service.js';

const create = vi.fn<(params: LlmRequest) => Promise<LlmResponse>>();
const llm: LlmClient = { createMessage: create };
const existingIndexes = vi.fn<ExistingIndexLookup>(async () => []);
const { advisePlan } = createPlanAdvisor({ llm, existingIndexes });

const plan = { 'Node Type': 'Seq Scan', 'Relation Name': 'patients', 'Plan Rows': 500000 };

function mockResponse(text: string) {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } });
}

function sentUserContent(): string {
    const req = create.mock.calls[0]?.[0];
    const content = req?.messages[0]?.content;
    return typeof content === 'string' ? content : JSON.stringify(content);
}

describe('advisePlan', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('parses a JSON advice response into summary + suggestions', async () => {
        mockResponse(
            JSON.stringify({
                summary: 'Sequential scan dominates.',
                suggestions: [
                    {
                        title: 'Add index',
                        detail: 'Create an index on patients(full_name).',
                        severity: 'high',
                        category: 'index',
                    },
                ],
            }),
        );

        const advice = await advisePlan({ sql: 'SELECT * FROM patients', analyze: false, plan });

        expect(advice.summary).toBe('Sequential scan dominates.');
        expect(advice.suggestions).toHaveLength(1);
        expect(advice.suggestions[0]).toMatchObject({
            title: 'Add index',
            severity: 'high',
            category: 'index',
        });
        expect(advice.model).toBe('claude-haiku-4-5-20251001');
        // The prompt carries the SQL + plan JSON.
        expect(JSON.stringify(create.mock.calls[0]?.[0])).toContain('SELECT * FROM patients');
    });

    it('extracts the JSON object even when wrapped in prose/backticks', async () => {
        mockResponse('Here you go:\n```json\n{"summary":"ok","suggestions":[]}\n```\nHope that helps!');
        const advice = await advisePlan({ sql: 'SELECT 1', analyze: true, plan });
        expect(advice.summary).toBe('ok');
        expect(advice.suggestions).toEqual([]);
    });

    it('normalizes an unknown severity to low and defaults missing fields', async () => {
        mockResponse(JSON.stringify({ summary: 's', suggestions: [{ title: 'T', severity: 'urgent' }] }));
        const advice = await advisePlan({ sql: 'SELECT 1', analyze: false, plan });
        expect(advice.suggestions[0]?.severity).toBe('low');
        expect(advice.suggestions[0]?.detail).toBe('');
        expect(advice.suggestions[0]?.category).toBe('general');
    });

    it('falls back to raw text when the response is not JSON', async () => {
        mockResponse('The plan looks healthy; no changes needed.');
        const advice = await advisePlan({ sql: 'SELECT 1', analyze: false, plan });
        expect(advice.summary).toBe('The plan looks healthy; no changes needed.');
        expect(advice.suggestions).toEqual([]);
    });

    it('sends the system prompt, default max_tokens and an estimate-only user message', async () => {
        mockResponse('{"summary":"ok"}');
        await advisePlan({ sql: 'SELECT 1', plan });
        const req = create.mock.calls[0]?.[0];
        expect(req?.max_tokens).toBe(1200);
        expect(req?.system).toContain('senior PostgreSQL performance engineer');
        expect(req?.messages).toHaveLength(1);
        expect(req?.messages[0]?.role).toBe('user');
        const content = sentUserContent();
        expect(content).toContain('EXPLAIN (estimates only)');
        expect(content).toContain('Seq Scan');
        expect(content).toContain('Tables (patients) currently have no indexes.');
        expect(existingIndexes).toHaveBeenCalledWith(['patients']);
    });

    it('lists existing indexes, and degrades when the lookup fails or is absent', async () => {
        existingIndexes.mockResolvedValueOnce([
            { tablename: 'patients', indexdef: 'CREATE INDEX patients_pkey ON patients (id)' },
        ]);
        mockResponse('{"summary":"ok"}');
        await advisePlan({ sql: 'SELECT 1', plan });
        expect(sentUserContent()).toContain('patients: CREATE INDEX patients_pkey ON patients (id)');

        vi.clearAllMocks();
        existingIndexes.mockRejectedValueOnce(new Error('no access'));
        mockResponse('{"summary":"ok"}');
        await advisePlan({ sql: 'SELECT 1', plan });
        expect(sentUserContent()).toContain('(existing indexes could not be read)');

        vi.clearAllMocks();
        mockResponse('{"summary":"ok"}');
        await createPlanAdvisor({ llm }).advisePlan({ sql: 'SELECT 1', plan });
        expect(sentUserContent()).toContain('(existing indexes could not be read)');
    });

    it('keeps index suggestions with a statement and drops those without', async () => {
        mockResponse(
            JSON.stringify({
                summary: 's',
                suggestions: [{ title: 'T', severity: 'medium', category: 'index', relation: 'patients' }],
                indexes: [
                    { table: 'patients', columns: ['status'], statement: ' CREATE INDEX p_s ON patients (status) ', rationale: 'r' },
                    { table: 'patients', columns: ['x'], statement: '' },
                ],
            }),
        );
        const advice = await advisePlan({ sql: 'SELECT 1', plan });
        expect(advice.suggestions[0]).toEqual({
            title: 'T',
            detail: '',
            severity: 'medium',
            category: 'index',
            relation: 'patients',
        });
        expect(advice.indexes).toEqual([
            { table: 'patients', columns: ['status'], statement: 'CREATE INDEX p_s ON patients (status)', rationale: 'r' },
        ]);
    });

    it('truncates a plan longer than PLAN_CHAR_LIMIT', async () => {
        mockResponse('{"summary":"ok"}');
        const big = { 'Node Type': 'Seq Scan', Filter: 'x'.repeat(PLAN_CHAR_LIMIT * 2) };
        await advisePlan({ sql: 'SELECT 1', plan: big });
        const content = sentUserContent();
        expect(content).toContain('… (truncated)');
        expect(content.length).toBeLessThan(PLAN_CHAR_LIMIT + 1000);
    });

    it('honors a curated model and ignores any other requested model', async () => {
        mockResponse('{"summary":"ok"}');
        const a = await advisePlan({ sql: 'SELECT 1', plan, model: 'claude-sonnet-4-6' });
        expect(a.model).toBe('claude-sonnet-4-6');
        expect(create.mock.calls[0]?.[0].model).toBe('claude-sonnet-4-6');
        expect(resolveModel('some-other-model')).toBe('claude-haiku-4-5-20251001');
        expect(resolveModel(undefined, 'configured-default')).toBe('configured-default');
    });

    it('throws a 503 PlanAdviceError when no model client is configured', async () => {
        const err = await createPlanAdvisor({ llm: null })
            .advisePlan({ sql: 'SELECT 1', plan })
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PlanAdviceError);
        expect((err as PlanAdviceError).status).toBe(503);
        expect((err as PlanAdviceError).message).toMatch(/not configured/);
    });

    it('wraps a failing model call in a 502 PlanAdviceError', async () => {
        create.mockRejectedValueOnce(new Error('upstream overloaded'));
        const err = await advisePlan({ sql: 'SELECT 1', plan }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PlanAdviceError);
        expect((err as PlanAdviceError).status).toBe(502);
        expect((err as PlanAdviceError).message).toBe('AI suggestion request failed: upstream overloaded');
    });
});

describe('collectRelations', () => {
    it('finds tables in nested plans and in a FORMAT JSON result', () => {
        const tree = {
            'Node Type': 'Hash Join',
            Plans: [
                { 'Node Type': 'Seq Scan', 'Relation Name': 'orders' },
                { 'Node Type': 'Hash', Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'patients' }] },
            ],
        };
        expect(collectRelations(tree)).toEqual(['orders', 'patients']);
        expect(collectRelations([{ Plan: tree }])).toEqual(['orders', 'patients']);
        expect(collectRelations(null)).toEqual([]);
    });
});
