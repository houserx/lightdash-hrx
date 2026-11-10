// demo-mcp-server. PROTECTED.
import { expect, test } from '@playwright/test';
import { getJson, mcpCall, oktaToken, readStack } from './helpers/stack';

test('demo-mcp-server: telemetry-mcp runs against the engine and Lightdash, and the demo user gets the telemetry tools', async () => {
    const stack = readStack();
    expect(stack.processes.some((p) => /mcp/i.test(p.name)), 'stack.json lists the telemetry-mcp process').toBe(true);
    expect((await getJson(`${stack.mcp.url}/healthz`)).status).toBe('ok');

    // unauthenticated -> 401 with the protected-resource challenge
    const anon = await fetch(`${stack.mcp.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate') ?? '').toContain('resource_metadata=');

    const token = await oktaToken(stack);
    const tools = (await mcpCall(stack, token, 'tools/list')).tools.map((t: any) => t.name);
    for (const t of ['list_sources', 'query_promql', 'query_logql', 'search_traces', 'alert_state', 'platform_query']) expect(tools).toContain(t);

    const sources = await mcpCall(stack, token, 'tools/call', { name: 'list_sources', arguments: {} });
    const text = JSON.stringify(sources);
    for (const kind of ['prometheus', 'loki', 'tempo']) expect(text).toContain(kind);

    const alerts = await mcpCall(stack, token, 'tools/call', { name: 'alert_state', arguments: {} });
    expect(alerts.isError ?? false, `alert_state: ${JSON.stringify(alerts).slice(0, 300)}`).toBe(false);
});
