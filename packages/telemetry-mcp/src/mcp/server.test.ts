import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { EngineError, type EngineClient } from '../engine/client.js';
import { MCP_SERVER_NAME, createMcpServer, createNoToolsServer } from './server.js';

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

    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const catalogEngine: EngineClient = {
        async query(sql, params = []) {
            queries.push({ sql, params });
            return {
                columns: ['table_catalog', 'table_schema', 'table_name'],
                rows: [
                    { table_catalog: 'ops_marts', table_schema: 'ops', table_name: 'queue_depth' },
                    { table_catalog: 'ops_marts', table_schema: 'ops', table_name: 'fills_hourly' },
                    { table_catalog: 'operations', table_schema: 'public', table_name: 'not_a_mart' },
                    { table_catalog: 'ops_marts', table_schema: 'information_schema', table_name: 'tables' },
                ],
                truncated: false,
            };
        },
    };

    async function connect(engine: EngineClient = catalogEngine): Promise<Client> {
        const server = createMcpServer(loadConfig(ENV), { engine, now: () => Date.now() });
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

    it('list_sources returns the configured Telemetry Sources and the Ops Marts from information_schema', async () => {
        queries.length = 0;
        const r = await (await connect()).callTool({ name: 'list_sources', arguments: {} });
        expect(r.isError).toBeFalsy();
        expect(r.structuredContent).toEqual({
            sources: [
                { name: 'prometheus-production', kind: 'prometheus', default: true, restricted: false },
                { name: 'loki-platform', kind: 'loki', default: false, restricted: true },
            ],
            opsMarts: ['ops_marts.ops.fills_hourly', 'ops_marts.ops.queue_depth'],
        });
        expect(queries).toHaveLength(1);
        expect(queries[0]?.sql).toMatch(/information_schema\.tables/);
        expect(queries[0]?.sql).not.toMatch(/\bpg_/i);
        expect(queries[0]?.params).toEqual(['ops_marts']);
    });

    it('list_sources is an error result, not a partial list, when the engine fails', async () => {
        const failing: EngineClient = {
            query: async () => {
                throw new EngineError('could not reach the Federation Engine', undefined);
            },
        };
        const r = await (await connect(failing)).callTool({ name: 'list_sources', arguments: {} });
        expect(r.isError).toBe(true);
        expect(r.structuredContent).toBeUndefined();
        expect(JSON.stringify(r.content)).toContain('could not reach the Federation Engine');
    });

    it('the no-tools server lists no tools and refuses every call with the reason', async () => {
        const server = createNoToolsServer('Your access token has no email to match a Lightdash user');
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        const client = new Client({ name: 'unit-test', version: '0.0.0' });
        await client.connect(clientSide);
        clients.push(client);
        expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
        expect((await client.listTools()).tools).toEqual([]);
        for (const name of ['list_sources', 'no_such_tool']) {
            const r = await client.callTool({ name, arguments: {} });
            expect(r.isError).toBe(true);
            expect(JSON.stringify(r.content)).toContain('no email');
        }
    });
});
