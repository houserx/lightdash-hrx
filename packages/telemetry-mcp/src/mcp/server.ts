/**
 * The MCP endpoint behind `/mcp`, reached only after the bearer token has been verified.
 *
 * Stateless streamable HTTP: every HTTP request gets a fresh MCP server and transport (`sessionIdGenerator:
 * undefined`), so each request is authenticated on its own and nothing is kept between requests.
 */
import type http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { VerifiedAccessToken } from '../auth/okta.js';

/** `serverInfo.name` announced to MCP clients. */
export const MCP_SERVER_NAME = 'telemetry-mcp';
export const MCP_SERVER_VERSION = '0.0.1';

function createMcpServer(): McpServer {
    return new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
}

/** Serves one authenticated `/mcp` HTTP request. */
export async function serveMcpRequest(
    _auth: VerifiedAccessToken,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
        void transport.close();
        void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
}
