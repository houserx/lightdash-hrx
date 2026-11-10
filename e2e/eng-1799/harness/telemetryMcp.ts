/**
 * The real telemetry MCP server (packages/telemetry-mcp/src: `loadConfig` + `startServer`), in
 * process on 127.0.0.1 port 0, against a harness engine, a fake Okta and a Lightdash API.
 *
 * The MCP package is loaded lazily (see the rule at the top of index.ts).
 */
import * as path from 'node:path';
import type { EngineSource } from './engine';
import { IDENTITY_SECRET } from './engine';
import { REPO_ROOT } from './util';

export type StartTelemetryMcpOptions = {
    /** A started harness engine (its pg-wire and HTTP endpoints, user and sources). */
    engine: {
        host: string;
        pgPort: number;
        httpUrl: string;
        user: string;
        password: string;
        database: string;
        sources: EngineSource[];
    };
    okta: { issuer: string; jwksUri: string; audience: string };
    lightdashUrl: string;
    lightdashApiToken: string;
    projectUuid: string;
    /** `deps.llm`: the model client for ask_data and plan advice. */
    llm?: unknown;
};

export type TelemetryMcp = {
    /** Base URL without a path; the MCP endpoint is `url + '/mcp'`. */
    url: string;
    /** The server's structured log lines (JSON), in order. */
    logs: string[];
    close(): Promise<void>;
};

/** Public URL the server advertises in its protected-resource metadata (never dialled). */
export const MCP_PUBLIC_URL = 'https://telemetry-mcp.e2e.example.test';

type McpPackage = {
    loadConfig(env: Record<string, string | undefined>): unknown;
    startServer(args: {
        config: unknown;
        deps: Record<string, unknown>;
    }): Promise<{ url: string; close(): Promise<void> }>;
};

export async function startTelemetryMcp(
    opts: StartTelemetryMcpOptions,
): Promise<TelemetryMcp> {
    const entry = path.join(REPO_ROOT, 'packages/telemetry-mcp/src/index.ts');
    const mcp = (await import(/* @vite-ignore */ entry)) as McpPackage;
    const { engine, okta } = opts;
    const env: Record<string, string> = {
        MCP_HOST: '127.0.0.1',
        MCP_PORT: '0',
        MCP_PUBLIC_URL,
        OKTA_ISSUER: okta.issuer,
        OKTA_AUDIENCE: okta.audience,
        OKTA_JWKS_URI: okta.jwksUri,
        LIGHTDASH_URL: opts.lightdashUrl,
        LIGHTDASH_API_TOKEN: opts.lightdashApiToken,
        LIGHTDASH_PROJECT_UUID: opts.projectUuid,
        ENGINE_PG_HOST: engine.host,
        ENGINE_PG_PORT: String(engine.pgPort),
        ENGINE_PG_USER: engine.user,
        ENGINE_PG_PASSWORD: engine.password,
        ENGINE_PG_DATABASE: engine.database,
        ENGINE_HTTP_URL: engine.httpUrl,
        HRX_IDENTITY_SECRET: IDENTITY_SECRET,
        MCP_SOURCES: JSON.stringify(engine.sources),
        MCP_PLATFORM_SOURCE: 'platform',
        MCP_USER_CACHE_TTL_MS: '1',
        LOG_LEVEL: 'debug',
    };
    const config = mcp.loadConfig(env);
    const logs: string[] = [];
    const deps: Record<string, unknown> = {
        log: (line: string) => logs.push(line),
    };
    if (opts.llm !== undefined) deps.llm = opts.llm;
    const server = await mcp.startServer({ config, deps });

    let closing: Promise<void> | undefined;
    return {
        url: server.url.replace(/\/+$/, ''),
        logs,
        close() {
            closing ??= server.close();
            return closing;
        },
    };
}
