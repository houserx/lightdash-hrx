import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SECRET, startHarness, type Harness } from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';
import { requestText, ScriptedLlm, toolUse } from './helpers/llm';
import { installPlatformCatalog } from './helpers/platform';

const llm = new ScriptedLlm();
const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();

function execution(id: string, sql: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        sql,
        mode: 'read',
        description: 'synthetic',
        database: 'platform',
        executedByEmail: `${id}@example.test`,
        executedBySub: `sub-${id}`,
        status: 'success',
        rowCount: 3,
        durationMs: 12,
        errorMessage: null,
        preview: false,
        action: 'query',
        integrityHash: 'not-a-real-hash',
        createdAt: recent,
        createdAtMonth: recent.slice(0, 7),
        ...extra,
    };
}

let h: Harness;
beforeAll(async () => {
    h = await startHarness({ llm });
    installPlatformCatalog(h.engine);
    h.engine.onHttp('GET', '/v1/audit', {
        status: 200,
        body: {
            items: [
                execution('e1', "SELECT status, count(*) FROM orders WHERE status = 'SECRET-LITERAL-1' GROUP BY 1"),
                execution('e2', "SELECT status, count(*) FROM orders WHERE status = 'SECRET-LITERAL-2' GROUP BY 1"),
                execution('e3', 'SELECT * FROM fills', { mode: 'write' }),
                execution('e4', 'SELECT * FROM orders o JOIN fills f ON f.order_id = o.id', { status: 'error' }),
                execution('e5', 'SELECT * FROM orders', { database: 'some-other-db' }),
            ],
            nextCursor: null,
        },
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('ask_data example queries (port of example-queries.service.ts)', () => {
    it('shows the model teammates\' past successful reads, literals scrubbed, from the engine audit browser', async () => {
        const start = llm.requests.length;
        llm.push(
            toolUse('find_example_queries', { keywords: 'orders status' }),
            toolUse('submit_answer', {
                status: 'abstained',
                answer: 'Need more detail.',
                confidence: 'low',
                basis: 'none',
                abstain_reason: 'ambiguous_question',
            }),
        );
        const r = await h.call('ask_data', { question: 'Which order statuses are common?' });
        expect(r.isError, r.text).toBe(false);
        const shown = requestText(llm.requests[start + 1]!);
        expect(shown).toContain('FROM orders');
        expect(shown).toContain("'?'");
        expect(shown).not.toContain('SECRET-LITERAL');
        // Merged into one shape, run by two people; writes, failures and other databases are skipped.
        expect(shown).toMatch(/2 people/);
        expect(shown).not.toContain('JOIN fills');
        expect(shown).not.toContain('some-other-db');
    });

    it('reads examples from GET /v1/audit with the caller\'s identity token', () => {
        const calls = h.engine.httpRequests.filter((r) => r.method === 'GET' && r.path === '/v1/audit');
        expect(calls.length).toBeGreaterThan(0);
        const auth = String(calls[0]!.headers.authorization ?? '');
        expect(auth.startsWith('Bearer ')).toBe(true);
        const id = verifyIdentityToken(auth.slice(7), IDENTITY_SECRET);
        expect(id.iss).toBe('telemetry-mcp');
        expect(id.agent).toBe(true);
    });
});
