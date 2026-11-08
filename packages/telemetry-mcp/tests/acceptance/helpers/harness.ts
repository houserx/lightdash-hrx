/**
 * Acceptance-test harness: starts a fake Okta, a fake Lightdash, a fake Federation Engine, and the
 * real telemetry MCP server (through the package's public entry `src/index.ts`) on ephemeral ports,
 * then talks to it as an MCP client over streamable HTTP with an Okta bearer token.
 *
 * The public API this harness relies on is documented in PROGRESS.md ("Public API pinned by the
 * acceptance tests"). PROTECTED: do not edit.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as pkg from '../../../src/index';
import { startFakeEngine, type FakeEngine } from './engine';
import { startFakeLightdash, type FakeAttribute, type FakeLightdash, type FakeUser } from './lightdash';
import { startFakeOkta, TEST_AUDIENCE, type FakeOkta } from './okta';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const api = pkg as any;

export const IDENTITY_SECRET = 'test-identity-secret-not-real';
export const SERVICE_TOKEN = 'test-service-token-not-real';
export const PUBLIC_URL = 'https://telemetry-mcp.example.test';
export const PROJECT_UUID = '5c0f8d2e-6b7a-4c1d-9e8f-0a1b2c3d4e5f';
export const ORG_UUID = '9b1e7c3a-2d4f-4a6b-8c0d-1e2f3a4b5c6d';
export const OPS_GROUP_UUID = 'c4d5e6f7-0a1b-4c2d-8e3f-4a5b6c7d8e9f';

export const ANALYST: FakeUser = {
    userUuid: '3f6d0c1e-8a52-4d0b-9c7e-1a2b3c4d5e6f',
    email: 'analyst@example.test',
    organizationUuid: ORG_UUID,
    groups: [{ uuid: OPS_GROUP_UUID, name: 'ops-readers' }],
};

export const VIEWER: FakeUser = {
    userUuid: '8e7d6c5b-4a39-4281-8f0e-d1c2b3a4f5e6',
    email: 'viewer@example.test',
    organizationUuid: ORG_UUID,
    groups: [],
};

/** analyst: platform_read (direct), platform_explain (via group). viewer: nothing. */
export const DEFAULT_ATTRIBUTES: FakeAttribute[] = [
    { name: 'platform_read', users: [{ userUuid: ANALYST.userUuid, value: 'true' }], attributeDefault: 'false' },
    { name: 'platform_explain', groups: [{ groupUuid: OPS_GROUP_UUID, value: 'true' }], attributeDefault: 'false' },
    { name: 'platform_write', users: [], attributeDefault: 'false' },
    { name: 'telemetry_restricted', users: [], attributeDefault: 'false' },
];

export const DEFAULT_SOURCES = [
    { name: 'prometheus-production', kind: 'prometheus', default: true },
    { name: 'loki-production', kind: 'loki', default: true },
    { name: 'loki-platform', kind: 'loki', restricted: true },
    { name: 'cloudwatch-production', kind: 'cloudwatch', default: true },
    { name: 'cloudwatch-logs-production', kind: 'cloudwatch_logs', default: true },
    { name: 'tempo-production', kind: 'tempo', default: true },
    { name: 'platform', kind: 'platform_postgres' },
];

export interface ToolOutcome {
    isError: boolean;
    text: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    structured: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: any;
}

export interface HarnessOptions {
    users?: FakeUser[];
    attributes?: FakeAttribute[];
    /** Extra / overriding env vars for loadConfig. */
    env?: Record<string, string | undefined>;
    /** deps.llm */
    llm?: unknown;
    /** deps.askMemoryStore */
    askMemoryStore?: unknown;
    /** deps.now (epoch ms) */
    now?: () => number;
}

export interface Harness {
    okta: FakeOkta;
    lightdash: FakeLightdash;
    engine: FakeEngine;
    serverUrl: string;
    mcpUrl: string;
    env: Record<string, string | undefined>;
    logs: string[];
    /** An Okta access token for a user (default: the analyst, identified by its email claim). */
    token(claims?: Record<string, unknown>): string;
    connect(token?: string): Promise<Client>;
    call(name: string, args?: Record<string, unknown>, token?: string): Promise<ToolOutcome>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listTools(token?: string): Promise<any[]>;
    close(): Promise<void>;
}

export function baseEnv(parts: {
    okta: FakeOkta;
    lightdash: FakeLightdash;
    engine: FakeEngine;
}): Record<string, string> {
    return {
        MCP_HOST: '127.0.0.1',
        MCP_PORT: '0',
        MCP_PUBLIC_URL: PUBLIC_URL,
        OKTA_ISSUER: parts.okta.issuer,
        OKTA_AUDIENCE: TEST_AUDIENCE,
        OKTA_JWKS_URI: parts.okta.jwksUri,
        LIGHTDASH_URL: parts.lightdash.url,
        LIGHTDASH_API_TOKEN: SERVICE_TOKEN,
        LIGHTDASH_PROJECT_UUID: PROJECT_UUID,
        ENGINE_PG_HOST: parts.engine.pgHost,
        ENGINE_PG_PORT: String(parts.engine.pgPort),
        ENGINE_PG_USER: parts.engine.pgUser,
        ENGINE_PG_PASSWORD: parts.engine.pgPassword,
        ENGINE_PG_DATABASE: parts.engine.pgDatabase,
        ENGINE_HTTP_URL: parts.engine.httpUrl,
        HRX_IDENTITY_SECRET: IDENTITY_SECRET,
        MCP_SOURCES: JSON.stringify(DEFAULT_SOURCES),
        MCP_PLATFORM_SOURCE: 'platform',
        MCP_STATEMENT_TIMEOUT_MS: '30000',
        MCP_MAX_ROWS: '1000',
        MCP_MAX_OUTPUT_BYTES: '200000',
        MCP_USER_CACHE_TTL_MS: '60000',
        LOG_LEVEL: 'debug',
    };
}

export async function callOn(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    try {
        const raw = await client.callTool({ name, arguments: args });
        const content = (raw.content ?? []) as { type: string; text?: string }[];
        const text = content
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n');
        return { isError: raw.isError === true, text, structured: raw.structuredContent, raw };
    } catch (err) {
        // Input-schema violations may surface as JSON-RPC errors depending on the SDK version.
        return { isError: true, text: err instanceof Error ? err.message : String(err), structured: undefined, raw: err };
    }
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
    const okta = await startFakeOkta();
    const lightdash = await startFakeLightdash({
        serviceToken: SERVICE_TOKEN,
        users: opts.users ?? [ANALYST, VIEWER],
        attributes: opts.attributes ?? DEFAULT_ATTRIBUTES,
    });
    const engine = await startFakeEngine();
    engine.on(/information_schema\.tables/i, {
        columns: [
            { name: 'table_catalog', type: 'text' },
            { name: 'table_schema', type: 'text' },
            { name: 'table_name', type: 'text' },
        ],
        rows: [
            ['ops_marts', 'ops_marts', 'fills_hourly'],
            ['ops_marts', 'ops_marts', 'queue_depth'],
        ],
    });
    const env: Record<string, string | undefined> = { ...baseEnv({ okta, lightdash, engine }), ...(opts.env ?? {}) };
    const logs: string[] = [];
    const deps: Record<string, unknown> = { log: (line: string) => logs.push(line) };
    if (opts.llm) deps.llm = opts.llm;
    if (opts.askMemoryStore) deps.askMemoryStore = opts.askMemoryStore;
    if (opts.now) deps.now = opts.now;

    if (typeof api.loadConfig !== 'function' || typeof api.startServer !== 'function') {
        throw new Error('src/index.ts must export loadConfig(env) and startServer({ config, deps })');
    }
    const config = api.loadConfig(env);
    const server = (await api.startServer({ config, deps })) as { url: string; close(): Promise<void> };
    const serverUrl = server.url.replace(/\/$/, '');
    const mcpUrl = `${serverUrl}/mcp`;
    const clients: Client[] = [];

    const token = (claims: Record<string, unknown> = {}): string =>
        okta.sign({ sub: '00u-test-analyst', email: ANALYST.email, ...claims });

    const connect = async (tok?: string): Promise<Client> => {
        const bearer = tok ?? token();
        const client = new Client({ name: 'acceptance-test', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
            requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
        });
        await client.connect(transport);
        clients.push(client);
        return client;
    };

    const clientByToken = new Map<string, Client>();
    const clientFor = async (tok?: string): Promise<Client> => {
        const bearer = tok ?? token();
        let c = clientByToken.get(bearer);
        if (!c) {
            c = await connect(bearer);
            clientByToken.set(bearer, c);
        }
        return c;
    };

    return {
        okta,
        lightdash,
        engine,
        serverUrl,
        mcpUrl,
        env,
        logs,
        token,
        connect,
        call: async (name, args = {}, tok) => callOn(await clientFor(tok), name, args),
        listTools: async (tok) => (await (await clientFor(tok)).listTools()).tools,
        async close() {
            for (const c of clients) await c.close().catch(() => undefined);
            await server.close();
            await Promise.all([okta.close(), lightdash.close(), engine.close()]);
        },
    };
}

/** The identity token sent with `SET hrx.identity` on the connection that ran `q`. */
export function identityOf(q: { sets: Record<string, string> }): string {
    const t = q.sets['hrx.identity'];
    if (!t) throw new Error('no SET hrx.identity before this statement on its connection');
    return t;
}

/** Data statements whose SQL matches `re`. */
export function queriesMatching(engine: FakeEngine, re: RegExp) {
    return engine.dataQueries().filter((q) => re.test(q.sql));
}

/** Column helper for engine results. */
export const TS_SERIES_COLUMNS = [
    { name: 'timestamp', type: 'timestamptz' as const },
    { name: 'value', type: 'float8' as const },
    { name: 'labels', type: 'json' as const },
    { name: 'series', type: 'text' as const },
];
