/* eslint-disable */
// @ts-nocheck
// int-mcp-restricted-hidden: Restricted Telemetry is never readable through MCP. A user who holds
// telemetry_restricted in Lightdash gets an access-denied tool error naming agent for the
// restricted Prometheus source and for a restricted Loki selector, nothing is audited, and open
// telemetry still answers.
import { disposeAll, harness, iso, mcpConnect, ORG_UUID, PROJECT_UUID, T0, track, USER_EMAIL, USER_UUID } from './support';

afterAll(disposeAll);

describe('int-mcp-restricted-hidden', () => {
    it('refuses restricted sources and selectors to the MCP identity', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up' }, value: 1 }] }));
        const loki = track(await h.startFakeLoki({ streams: [{ labels: { namespace: 'platform', app: 'pharmacy' }, lines: [[iso(T0), 'synthetic restricted line']] }] }));
        const engine = track(await h.startEngine({ prometheus: prom, loki, restrictedLokiSelectors: ['{namespace="platform"}'] }));
        const okta = track(await h.startFakeOkta());
        const lightdash = track(
            await h.startFakeLightdashApi({
                projectUuid: PROJECT_UUID,
                organizationUuid: ORG_UUID,
                users: [{ userUuid: USER_UUID, email: USER_EMAIL, attributes: { telemetry_restricted: 'true', platform_read: 'true' } }],
            }),
        );
        const mcp = track(await h.startTelemetryMcp({ engine, okta, lightdashUrl: lightdash.url, lightdashApiToken: lightdash.apiToken, projectUuid: PROJECT_UUID }));
        const s = await mcpConnect(mcp.url, await okta.mintAccessToken({ sub: 'okta-sub-1', email: USER_EMAIL }));
        const window = { start: iso(T0), end: iso(T0 + 60_000) };

        const restricted = await s.call('query_promql', { query: 'up', step: '1m', source: 'prometheus-restricted', ...window });
        expect(restricted.isError).toBe(true);
        expect(restricted.text).toMatch(/access denied|permission/i);
        expect(restricted.text).toMatch(/agent/);

        const selector = await s.call('query_logql', { query: '{namespace="platform"}', ...window });
        expect(selector.isError).toBe(true);
        expect(selector.text).toMatch(/agent/);

        const open = await s.call('query_promql', { query: 'up', step: '1m', ...window });
        expect(open.isError, open.text).toBe(false);
        expect(engine.auditStore.items()).toHaveLength(0);
        expect(loki.requests.some((r) => r.params.query === '{namespace="platform"}')).toBe(false);
        await s.close();
    });
});
