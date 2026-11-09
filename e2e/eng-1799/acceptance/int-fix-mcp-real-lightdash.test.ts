/* eslint-disable */
// @ts-nocheck
// int-fix-mcp-real-lightdash: the telemetry MCP server works against the real Lightdash API, not
// only its fake: it maps the Okta email to the Lightdash user and that user's attributes through
// Lightdash's own org users and attributes routes, and its alert_state / alert_history tools read
// the alerting API with the filters it advertises (rule_uuid narrows to one rule).
import { RULE_SQL } from './fixtures';
import { disposeAll, harness, ld, mcpConnect, track } from './support';

afterAll(disposeAll);

describe('int-fix-mcp-real-lightdash', () => {
    it('maps users and reads alert state and history from Lightdash', async () => {
        const h = await harness();
        const prom = track(
            await h.startFakePrometheus({
                series: [
                    { labels: { __name__: 'db_cpu', instance: 'db-1' }, value: 95 },
                    { labels: { __name__: 'queue_depth', queue: 'q-1' }, value: 500 },
                ],
            }),
        );
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ prometheus: prom, platform }));
        const lightdash = track(await h.startLightdash({ engine }));
        const base = `/api/v2/projects/${lightdash.projectUuid}/alerting`;
        const rule = async (name: string, metric: string) => {
            const r = await ld(lightdash, 'POST', `${base}/rules`, { name, description: `${name} (synthetic)`, query: RULE_SQL(metric), condition: { operator: '>', threshold: 90 }, for: '0s', interval: '30s', timeRange: '5m' });
            expect(r.status, r.text).toBe(200);
            return r.json.results.uuid;
        };
        const cpuRule = await rule('Synthetic CPU', 'db_cpu');
        const queueRule = await rule('Synthetic queue', 'queue_depth');
        await lightdash.runAlertingCycle();

        const okta = track(await h.startFakeOkta());
        const mcp = track(await h.startTelemetryMcp({ engine, okta, lightdashUrl: lightdash.baseUrl, lightdashApiToken: lightdash.apiKey, projectUuid: lightdash.projectUuid }));
        const s = await mcpConnect(mcp.url, await okta.mintAccessToken({ sub: 'okta-sub-ld', email: lightdash.userEmail }));
        expect((await s.client.listTools()).tools.length).toBe(14);

        const state = await s.call('alert_state', {});
        expect(state.isError, state.text).toBe(false);
        const firing = state.structured.results.instances.map((i) => i.ruleUuid).sort();
        expect(firing).toEqual([cpuRule, queueRule].sort());
        const oneState = await s.call('alert_state', { rule_uuid: cpuRule });
        expect(oneState.structured.results.instances.map((i) => i.ruleUuid)).toEqual([cpuRule]);

        const history = await s.call('alert_history', { rule_uuid: queueRule, limit: 50 });
        expect(history.isError, history.text).toBe(false);
        expect(history.structured.results.length).toBeGreaterThan(0);
        expect(history.structured.results.every((e) => e.ruleUuid === queueRule)).toBe(true);

        // Attributes come from Lightdash: without platform_read the engine refuses, with it the query runs.
        await lightdash.setUserAttributes({ platform_read: 'false' });
        const denied = await s.call('platform_query', { sql: 'SELECT 1 AS x', description: 'MCP against real Lightdash' });
        expect(denied.isError).toBe(true);
        await lightdash.setUserAttributes({ platform_read: 'true' });
        await new Promise((r) => setTimeout(r, 100));
        const fresh = await mcpConnect(mcp.url, await okta.mintAccessToken({ sub: 'okta-sub-ld-2', email: lightdash.userEmail.toUpperCase() }));
        const allowed = await fresh.call('platform_query', { sql: 'SELECT count(*) AS n FROM widgets', description: 'MCP against real Lightdash' });
        expect(allowed.isError, allowed.text).toBe(false);
        expect(engine.auditStore.items().at(-1)).toMatchObject({ executedBySub: lightdash.userUuid, action: 'ai_ask' });
        await fresh.close();
        await s.close();
    });
});
