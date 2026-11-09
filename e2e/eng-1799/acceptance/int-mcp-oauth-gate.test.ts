/* eslint-disable */
// @ts-nocheck
// int-mcp-oauth-gate: the telemetry MCP server, run against the real engine and a fake Lightdash
// API, is gated by a local OAuth JWKS: no token, a wrong audience, an expired token or a foreign
// key gets 401; a valid token for a mapped user lists the 14 tools (no commit tool); an unmapped
// user gets an empty tool list.
import { disposeAll, harness, mcpConnect, ORG_UUID, PROJECT_UUID, track, USER_EMAIL, USER_UUID } from './support';

afterAll(disposeAll);

const TOOLS = ['alert_history', 'alert_state', 'ask_data', 'get_trace', 'list_sources', 'platform_explain', 'platform_query', 'platform_schema', 'query_cloudwatch', 'query_cloudwatch_logs', 'query_logql', 'query_promql', 'search_traces', 'write_preview'];

describe('int-mcp-oauth-gate', () => {
    it('authenticates every request against the local JWKS', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const okta = track(await h.startFakeOkta());
        const otherOkta = track(await h.startFakeOkta());
        const lightdash = track(
            await h.startFakeLightdashApi({
                projectUuid: PROJECT_UUID,
                organizationUuid: ORG_UUID,
                users: [{ userUuid: USER_UUID, email: USER_EMAIL, attributes: { platform_read: 'true' } }],
            }),
        );
        const mcp = track(await h.startTelemetryMcp({ engine, okta, lightdashUrl: lightdash.url, lightdashApiToken: lightdash.apiToken, projectUuid: PROJECT_UUID }));

        const post = (token?: string) =>
            fetch(`${mcp.url}/mcp`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
            });
        const none = await post();
        expect(none.status).toBe(401);
        expect(none.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata="/);
        expect((await post(await okta.mintAccessToken({ sub: 'okta-sub-1', email: USER_EMAIL, aud: 'api://someone-else' }))).status).toBe(401);
        expect((await post(await okta.mintAccessToken({ sub: 'okta-sub-1', email: USER_EMAIL, expiresInSeconds: -60 }))).status).toBe(401);
        expect((await post(await otherOkta.mintAccessToken({ sub: 'okta-sub-1', email: USER_EMAIL }))).status).toBe(401);

        const session = await mcpConnect(mcp.url, await okta.mintAccessToken({ sub: 'okta-sub-1', email: USER_EMAIL }));
        const tools = (await session.client.listTools()).tools.map((t) => t.name).sort();
        expect(tools).toEqual(TOOLS);
        await session.close();

        const stranger = await mcpConnect(mcp.url, await okta.mintAccessToken({ sub: 'okta-sub-2', email: 'nobody@example.test' }));
        expect((await stranger.client.listTools()).tools).toEqual([]);
        await stranger.close();
    });
});
