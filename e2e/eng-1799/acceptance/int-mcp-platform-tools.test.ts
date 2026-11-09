/* eslint-disable */
// @ts-nocheck
// int-mcp-platform-tools: the MCP Platform Database tools against the real engine:
// platform_schema lists tables and columns, platform_query is an Audited Query (one audit item with
// the caller's description and ticket, action ai_ask, the Lightdash user as subject), and
// platform_explain returns the estimate-only plan; without platform_read the engine refuses.
import { WIDGET_COUNT } from './fixtures';
import { disposeAll, harness, mcpConnect, ORG_UUID, PROJECT_UUID, track, USER_EMAIL, USER_UUID } from './support';

afterAll(disposeAll);

describe('int-mcp-platform-tools', () => {
    it('runs the Platform Database tools as audited, attributed queries', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const okta = track(await h.startFakeOkta());
        const lightdash = track(
            await h.startFakeLightdashApi({
                projectUuid: PROJECT_UUID,
                organizationUuid: ORG_UUID,
                users: [
                    { userUuid: USER_UUID, email: USER_EMAIL, attributes: { platform_read: 'true' } },
                    { userUuid: '0f6c1f7e-6666-4c4c-8a8a-000000000006', email: 'e2e.viewer@example.test', attributes: {} },
                ],
            }),
        );
        const mcp = track(await h.startTelemetryMcp({ engine, okta, lightdashUrl: lightdash.url, lightdashApiToken: lightdash.apiToken, projectUuid: PROJECT_UUID }));
        const s = await mcpConnect(mcp.url, await okta.mintAccessToken({ sub: 'okta-sub-1', email: USER_EMAIL }));

        const tables = await s.call('platform_schema', {});
        expect(tables.isError, tables.text).toBe(false);
        expect(tables.structured.tables).toContainEqual({ table_schema: 'public', table_name: 'widgets' });
        const columns = await s.call('platform_schema', { table_schema: 'public', table_name: 'widgets' });
        expect(columns.structured.columns.map((c) => c.column_name)).toEqual(['id', 'name', 'qty']);

        const before = engine.auditStore.items().length;
        const query = await s.call('platform_query', { sql: 'SELECT count(*) AS n FROM widgets', description: 'How many synthetic widgets exist', ticket: 'ENG-1799' });
        expect(query.isError, query.text).toBe(false);
        expect(Number(query.structured.rows[0].n)).toBe(WIDGET_COUNT);
        const audited = engine.auditStore.items().slice(before);
        expect(audited).toHaveLength(1);
        expect(audited[0]).toMatchObject({
            executedBySub: USER_UUID,
            executedByEmail: USER_EMAIL,
            description: 'How many synthetic widgets exist',
            linearTicketId: 'ENG-1799',
            action: 'ai_ask',
            mode: 'read',
            database: 'platform',
            status: 'success',
        });
        expect(audited[0].sql).toContain('platform_query');

        const explain = await s.call('platform_explain', { sql: 'SELECT * FROM widgets WHERE qty = 3', description: 'Plan check', advise: false });
        expect(explain.isError, explain.text).toBe(false);
        expect(JSON.stringify(explain.structured.plan)).toContain('widgets');

        const viewer = await mcpConnect(mcp.url, await okta.mintAccessToken({ sub: 'okta-sub-3', email: 'e2e.viewer@example.test' }));
        const refused = await viewer.call('platform_query', { sql: 'SELECT 1', description: 'should be refused' });
        expect(refused.isError).toBe(true);
        expect(refused.text).toMatch(/platform_read/);
        await viewer.close();
        await s.close();
    });
});
