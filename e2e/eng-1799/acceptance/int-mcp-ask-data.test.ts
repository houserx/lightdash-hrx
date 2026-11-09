/* eslint-disable */
// @ts-nocheck
// int-mcp-ask-data: ask_data (the ported data assistant) works against the real engine. With a
// scripted model it finds example queries in the engine's audit browser (GET /v1/audit with no
// filters, the portal's recent-history browse), runs SQL through platform_query() as an Audited
// Query whose description carries the question, and answers.
import { disposeAll, harness, mcpConnect, mintBackendToken, ORG_UUID, pgRun, PROJECT_UUID, setIdentity, track, USER_EMAIL, USER_UUID } from './support';

afterAll(disposeAll);

const QUESTION = 'How many synthetic widgets have qty 3?';

/** A scripted Anthropic-Messages-shaped model: example queries, then run_sql, then submit_answer. */
function scriptedModel() {
    const seen: any[] = [];
    let step = 0;
    const reply = (content: any[], stop = 'tool_use') => ({ type: 'message', role: 'assistant', content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 10 } });
    return {
        seen,
        async createMessage(params: any) {
            seen.push(params);
            const toolNames = (params.tools ?? []).map((t: any) => t.name);
            if (!toolNames.includes('submit_answer')) {
                // Any auxiliary call (verification, memory): a neutral, well-formed reply.
                return reply([{ type: 'text', text: '{"verdict":"supported","issues":[]}' }], 'end_turn');
            }
            step += 1;
            if (step === 1) return reply([{ type: 'tool_use', id: 'toolu_e2e_1', name: 'find_example_queries', input: { keywords: 'widgets qty' } }]);
            if (step === 2) return reply([{ type: 'tool_use', id: 'toolu_e2e_2', name: 'run_sql', input: { sql: 'SELECT count(*) AS n FROM widgets WHERE qty = 3', purpose: 'Count widgets with qty 3' } }]);
            return reply([
                {
                    type: 'tool_use',
                    id: `toolu_e2e_${step}`,
                    name: 'submit_answer',
                    input: { status: 'answered', answer: 'There are **29** synthetic widgets with qty 3.', confidence: 'high', basis: 'query_results', evidence_queries: [1], assumptions: [], caveats: [] },
                },
            ]);
        },
    };
}

const toolResultText = (params: any, toolUseId: string) => {
    for (const m of params.messages ?? []) {
        if (!Array.isArray(m.content)) continue;
        for (const block of m.content) {
            if (block.type === 'tool_result' && block.tool_use_id === toolUseId) return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        }
    }
    return undefined;
};

describe('int-mcp-ask-data', () => {
    it('answers from the Platform Database through audited engine queries', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        // History for the example-query search: an earlier audited query about widgets.
        const earlier = await mintBackendToken({ attrs: { platform_read: true }, audit: { description: 'Widget quantities by qty', source: 'investigate' } });
        expect((await pgRun(engine, [setIdentity(earlier), `SELECT * FROM platform_query('SELECT qty, count(*) FROM widgets GROUP BY qty')`])).error).toBeUndefined();

        const okta = track(await h.startFakeOkta());
        const lightdash = track(await h.startFakeLightdashApi({ projectUuid: PROJECT_UUID, organizationUuid: ORG_UUID, users: [{ userUuid: USER_UUID, email: USER_EMAIL, attributes: { platform_read: 'true' } }] }));
        const llm = scriptedModel();
        const mcp = track(await h.startTelemetryMcp({ engine, okta, lightdashUrl: lightdash.url, lightdashApiToken: lightdash.apiToken, projectUuid: PROJECT_UUID, llm }));
        const s = await mcpConnect(mcp.url, await okta.mintAccessToken({ sub: 'okta-sub-1', email: USER_EMAIL }));

        const result = await s.call('ask_data', { question: QUESTION });
        expect(result.isError, result.text).toBe(false);

        const afterExamples = llm.seen.find((p) => toolResultText(p, 'toolu_e2e_1') !== undefined);
        expect(afterExamples).toBeDefined();
        const examples = toolResultText(afterExamples, 'toolu_e2e_1');
        expect(examples).not.toMatch(/HTTP (400|401|403|500)|could not|unavailable/i);
        expect(examples).toContain('Widget quantities by qty');

        const afterSql = llm.seen.find((p) => toolResultText(p, 'toolu_e2e_2') !== undefined);
        expect(toolResultText(afterSql, 'toolu_e2e_2')).toMatch(/29/);

        const asked = engine.auditStore.items().filter((i) => i.action === 'ai_ask');
        expect(asked.length).toBeGreaterThanOrEqual(1);
        expect(asked.some((i) => i.description.includes(QUESTION) && i.sql.includes('qty = 3'))).toBe(true);
        expect(asked.every((i) => i.executedBySub === USER_UUID)).toBe(true);
        await s.close();
    });
});
