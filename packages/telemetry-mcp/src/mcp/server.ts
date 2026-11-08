/**
 * The MCP endpoint behind `/mcp`, reached only after the bearer token has been verified.
 *
 * Stateless streamable HTTP: every HTTP request gets a fresh MCP server and transport (`sessionIdGenerator:
 * undefined`), so each request is authenticated on its own, nothing is kept between requests, and any number of
 * clients can be served at once. `initialize`, `ping`, `tools/list` and `tools/call` each arrive as their own POST.
 */
import type http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { VerifiedAccessToken } from '../auth/okta.js';
import type { Config } from '../config.js';
import { createEngineClient, type EngineClient } from '../engine/client.js';
import { registerListSources } from '../tools/listSources.js';

/** `serverInfo.name` announced to MCP clients. */
export const MCP_SERVER_NAME = 'telemetry-mcp';
export const MCP_SERVER_VERSION = '0.0.1';

/** What the tools talk to. Defaults to the real Federation Engine from `config`; unit tests inject fakes. */
export interface McpServerDeps {
    engine: EngineClient;
}

/** Builds the MCP server for one request, with every tool registered. */
export function createMcpServer(config: Config, deps: Partial<McpServerDeps> = {}): McpServer {
    const engine = deps.engine ?? createEngineClient(config.engine);
    // Registering a tool declares the tools capability and installs the tools/list and tools/call handlers.
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    registerListSources(server, config, engine);
    return server;
}

/** Serves one authenticated `/mcp` HTTP request. */
export async function serveMcpRequest(
    config: Config,
    _auth: VerifiedAccessToken,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    const server = createMcpServer(config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
        void transport.close();
        void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
}
