/**
 * The MCP endpoint behind `/mcp`, reached only after the bearer token has been verified.
 *
 * Stateless streamable HTTP: every HTTP request gets a fresh MCP server and transport (`sessionIdGenerator:
 * undefined`), so each request is authenticated on its own, nothing is kept between requests, and any number of
 * clients can be served at once. `initialize`, `ping`, `tools/list` and `tools/call` each arrive as their own POST.
 *
 * Tools are only for a mapped Lightdash user. A request that lists or calls tools first maps the Okta claims to the
 * Lightdash user; when that fails (no email, no active Lightdash user with that email, Lightdash unreachable) the
 * request is served by a server with no tools: `tools/list` is empty and every `tools/call` is an error, before any
 * engine connection. `initialize` and `ping` need no user and cost no Lightdash call.
 */
import type http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JWTPayload } from 'jose';
import type { VerifiedAccessToken } from '../auth/okta.js';
import { UserMappingError, type MappedUser, type UserResolver } from '../auth/userMapping.js';
import type { Config } from '../config.js';
import { createEngineClient, type EngineClient } from '../engine/client.js';
import { createIdentitySession } from '../engine/session.js';
import { registerListSources } from '../tools/listSources.js';
import { registerQueryLogql } from '../tools/queryLogql.js';
import { registerQueryPromql } from '../tools/queryPromql.js';
import { MAX_MCP_BODY_BYTES, carriesMethod, readMcpBody } from './requestBody.js';

/** `serverInfo.name` announced to MCP clients. */
export const MCP_SERVER_NAME = 'telemetry-mcp';
export const MCP_SERVER_VERSION = '0.0.1';

/** What the tools talk to: the Federation Engine, as the caller. Unit tests inject fakes. */
export interface McpServerDeps {
    engine: EngineClient;
    /** The server clock (epoch ms); relative time arguments such as `now-1h` resolve against it. */
    now: () => number;
}

/** What a request needs besides the config: the shared user resolver and the server clock (epoch ms). */
export interface McpRequestContext {
    users: UserResolver;
    now: () => number;
}

/** Builds the MCP server for one request, with every tool registered. */
export function createMcpServer(config: Config, deps: McpServerDeps): McpServer {
    const { engine, now } = deps;
    // Registering a tool declares the tools capability and installs the tools/list and tools/call handlers.
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    registerListSources(server, config, engine);
    registerQueryPromql(server, config, engine, now);
    registerQueryLogql(server, config, engine, now);
    return server;
}

/** The JSON-RPC methods that need a mapped Lightdash user. */
export const USER_METHODS: readonly string[] = ['tools/list', 'tools/call'];

/** Shown to the MCP client when the user could not be mapped for a reason that is not a `UserMappingError`. */
const UNMAPPED_FALLBACK = 'Your Okta user could not be matched to a Lightdash user';

/**
 * The server for a caller with no Lightdash user: same name and tools capability, no tools. `tools/list` is empty
 * and every `tools/call` is an error result naming why (a fixed sentence from `UserMappingError`).
 */
export function createNoToolsServer(reason: string): Server {
    const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, () => ({
        isError: true,
        content: [{ type: 'text' as const, text: `No tools are available: ${reason}` }],
    }));
    return server;
}

/** A resolver that maps the claims at most once for this request, so the gate and the engine session share it. */
function onceResolver(users: UserResolver, claims: JWTPayload): UserResolver & { user(): Promise<MappedUser> } {
    let user: Promise<MappedUser> | undefined;
    const get = () => (user ??= users.resolve(claims));
    return { user: get, resolve: get };
}

/** Serves one authenticated `/mcp` HTTP request. */
export async function serveMcpRequest(
    config: Config,
    context: McpRequestContext,
    auth: VerifiedAccessToken,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    const body = await readMcpBody(req);
    if (body.kind === 'tooLarge') {
        const payload = JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: `Payload too large: the request body exceeds ${MAX_MCP_BODY_BYTES} bytes` },
            id: null,
        });
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(payload);
        return;
    }
    const parsedBody = body.kind === 'read' ? body.parsed : undefined;
    const users = onceResolver(context.users, auth.claims);

    let server: McpServer | Server;
    let unmapped: string | undefined;
    if (parsedBody !== undefined && carriesMethod(parsedBody, USER_METHODS)) {
        try {
            await users.user();
        } catch (err) {
            unmapped = err instanceof UserMappingError ? err.message : UNMAPPED_FALLBACK;
        }
    }
    if (unmapped !== undefined) {
        server = createNoToolsServer(unmapped);
    } else {
        // Every tool call opens its own engine connection as the caller (SET hrx.identity, SET statement_timeout).
        const session = createIdentitySession(config, users, auth.claims, context.now);
        server = createMcpServer(config, { engine: createEngineClient(config.engine, session, [
                config.identitySecret,
                config.lightdash.apiToken,
                config.anthropicApiKey,
            ]), now: context.now });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
        void transport.close();
        void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
}
