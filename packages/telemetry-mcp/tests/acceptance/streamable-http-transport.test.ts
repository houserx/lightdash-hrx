import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('streamable HTTP transport', () => {
    it('lets an authorized MCP SDK client connect, identify the server, ping and list tools', async () => {
        const client = await h.connect();
        expect(client.getServerVersion()?.name).toBe('telemetry-mcp');
        await expect(client.ping()).resolves.toBeDefined();
        const { tools } = await client.listTools();
        expect(Array.isArray(tools)).toBe(true);
        expect(tools.length).toBeGreaterThan(0);
    });

    it('serves two clients at once', async () => {
        const [a, b] = await Promise.all([h.connect(), h.connect()]);
        const [ta, tb] = await Promise.all([a.listTools(), b.listTools()]);
        expect(ta.tools.map((t) => t.name).sort()).toEqual(tb.tools.map((t) => t.name).sort());
    });

    it('answers /healthz without auth', async () => {
        const res = await fetch(`${h.serverUrl}/healthz`);
        expect(res.status).toBe(200);
    });
});
