import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { MCP_SERVER_NAME, createMcpServer } from './server.js';

const ENV: Record<string, string> = {
    MCP_PUBLIC_URL: 'https://telemetry-mcp.example.test',
    OKTA_ISSUER: 'https://okta.example.test/oauth2/default',
    OKTA_AUDIENCE: 'api://telemetry-mcp-test',
    LIGHTDASH_URL: 'https://lightdash.example.test',
    LIGHTDASH_API_TOKEN: 'test-token-not-real',
    LIGHTDASH_PROJECT_UUID: '5c0f8d2e-6b7a-4c1d-9e8f-0a1b2c3d4e5f',
    ENGINE_PG_HOST: 'engine.example.test',
    ENGINE_PG_USER: 'lightdash-operations',
    ENGINE_PG_PASSWORD: 'test-password-not-real',
    ENGINE_HTTP_URL: 'https://engine.example.test:8088',
    HRX_IDENTITY_SECRET: 'test-secret-not-real',
    MCP_SOURCES: JSON.stringify([
        { name: 'prometheus-production', kind: 'prometheus', default: true },
        { name: 'loki-platform', kind: 'loki', restricted: true },
    ]),
};

describe('mcp server', () => {
    const clients: Client[] = [];
    afterEach(async () => {
        for (const c of clients.splice(0)) await c.close();
    });

    async function connect(): Promise<Client> {
        const server = createMcpServer(loadConfig(ENV));
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        const client = new Client({ name: 'unit-test', version: '0.0.0' });
        await client.connect(clientSide);
        clients.push(client);
        return client;
    }

    it('announces telemetry-mcp with the tools capability and answers ping', async () => {
        const client = await connect();
        expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
        expect(client.getServerCapabilities()?.tools).toBeDefined();
        await expect(client.ping()).resolves.toBeDefined();
    });

    it('lists list_sources as a read-only tool with an object input schema', async () => {
        const { tools } = await (await connect()).listTools();
        const tool = tools.find((t) => t.name === 'list_sources');
        expect(tool?.description).toContain('Telemetry Source');
        expect(tool?.inputSchema.type).toBe('object');
        expect(tool?.annotations?.readOnlyHint).toBe(true);
    });

    it('list_sources returns the configured Telemetry Sources with their flags', async () => {
        const r = await (await connect()).callTool({ name: 'list_sources', arguments: {} });
        expect(r.isError).toBeFalsy();
        expect(r.structuredContent).toEqual({
            sources: [
                { name: 'prometheus-production', kind: 'prometheus', default: true, restricted: false },
                { name: 'loki-platform', kind: 'loki', default: false, restricted: true },
            ],
        });
    });
});
