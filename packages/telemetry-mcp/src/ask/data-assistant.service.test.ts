/**
 * Port of the portal's `api/src/services/data-assistant.service.test.ts` (`refs/db-query-portal@aea73de`).
 *
 * The 33 portal cases, in the portal's order, with jest replaced by vitest and the module mocks replaced by the
 * injected interfaces: a scripted `LlmClient` (`create`), a fake `EngineClient` that answers `platform_tables()`,
 * `platform_columns($1, $2)` and `platform_query($1)`, an `AskMemoryService` over a mocked `AskMemoryStore`, and a
 * stub `ExampleQueries`. Portal env tweaks become `createDataAssistant` options.
 *
 * The portal asserted its own pool steps (`BEGIN READ ONLY`, `ROLLBACK`, `DISCARD ALL`) and its own audit writer
 * (`recordExecution`). Audit is engine-side here (CONTRACTS §6), so those assertions became: the model SQL travels
 * only as the bind parameter of `platform_query($1)`, every engine read carries the audit description (model and
 * question), a statement rejected before the engine never reaches it, and an engine audit-write failure (SQLSTATE
 * 58000) fails the ask with status 500 before any row reaches the model. The catalog has no foreign keys through the
 * engine, so `find_join_path` answers with the naming-convention hint instead of join conditions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineError, type EngineClient, type EngineQueryOptions, type EngineResult } from '../engine/client.js';
import type { AskMemoryStore, MemoryNote } from './ask-memory-store.js';
import { createAskMemoryService, type AskMemoryService } from './ask-memory.service.js';
import {
    AskError,
    DATA_ASSISTANT_DEFAULTS,
    createDataAssistant,
    elideOldToolResults,
    normalizeAnswer,
    type AskContext,
    type AskInput,
    type DataAssistantOptions,
} from './data-assistant.service.js';
import type { ExampleQueries } from './example-queries.service.js';
import type { LlmCallOptions, LlmRequest, LlmResponse } from './llm.js';

interface CreateParams {
    model: string;
    thinking?: unknown;
    temperature?: unknown;
    tool_choice?: unknown;
    system: { type: string; text: string }[];
    tools: { name: string }[];
    messages: { role: string; content: unknown }[];
}
const create = vi.fn<(params: LlmRequest, options?: LlmCallOptions) => Promise<LlmResponse>>();
const nthCall = (i: number): CreateParams => {
    const call = create.mock.calls[i];
    if (!call) throw new Error(`messages.create call ${i} did not happen`);
    return call[0] as unknown as CreateParams;
};

type EngineCall = [sql: string, params?: readonly unknown[], options?: EngineQueryOptions];
const engineQuery = vi.fn<(...args: EngineCall) => Promise<EngineResult>>();
const engine: EngineClient = { query: (...args: EngineCall) => engineQuery(...args) };

const listNotes = vi.fn();
const upsertNote = vi.fn();
const touchNotes = vi.fn();
const voteNote = vi.fn();
const store = {
    listNotes,
    upsertNote,
    touchNotes,
    voteNote,
    getNote: vi.fn(),
    deleteNote: vi.fn(),
} as unknown as AskMemoryStore;
const findExampleQueries = vi.fn<(database: string, keywords: string) => Promise<string>>();
const examples: ExampleQueries = {
    findExampleQueries: (database, keywords) => findExampleQueries(database, keywords),
    resetExamplesCache: () => undefined,
};
let memory: AskMemoryService;

const user = { sub: 'user-0001', email: 'support@example.com' };

const usage = { input_tokens: 10, output_tokens: 5 };
const toolUse = (name: string, input: Record<string, unknown>, id = `tu_${name}`): LlmResponse => ({
    content: [{ type: 'tool_use', id, name, input }],
    usage,
});
const submit = (input: Record<string, unknown>) => toolUse('submit_answer', input);

// Engine answers, keyed by the §1.1 table function in the statement.
let queryRows: Record<string, unknown>[] = [];
let tableRows: Record<string, unknown>[] = [];
let columnRows: Record<string, unknown>[] = [];
let platformQuery: (sql: string) => Promise<EngineResult>;

const result = (rows: Record<string, unknown>[]): EngineResult => ({
    columns: Object.keys(rows[0] ?? {}),
    rows,
    truncated: false,
});
const engineError = (message: string, code: string | undefined) => new EngineError(message, code);

const engineCalls = () => engineQuery.mock.calls as EngineCall[];
const platformQueryCalls = () => engineCalls().filter((c) => /\bplatform_query\(/.test(c[0]));
/** The model SQL each platform_query call carried (its bind parameter). */
const runSqlParams = () => platformQueryCalls().map((c) => String(c[1]?.[0]));

beforeEach(() => {
    memory = createAskMemoryService({ store });
    listNotes.mockResolvedValue([]);
    touchNotes.mockResolvedValue(undefined);
    voteNote.mockResolvedValue({});
    upsertNote.mockImplementation((i: Record<string, unknown>) =>
        Promise.resolve({
            id: 'a'.repeat(32),
            status: 'active',
            uses: 0,
            upvotes: 0,
            downvotes: 0,
            confirmations: 1,
            createdAt: 'now',
            updatedAt: 'now',
            lastUsedAt: 'now',
            expiresAt: 0,
            ...i,
        }),
    );
    findExampleQueries.mockResolvedValue('No similar past queries found.');
    queryRows = [{ n: 7 }];
    tableRows = [{ table_schema: 'public', table_name: 'orders' }];
    columnRows = [
        { column_name: 'id', data_type: 'bigint', is_nullable: false },
        { column_name: 'status', data_type: 'text', is_nullable: false },
    ];
    platformQuery = () => Promise.resolve(result(queryRows));
    engineQuery.mockImplementation((sql: string, params?: readonly unknown[]) => {
        if (/\bplatform_tables\(/.test(sql)) return Promise.resolve(result(tableRows));
        if (/\bplatform_columns\(/.test(sql)) return Promise.resolve(result(columnRows));
        if (/\bplatform_query\(/.test(sql)) return platformQuery(String(params?.[0]));
        return Promise.reject(engineError('fake engine: no handler for statement', 'XX000'));
    });
});

afterEach(() => {
    vi.clearAllMocks();
    create.mockReset();
});

const assistant = (overrides: Partial<DataAssistantOptions> = {}) =>
    createDataAssistant({ llm: { createMessage: create }, engine, memory, examples, ...overrides });

const askData = (input: AskInput, overrides: Partial<DataAssistantOptions> = {}) =>
    assistant(overrides).askData(input);

const ask = (question = 'How many open orders?', overrides: Partial<DataAssistantOptions> = {}) =>
    askData({ question, database: 'platform', user }, overrides);

describe('askData', () => {
    it('runs an audited read-only query and returns a grounded answer', async () => {
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT count(*) AS n FROM orders;', purpose: 'count orders' }))
            .mockResolvedValueOnce(
                submit({
                    status: 'answered',
                    answer: 'There are 7 open orders.',
                    confidence: 'high',
                    basis: 'query_results',
                    evidence_queries: [1],
                    assumptions: ['open = not closed'],
                }),
            );

        const res = await ask();

        expect(res.answer).toMatchObject({
            status: 'answered',
            confidence: 'high',
            evidenceQueries: [1],
            assumptions: ['open = not closed'],
        });
        expect(res.queries).toHaveLength(1);
        expect(res.queries[0]).toMatchObject({ status: 'ok', rows: [{ n: 7 }] });
        // The model SQL is the only bind parameter of platform_query, never part of the statement text.
        const [call] = platformQueryCalls();
        expect(call?.[0]).toBe('SELECT * FROM platform_query($1)');
        expect(call?.[1]).toEqual(['SELECT * FROM (\nSELECT count(*) AS n FROM orders\n) AS _ask LIMIT 51']);
        // Audited by the engine, from the identity token's audit block.
        expect(call?.[2]?.audit).toEqual({
            description: expect.stringContaining('How many open orders?') as unknown as string,
            ticket: null,
        });
        expect(res.usage).toMatchObject({ steps: 2, inputTokens: 20, outputTokens: 10 });
    });

    it('passes an abstention through with its reason and what would help', async () => {
        create.mockResolvedValueOnce(
            submit({
                status: 'abstained',
                answer: 'No column records the fax carrier.',
                confidence: 'low',
                basis: 'none',
                abstain_reason: 'schema_gap',
                what_would_help: ['Which table stores fax carrier?'],
            }),
        );

        const res = await ask('Which carrier sent each fax?');

        expect(res.answer).toMatchObject({
            status: 'abstained',
            abstainReason: 'schema_gap',
            whatWouldHelp: ['Which table stores fax carrier?'],
        });
        expect(platformQueryCalls()).toHaveLength(0);
    });

    it('downgrades an "answered" result that cites no successful query', async () => {
        // Rejected twice (the retries), then discarded.
        create.mockResolvedValue(
            submit({
                status: 'answered',
                answer: 'There are 42 open orders.',
                confidence: 'high',
                basis: 'query_results',
                evidence_queries: [1],
            }),
        );

        const res = await ask();

        expect(res.answer.status).toBe('abstained');
        expect(res.answer.abstainReason).toBe('unsupported_answer');
        expect(res.answer.answer).not.toContain('42');
        expect(create).toHaveBeenCalledTimes(3);
    });

    it('lets the model repair bad citations instead of discarding a good answer', async () => {
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT count(*) AS n FROM orders;', purpose: 'count orders' }))
            .mockResolvedValueOnce(
                submit({
                    status: 'answered',
                    answer: 'There are 7 open orders.',
                    confidence: 'high',
                    basis: 'query_results',
                    evidence_queries: [5],
                }),
            )
            .mockResolvedValueOnce(
                submit({
                    status: 'answered',
                    answer: 'There are 7 open orders.',
                    confidence: 'high',
                    basis: 'query_results',
                    evidence_queries: [1],
                }),
            );

        const res = await ask();

        expect(res.answer).toMatchObject({ status: 'answered', evidenceQueries: [1] });
        expect(JSON.stringify(nthCall(2).messages)).toContain('Successful run_sql calls so far: 1');
    });

    it('keeps the valid citations when one cited query failed', async () => {
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'DELETE FROM orders', purpose: 'bad' }, 'a'))
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT count(*) AS n FROM orders;', purpose: 'count' }, 'b'))
            .mockResolvedValueOnce(
                submit({
                    status: 'answered',
                    answer: 'There are 7 open orders.',
                    confidence: 'medium',
                    basis: 'query_results',
                    evidence_queries: [1, 2],
                }),
            );

        const res = await ask();

        expect(res.answer).toMatchObject({ status: 'answered', evidenceQueries: [2] });
    });

    // Portal: "audits a rejected (mutating) statement without ever touching the database". The engine writes the
    // audit records now, so a statement rejected here is recorded in `queries` and never reaches the engine.
    it('rejects a mutating statement without ever reaching the engine', async () => {
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'DELETE FROM orders', purpose: 'oops' }))
            .mockResolvedValueOnce(
                submit({
                    status: 'abstained',
                    answer: 'Cannot modify data.',
                    confidence: 'low',
                    basis: 'none',
                    abstain_reason: 'unsafe_request',
                }),
            );

        const res = await ask('Delete all orders');

        expect(res.queries[0]).toMatchObject({
            status: 'error',
            sql: 'DELETE FROM orders',
            error: expect.stringContaining('Rejected') as unknown as string,
        });
        expect(platformQueryCalls()).toHaveLength(0);
        // The model was told the query failed (the messages array is shared by reference across calls).
        expect(JSON.stringify(nthCall(1).messages)).toContain('"is_error":true');
    });

    // Portal: "puts every attempted query in the audit log, tagged with the model and question".
    it('sends every query that reaches the engine with an audit description naming the model and question', async () => {
        platformQuery = () => Promise.reject(new Error('boom'));
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT 1', purpose: 'a' }, 'a'))
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT 2', purpose: 'b' }, 'b'))
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT 3', purpose: 'c' }, 'c'))
            .mockResolvedValueOnce(submit({ status: 'abstained', answer: 'x', confidence: 'low', basis: 'none' }));

        const res = await ask('How many open orders?', { maxQueries: 2 });

        // Two ran and failed; the third was over budget and rejected before the engine. All three are in `queries`.
        expect(res.queries.map((q) => [q.sql, q.status])).toEqual([
            ['SELECT 1', 'error'],
            ['SELECT 2', 'error'],
            ['SELECT 3', 'error'],
        ]);
        expect(runSqlParams().map((p) => p.split('\n')[1])).toEqual(['SELECT 1', 'SELECT 2']);
        // Every engine read of the ask (catalog and queries) carries the same audit description.
        const descriptions = engineCalls().map((c) => c[2]?.audit?.description);
        expect(descriptions.length).toBeGreaterThan(2);
        for (const d of descriptions) {
            expect(d).toContain(DATA_ASSISTANT_DEFAULTS.model);
            expect(d).toContain('How many open orders?');
        }
    });

    // Portal: "aborts, using no result, when the audit record of a rejected query cannot be saved". The engine audits
    // every catalog read too; when it cannot write that record (58000) the ask stops before the model sees anything.
    it('aborts, using no result, when the audit record of a schema lookup cannot be saved', async () => {
        engineQuery.mockImplementation((sql: string) =>
            /\bplatform_columns\(/.test(sql)
                ? Promise.reject(engineError('audit write failed', '58000'))
                : Promise.resolve(result(tableRows)),
        );
        create.mockResolvedValueOnce(toolUse('describe_tables', { tables: ['orders'] }));

        await expect(ask()).rejects.toMatchObject({ status: 500 });
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('keeps only visualizations backed by a successful query and real, numeric columns', async () => {
        queryRows = [
            { status: 'open', n: '5' },
            { status: 'closed', n: '9' },
        ];
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT status, n FROM t', purpose: 'by status' }))
            .mockResolvedValueOnce(
                submit({
                    status: 'answered',
                    answer: '**14** orders.',
                    confidence: 'high',
                    basis: 'query_results',
                    evidence_queries: [1],
                    follow_ups: ['By week?', 'a', 'b', 'c'],
                    visualizations: [
                        { type: 'bar', title: 'By status', query: 1, x: 'status', y: ['n', 'status', 'nope'] },
                        { type: 'pie', title: 'bad query', query: 7, x: 'status', y: ['n'] },
                        { type: 'bar', title: 'text y', query: 1, x: 'n', y: ['status'] },
                        { type: 'stat', title: 'Total', query: 1, value: 'n' },
                        { type: 'table', title: 'Rows', query: 1, columns: ['status', 'ghost'] },
                    ],
                }),
            );

        const { answer } = await ask();

        expect(answer.visualizations).toEqual([
            { type: 'bar', title: 'By status', query: 1, x: 'status', y: ['n'] },
            { type: 'stat', title: 'Total', query: 1, value: 'n' },
            { type: 'table', title: 'Rows', query: 1, columns: ['status'] },
        ]);
        expect(answer.followUps).toEqual(['By week?', 'a', 'b']);
    });

    it('sends prior turns as context and streams progress events', async () => {
        const events: string[] = [];
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT 1 AS n', purpose: 'probe' }))
            .mockResolvedValueOnce(submit({ status: 'abstained', answer: 'x', confidence: 'low', basis: 'none' }));

        await askData({
            question: 'And last month?',
            database: 'platform',
            user,
            history: [{ question: 'How many open orders?', answer: '7' }],
            onProgress: (e) => events.push(e.message),
        });

        const messages = nthCall(0).messages;
        expect(messages.slice(0, 3).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(messages[2]?.content).toBe('And last month?');
        expect(events).toEqual(['Running query 1: probe', 'Query 1 returned 1 row', 'Composing the answer']);
    });

    it('stops without calling the model when the caller has gone away', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            askData({ question: 'q', database: 'platform', user, signal: controller.signal }),
        ).rejects.toMatchObject({ status: 499 });
        expect(create).not.toHaveBeenCalled();
    });

    it('caps the rows shown to the model and flags that more exist', async () => {
        queryRows = Array.from({ length: DATA_ASSISTANT_DEFAULTS.maxRows + 1 }, (_, i) => ({ id: i }));
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT id FROM orders', purpose: 'list' }))
            .mockResolvedValueOnce(submit({ status: 'abstained', answer: 'Too many.', confidence: 'low', basis: 'none' }));

        const res = await ask();

        expect(res.queries[0]?.rows).toHaveLength(DATA_ASSISTANT_DEFAULTS.maxRows);
        expect(res.queries[0]?.moreRowsAvailable).toBe(true);
        // The engine is never asked for more than the cap plus the one row that tells whether more exist.
        expect(platformQueryCalls()[0]?.[2]?.maxRows).toBe(DATA_ASSISTANT_DEFAULTS.maxRows + 1);
    });

    // Engine-side: SQLSTATE 58000 means the engine could not write the audit record and withheld the rows.
    it('fails the request, and shows the model no rows, when the audit record cannot be saved', async () => {
        platformQuery = () => Promise.reject(engineError('audit write failed', '58000'));
        create.mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT 1 AS n', purpose: 'probe' }));

        const err = await ask().catch((e: unknown) => e);

        expect(err).toBeInstanceOf(AskError);
        expect(err).toMatchObject({ status: 500, message: expect.stringContaining('audit record') as unknown as string });
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('records a failed query as an error and lets the model recover', async () => {
        platformQuery = () => Promise.reject(engineError('column "nope" does not exist', '42703'));
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT nope FROM orders', purpose: 'x' }))
            .mockResolvedValueOnce(
                submit({
                    status: 'abstained',
                    answer: 'Query failed.',
                    confidence: 'low',
                    basis: 'none',
                    abstain_reason: 'query_failed',
                }),
            );

        const res = await ask();

        // It reached the engine, which audits failed attempts as well.
        expect(platformQueryCalls()).toHaveLength(1);
        expect(platformQueryCalls()[0]?.[2]?.audit?.description).toContain('How many open orders?');
        expect(res.queries[0]?.error).toContain('does not exist');
        expect(res.answer.abstainReason).toBe('query_failed');
    });

    it('abstains with budget_exceeded when the model never submits an answer', async () => {
        create.mockResolvedValue({ content: [{ type: 'text', text: 'thinking…' }], usage });

        const res = await ask();

        const maxSteps = DATA_ASSISTANT_DEFAULTS.maxSteps;
        expect(res.answer).toMatchObject({ status: 'abstained', abstainReason: 'budget_exceeded' });
        expect(create).toHaveBeenCalledTimes(maxSteps);
        // Sonnet 5.5 rejects forced tool_choice, so the last step only offers submit_answer plus a nudge.
        const last = nthCall(maxSteps - 1);
        expect(last.tools.map((t) => t.name)).toEqual(['submit_answer']);
        expect(last.tool_choice).toEqual({ type: 'auto' });
        expect(JSON.stringify(last.messages[last.messages.length - 1])).toContain('FINAL STEP');
        expect(nthCall(0).tools.length).toBeGreaterThan(1);
    });

    it('calls Sonnet 5.5 with only the parameters it accepts', async () => {
        create.mockResolvedValueOnce(submit({ status: 'abstained', answer: 'x', confidence: 'low', basis: 'none' }));

        const res = await ask();

        const params = nthCall(0);
        expect(params.model).toBe('claude-sonnet-5-5');
        expect(res.model).toBe('claude-sonnet-5-5');
        expect(params.thinking).toEqual({ type: 'between_tools' });
        expect(params).not.toHaveProperty('temperature');
        expect(params.tool_choice).toEqual({ type: 'auto' });
    });

    it('wraps upstream model failures as a 502', async () => {
        create.mockRejectedValueOnce(new Error('overloaded'));
        const err = await ask().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AskError);
        expect(err).toMatchObject({ status: 502 });
    });
});

describe('askData tools', () => {
    const answer = (text: string, evidence = [1]) =>
        submit({
            status: 'answered',
            answer: text,
            confidence: 'high',
            basis: 'query_results',
            evidence_queries: evidence,
        });

    it('samples a categorical column with a SQL-side distinct cap, through the audited query path', async () => {
        queryRows = [{ value: 'open', n: '7', distinct_values: '2' }];
        create
            .mockResolvedValueOnce(toolUse('sample_values', { table: 'orders', column: 'status' }))
            .mockResolvedValueOnce(answer('7 orders are open.'));

        const res = await ask();

        const wrapped = runSqlParams()[0];
        expect(wrapped).toMatch(/^SELECT \* FROM \(/);
        expect(wrapped).toContain('"status" AS value');
        expect(wrapped).toContain('FROM "public"."orders" GROUP BY 1');
        expect(wrapped).toContain('c.distinct_values > 25');
        expect(res.queries[0]).toMatchObject({
            status: 'ok',
            purpose: 'Distinct values of orders.status',
        });
        expect(platformQueryCalls()[0]?.[2]?.audit?.description).toContain('AI Ask');
        expect(res.answer.status).toBe('answered');
    });

    it('refuses to sample a personal-data column without touching the database', async () => {
        columnRows = [{ column_name: 'firstName', data_type: 'text', is_nullable: true }];
        create
            .mockResolvedValueOnce(toolUse('sample_values', { table: 'orders', column: 'firstName' }))
            .mockResolvedValueOnce(
                submit({
                    status: 'abstained',
                    answer: 'Not available.',
                    confidence: 'low',
                    basis: 'none',
                    abstain_reason: 'unsafe_request',
                }),
            );

        await ask();

        expect(platformQueryCalls()).toHaveLength(0);
        expect(JSON.stringify(nthCall(1).messages)).toContain('personal data');
    });

    // Portal: "returns foreign-key join conditions from find_join_path". Foreign keys are not visible through the
    // engine (§1.1 has only platform_tables/platform_columns), so the tool says so and points at describe_tables.
    it('answers find_join_path with the naming-convention hint, as a schema lookup', async () => {
        tableRows = [
            { table_schema: 'public', table_name: 'orders' },
            { table_schema: 'public', table_name: 'patients' },
        ];
        create
            .mockResolvedValueOnce(toolUse('find_join_path', { from: 'orders', to: 'patients' }))
            .mockResolvedValueOnce(
                submit({
                    status: 'answered',
                    answer: 'Orders may join to patients by a naming convention.',
                    confidence: 'low',
                    basis: 'schema_metadata',
                }),
            );

        const res = await ask('How do orders join to patients?');

        const shown = JSON.stringify(nthCall(1).messages);
        expect(shown).toContain('between orders and patients');
        expect(shown).toContain('naming convention');
        // A join-path lookup is a schema lookup, so a schema-metadata answer is grounded.
        expect(res.answer.status).toBe('answered');
    });

    it('gives retry advice when a query times out', async () => {
        platformQuery = () => Promise.reject(engineError('canceling statement due to statement timeout', '57014'));
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT count(*) FROM orders', purpose: 'count' }))
            .mockResolvedValueOnce(
                submit({
                    status: 'abstained',
                    answer: 'Timed out.',
                    confidence: 'low',
                    basis: 'none',
                    abstain_reason: 'query_failed',
                }),
            );

        const res = await ask();

        expect(res.queries[0]).toMatchObject({ status: 'error' });
        expect(JSON.stringify(nthCall(1).messages)).toContain('Retry narrower');
    });

    it('sends back an answer with figures its queries cannot support, then accepts the fix', async () => {
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT count(*) AS n FROM orders', purpose: 'count orders' }))
            .mockResolvedValueOnce(answer('There are 7 open orders, up 38% on last month.'))
            .mockResolvedValueOnce(answer('There are 7 open orders.'));

        const res = await ask();

        expect(res.answer).toMatchObject({ status: 'answered', answer: 'There are 7 open orders.' });
        expect(JSON.stringify(nthCall(2).messages)).toContain('38%');
    });

    it('keeps a still-unverified answer but marks it low confidence with the figures called out', async () => {
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT count(*) AS n FROM orders', purpose: 'count orders' }))
            .mockResolvedValue(answer('There are 7 open orders, up 38%.'));

        const res = await ask();

        expect(res.answer.status).toBe('answered');
        expect(res.answer.confidence).toBe('low');
        expect(res.answer.caveats.join(' ')).toContain('38%');
        expect(create).toHaveBeenCalledTimes(4);
    });
});

describe('elideOldToolResults', () => {
    const turn = (id: string, size: number) => ({
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: id, content: 'x'.repeat(size) }],
    });
    const contents = (msgs: ReturnType<typeof turn>[]) => msgs.map((m) => m.content[0]?.content ?? '');

    it('leaves a small conversation untouched', () => {
        const msgs = [turn('a', 1000), turn('b', 1000)];
        elideOldToolResults(msgs);
        expect(contents(msgs).every((c) => c.length === 1000)).toBe(true);
    });

    it('stubs the oldest results but keeps the most recent ones', () => {
        const msgs = Array.from({ length: 20 }, (_, i) => turn(`t${i}`, 16_000));
        elideOldToolResults(msgs);
        const out = contents(msgs);
        expect(out[0]).toContain('omitted');
        expect(out.slice(-6).every((c) => c.length === 16_000)).toBe(true);
        expect(out.reduce((n, c) => n + c.length, 0)).toBeLessThan(260_000);
    });
});

describe('normalizeAnswer', () => {
    const ctx = (overrides: Partial<AskContext> = {}): AskContext => ({
        database: 'platform',
        question: 'q',
        user,
        queries: [],
        schemaLookups: 0,
        ...overrides,
    });

    it('accepts a schema-metadata answer only after a schema lookup', () => {
        const input = {
            status: 'answered',
            answer: 'orders has a status column.',
            confidence: 'high',
            basis: 'schema_metadata',
        };
        expect(normalizeAnswer(input, ctx()).abstainReason).toBe('unsupported_answer');
        expect(normalizeAnswer(input, ctx({ schemaLookups: 1 })).status).toBe('answered');
    });

    it('rejects evidence pointing at a failed or nonexistent query', () => {
        const base = {
            status: 'answered',
            answer: 'x',
            confidence: 'high',
            basis: 'query_results',
        };
        const failed = ctx({
            queries: [
                {
                    index: 1,
                    purpose: '',
                    sql: '',
                    status: 'error',
                    columns: [],
                    rows: [],
                    moreRowsAvailable: false,
                    durationMs: 0,
                },
            ],
        });
        expect(normalizeAnswer({ ...base, evidence_queries: [1] }, failed).status).toBe('abstained');
        expect(normalizeAnswer({ ...base, evidence_queries: [2] }, failed).status).toBe('abstained');
    });

    it('maps an unknown abstain reason to "other"', () => {
        const out = normalizeAnswer({ status: 'abstained', answer: 'no', abstain_reason: 'made_up' }, ctx());
        expect(out.abstainReason).toBe('other');
    });
});

describe('askData team memory', () => {
    const note = (over: Partial<MemoryNote> = {}): MemoryNote => ({
        id: 'b'.repeat(32),
        database: 'platform',
        kind: 'definition',
        topic: 'open orders',
        insight: 'Open orders have status open and no closed_at.',
        tables: ['orders'],
        status: 'active',
        createdAt: 'x',
        updatedAt: '2026-01-01',
        lastUsedAt: 'x',
        createdByEmail: 'a@example.com',
        confirmations: 1,
        uses: 0,
        upvotes: 0,
        downvotes: 0,
        expiresAt: 0,
        ...over,
    });

    const answered = (extra: Record<string, unknown> = {}) =>
        submit({
            status: 'answered',
            answer: '7 open orders.',
            confidence: 'high',
            basis: 'query_results',
            evidence_queries: [1],
            ...extra,
        });

    it('offers relevant notes to the model as unverified hints and credits them on a grounded answer', async () => {
        listNotes.mockResolvedValue([
            note(),
            note({ id: 'c'.repeat(32), topic: 'fax carriers', insight: 'Carrier lives in fax_log.' }),
        ]);
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT 1 AS n', purpose: 'p' }))
            .mockResolvedValueOnce(answered());

        const res = await ask('How many open orders?');

        const system = nthCall(0).system;
        expect(system).toHaveLength(2);
        expect(system[1]?.text).toContain('UNVERIFIED');
        expect(system[1]?.text).toContain('open orders');
        expect(system[1]?.text).not.toContain('fax carriers');
        expect(res.memory.recalled.map((n) => n.topic)).toEqual(['open orders']);
        expect(touchNotes).toHaveBeenCalledWith(['b'.repeat(32)]);
    });

    it('stores vetted lessons (SQL from the real query, literals scrubbed) and returns them', async () => {
        create
            .mockResolvedValueOnce(
                toolUse('run_sql', {
                    sql: "SELECT count(*) AS n FROM orders WHERE note = 'Jane Doe'",
                    purpose: 'p',
                }),
            )
            .mockResolvedValueOnce(
                answered({
                    learnings: [
                        {
                            kind: 'query_pattern',
                            topic: 'open order count',
                            insight: 'Count rows in orders filtered on the note column.',
                            tables: ['ORDERS', 'not_a_table'],
                            from_query: 1,
                        },
                        {
                            kind: 'gotcha',
                            topic: 'patient lookup',
                            insight: 'Jane Doe jane@x.com has MRN 12345678.',
                        },
                        {
                            kind: 'table_hint',
                            topic: 'fax',
                            insight: 'Faxes are stored somewhere around here.',
                            tables: ['ghost'],
                        },
                    ],
                }),
            );

        const res = await ask();

        expect(upsertNote).toHaveBeenCalledTimes(1);
        expect(upsertNote).toHaveBeenCalledWith(
            expect.objectContaining({
                database: 'platform',
                kind: 'query_pattern',
                tables: ['orders'],
                sqlTemplate: "SELECT count(*) AS n FROM orders WHERE note = '?'",
                createdByEmail: user.email,
            }),
        );
        expect(res.memory.learned).toHaveLength(1);
    });

    it('learns nothing from an abstention or a discarded draft', async () => {
        create.mockResolvedValueOnce(
            submit({
                status: 'abstained',
                answer: 'x',
                confidence: 'low',
                basis: 'none',
                learnings: [{ kind: 'gotcha', topic: 'something', insight: 'A lesson that should not be kept.' }],
            }),
        );
        await ask();
        expect(upsertNote).not.toHaveBeenCalled();
        expect(touchNotes).not.toHaveBeenCalled();
    });

    it('downvotes recalled notes the model reports as outdated, and ignores unknown ids', async () => {
        listNotes.mockResolvedValue([note()]);
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT 1 AS n', purpose: 'p' }))
            .mockResolvedValueOnce(answered({ outdated_notes: ['b'.repeat(12), 'deadbeefdead'] }));

        const res = await ask('How many open orders?');

        expect(voteNote).toHaveBeenCalledTimes(1);
        expect(voteNote).toHaveBeenCalledWith('b'.repeat(32), expect.stringMatching(/^model:/), false);
        expect(res.memory.flagged).toBe(1);
    });

    it('still answers when the memory table is unavailable', async () => {
        listNotes.mockRejectedValue(new Error('ResourceNotFoundException'));
        upsertNote.mockRejectedValue(new Error('ResourceNotFoundException'));
        create
            .mockResolvedValueOnce(toolUse('run_sql', { sql: 'SELECT 1 AS n', purpose: 'p' }))
            .mockResolvedValueOnce(
                answered({
                    learnings: [{ kind: 'gotcha', topic: 'a gotcha', insight: 'Something worth remembering.' }],
                }),
            );

        const res = await ask();

        expect(res.answer.status).toBe('answered');
        expect(res.memory).toMatchObject({ recalled: [], learned: [] });
    });
});
