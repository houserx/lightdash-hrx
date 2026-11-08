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
import { InMemoryAskMemoryStore } from '../ask/ask-memory-store.js';
import { createAskMemoryService, type AskMemoryService } from '../ask/ask-memory.service.js';
import { createExampleQueries } from '../ask/example-queries.service.js';
import type { LlmClient } from '../ask/llm.js';
import type { VerifiedAccessToken } from '../auth/okta.js';
import { UserMappingError, type MappedUser, type UserResolver } from '../auth/userMapping.js';
import type { Config } from '../config.js';
import { createEngineAuditBrowser } from '../engine/audit.js';
import { createEngineClient, type EngineClient } from '../engine/client.js';
import { createIdentitySession } from '../engine/session.js';
import { EngineWriteError, createEngineWriter, type EngineWriter } from '../engine/write.js';
import { createAlertingClient, type AlertingClient } from '../lightdash/alerting.js';
import { registerAlertHistory } from '../tools/alertHistory.js';
import { registerAlertState } from '../tools/alertState.js';
import { registerAskData, type AskDataDeps } from '../tools/askData.js';
import { registerGetTrace } from '../tools/getTrace.js';
import { registerListSources } from '../tools/listSources.js';
import { registerPlatformExplain } from '../tools/platformExplain.js';
import { registerPlatformQuery } from '../tools/platformQuery.js';
import { registerPlatformSchema } from '../tools/platformSchema.js';
import { registerQueryCloudwatch } from '../tools/queryCloudwatch.js';
import { registerQueryCloudwatchLogs } from '../tools/queryCloudwatchLogs.js';
import { registerQueryLogql } from '../tools/queryLogql.js';
import { registerQueryPromql } from '../tools/queryPromql.js';
import { registerSearchTraces } from '../tools/searchTraces.js';
import { registerWritePreview } from '../tools/writePreview.js';
import type { Logger } from '../log.js';
import { MAX_MCP_BODY_BYTES, carriesMethod, readMcpBody } from './requestBody.js';
import { logToolCalls } from './toolCallLog.js';

/** `serverInfo.name` announced to MCP clients. */
export const MCP_SERVER_NAME = 'telemetry-mcp';
export const MCP_SERVER_VERSION = '0.0.1';

/**
 * What the tools talk to: the Federation Engine, as the caller, and the Lightdash alerting API, as the service
 * account (defaults to `LIGHTDASH_URL`). Unit tests inject fakes.
 */
export interface McpServerDeps {
    engine: EngineClient;
    alerting?: AlertingClient;
    /** The server clock (epoch ms); relative time arguments such as `now-1h` resolve against it. */
    now: () => number;
    /** The model client for AI features (plan advice, ask_data); absent means AI is not configured. */
    llm?: LlmClient;
    /**
     * What ask_data needs besides the engine, model and clock: the server-wide team memory, the caller's example
     * queries and identity. Default (unit tests): an in-memory team memory, no example queries and no caller, so an
     * ask fails before any query.
     */
    ask?: Pick<AskDataDeps, 'memory' | 'examples' | 'user' | 'onError'>;
    /** Write Mode Previews through the engine's `POST /v1/write`, as the caller. Default (unit tests): none. */
    writer?: EngineWriter;
}

/** The writer used when `McpServerDeps.writer` is not given: every Preview fails before any engine call. */
const NO_WRITER: EngineWriter = {
    preview: () => Promise.reject(new EngineWriteError('The Preview failed: Write Mode is not available in this server')),
};

/**
 * What a request needs besides the config: the shared user resolver, the server clock (epoch ms) and the structured
 * logger.
 */
export interface McpRequestContext {
    users: UserResolver;
    now: () => number;
    logger: Logger;
    /** The model client for AI features; absent means AI is not configured. */
    llm?: LlmClient;
    /** ask_data's team memory, shared by every request and user of this server. */
    askMemory: AskMemoryService;
}

/** The ask_data collaborators used when `McpServerDeps.ask` is not given. */
function standaloneAsk(now: () => number): NonNullable<McpServerDeps['ask']> {
    return {
        memory: createAskMemoryService({ store: new InMemoryAskMemoryStore(), now }),
        examples: {
            findExampleQueries: () => Promise.resolve('Past-query examples are unavailable right now.'),
            resetExamplesCache: () => undefined,
        },
        user: () => Promise.reject(new Error('ask_data has no caller identity in this server')),
    };
}

/** Builds the MCP server for one request, with every tool registered. */
export function createMcpServer(config: Config, deps: McpServerDeps): McpServer {
    const { engine, now, llm } = deps;
    const alerting = deps.alerting ?? createAlertingClient(config.lightdash);
    // Registering a tool declares the tools capability and installs the tools/list and tools/call handlers.
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    registerListSources(server, config, engine);
    registerQueryPromql(server, config, engine, now);
    registerQueryLogql(server, config, engine, now);
    registerQueryCloudwatch(server, config, engine, now);
    registerQueryCloudwatchLogs(server, config, engine, now);
    registerSearchTraces(server, config, engine, now);
    registerGetTrace(server, config, engine);
    registerAlertState(server, config, alerting);
    registerAlertHistory(server, config, alerting, now);
    registerPlatformSchema(server, config, engine);
    registerPlatformQuery(server, config, engine);
    registerPlatformExplain(server, config, engine, llm);
    registerAskData(server, config, { engine, llm, now, ...(deps.ask ?? standaloneAsk(now)) });
    registerWritePreview(server, config, deps.writer ?? NO_WRITER);
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
    const sub = typeof auth.claims.sub === 'string' ? auth.claims.sub : undefined;
    if (unmapped !== undefined) {
        context.logger.warn('user not mapped', { user: sub, reason: unmapped });
        server = createNoToolsServer(unmapped);
    } else {
        // Every tool call opens its own engine connection as the caller (SET hrx.identity, SET statement_timeout).
        const session = createIdentitySession(config, users, auth.claims, context.now);
        const secrets = [config.identitySecret, config.lightdash.apiToken, config.anthropicApiKey];
        const { logger } = context;
        const onError = (err: unknown, where: string): void =>
            logger.warn('ask_data internal error', { where, error: err instanceof Error ? err.name : typeof err });
        server = createMcpServer(config, {
            engine: createEngineClient(config.engine, session, secrets),
            now: context.now,
            llm: context.llm,
            ask: {
                memory: context.askMemory,
                examples: createExampleQueries({
                    audit: createEngineAuditBrowser(config.engine.httpUrl, session, secrets),
                    now: context.now,
                    onError,
                }),
                user: async () => {
                    const user = await users.user();
                    return { sub: user.userUuid, email: user.email };
                },
                onError,
            },
            writer: createEngineWriter({
                httpUrl: config.engine.httpUrl,
                session,
                identitySecret: config.identitySecret,
                now: context.now,
                secrets,
            }),
        });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    logToolCalls(transport, parsedBody, context.logger, sub, context.now);
    res.on('close', () => {
        void transport.close();
        void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
}
