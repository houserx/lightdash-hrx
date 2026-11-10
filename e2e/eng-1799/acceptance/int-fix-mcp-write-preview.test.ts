/* eslint-disable */
// @ts-nocheck
// int-fix-mcp-write-preview: the MCP write_preview tool works against the real engine. Its
// confirmation token is accepted, the Preview returns the would-be rows and rolls back (the
// Platform Database is unchanged), it is audited as an agent Preview, and the same token cannot
// be replayed by the agent as a commit.
import { disposeAll, harness, httpJson, mcpConnect, ORG_UUID, PROJECT_UUID, track, USER_EMAIL, USER_UUID } from './support';

afterAll(disposeAll);

const STATEMENT = 'UPDATE widgets SET qty = 0 WHERE id BETWEEN 1 AND 3 RETURNING id, qty';

describe('int-fix-mcp-write-preview', () => {
    it('previews through the engine and changes nothing', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const okta = track(await h.startFakeOkta());
        const lightdash = track(
            await h.startFakeLightdashApi({ projectUuid: PROJECT_UUID, organizationUuid: ORG_UUID, users: [{ userUuid: USER_UUID, email: USER_EMAIL, attributes: { platform_write: 'true', platform_read: 'true' } }] }),
        );
        const mcp = track(await h.startTelemetryMcp({ engine, okta, lightdashUrl: lightdash.url, lightdashApiToken: lightdash.apiToken, projectUuid: PROJECT_UUID }));
        const s = await mcpConnect(mcp.url, await okta.mintAccessToken({ sub: 'okta-sub-1', email: USER_EMAIL }));
        const before = await platform.query('SELECT id, qty FROM public.widgets WHERE id BETWEEN 1 AND 3 ORDER BY id');

        const preview = await s.call('write_preview', { statement: STATEMENT, description: 'Preview zeroing three synthetic widgets', ticket: 'ENG-1799' });
        expect(preview.isError, preview.text).toBe(false);
        expect(preview.structured.preview).toBe(true);
        expect(preview.structured.rows_affected).toBe(3);
        expect(preview.structured.returning).toEqual([
            { id: 1, qty: 0 },
            { id: 2, qty: 0 },
            { id: 3, qty: 0 },
        ]);
        expect(await platform.query('SELECT id, qty FROM public.widgets WHERE id BETWEEN 1 AND 3 ORDER BY id')).toEqual(before);

        const [item] = engine.auditStore.items();
        expect(item).toMatchObject({ mode: 'write', preview: true, action: 'ai_ask', executedBySub: USER_UUID, sql: STATEMENT, linearTicketId: 'ENG-1799' });

        // No commit path exists for MCP: the tool list has none, and the engine refuses an agent commit.
        const tools = (await s.client.listTools()).tools.map((t) => t.name);
        expect(tools.filter((t) => /commit/i.test(t))).toEqual([]);
        const writes = engine.auditStore.items().filter((i) => i.mode === 'write' && i.preview === false);
        expect(writes).toHaveLength(0);
        await s.close();
    });
});
