import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccessTokenError, createOktaVerifier, type AccessTokenVerifier } from '../auth/okta.js';
import { createCachedUserResolver } from '../auth/userCache.js';
import { createLightdashUserResolver } from '../auth/userMapping.js';
import type { LlmClient } from '../ask/llm.js';
import type { Config } from '../config.js';
import { configSecrets, createLogger, type Logger } from '../log.js';
import { serveMcpRequest, type McpRequestContext } from '../mcp/server.js';
import { bearerChallenge, extractBearer, type BearerError } from './bearerChallenge.js';
import { MCP_PATH, PROTECTED_RESOURCE_METADATA_PATHS, protectedResourceMetadata } from './protectedResource.js';

/** Injectable collaborators (all optional). */
export interface ServerDeps {
    /** Server clock, epoch ms. Default: `Date.now`. */
    now: () => number;
    /**
     * Receives each structured log line (one JSON object, no newline), at or above `LOG_LEVEL`. Default: stdout.
     */
    log: (line: string) => void;
    /** The model client for AI features (plan advice). Default: none, so AI features report "not configured". */
    llm: LlmClient;
}

export interface RunningServer {
    /** Base URL, e.g. `http://127.0.0.1:8080` (no path). */
    url: string;
    close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

function allowGetOnly(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    res.setHeader('Allow', 'GET, HEAD');
    sendJson(res, 405, { error: 'method_not_allowed' });
    return false;
}

/** Paths named in request log lines; any other path is logged as `(other)`, so a probe's URL is never echoed. */
const KNOWN_PATHS = new Set(['/healthz', MCP_PATH, ...PROTECTED_RESOURCE_METADATA_PATHS]);

/** The request's path for a log line: a known path as is, anything else (or an unparseable URL) as `(other)`. */
function loggedPath(url: string | undefined): string {
    try {
        const { pathname } = new URL(url ?? '/', 'http://localhost');
        return KNOWN_PATHS.has(pathname) ? pathname : '(other)';
    } catch {
        return '(other)';
    }
}

function sendUnauthorized(
    config: Config,
    logger: Logger,
    reason: 'missing' | 'malformed' | 'invalid',
    res: http.ServerResponse,
    err?: BearerError,
): void {
    logger.warn('unauthorized request', { reason });
    res.setHeader('WWW-Authenticate', bearerChallenge(config, err));
    sendJson(res, 401, err ? { error: err.error, error_description: err.description } : { error: 'unauthorized' });
}

/**
 * Every request to `/mcp` must carry a valid Okta bearer token; anything else gets a 401 challenge pointing at the
 * protected-resource metadata, before any other work (no Lightdash or engine call).
 */
async function handleMcp(
    config: Config,
    context: McpRequestContext,
    verifier: AccessTokenVerifier,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    const { logger } = context;
    const bearer = extractBearer(req.headers);
    if (bearer.kind === 'missing') {
        sendUnauthorized(config, logger, 'missing', res);
        return;
    }
    if (bearer.kind === 'malformed') {
        sendUnauthorized(config, logger, 'malformed', res, {
            error: 'invalid_token',
            description: 'The access token is malformed',
        });
        return;
    }
    let verified;
    try {
        verified = await verifier.verify(bearer.token);
    } catch (err) {
        // Fail closed: anything that stops verification (bad token, unreachable JWKS) is a 401.
        const description = err instanceof AccessTokenError ? err.description : 'The access token could not be verified';
        sendUnauthorized(config, logger, 'invalid', res, { error: 'invalid_token', description });
        return;
    }
    await serveMcpRequest(config, context, verified, req, res);
}

async function handle(
    config: Config,
    context: McpRequestContext,
    verifier: AccessTokenVerifier,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/healthz') {
        if (allowGetOnly(req, res)) sendJson(res, 200, { status: 'ok' });
        return;
    }
    if (PROTECTED_RESOURCE_METADATA_PATHS.includes(pathname)) {
        if (allowGetOnly(req, res)) sendJson(res, 200, protectedResourceMetadata(config));
        return;
    }
    if (pathname === MCP_PATH) {
        await handleMcp(config, context, verifier, req, res);
        return;
    }
    sendJson(res, 404, { error: 'not_found' });
}

export async function startServer({
    config,
    deps = {},
}: {
    config: Config;
    deps?: Partial<ServerDeps>;
}): Promise<RunningServer> {
    const verifier = createOktaVerifier(config.okta);
    const now = deps.now ?? Date.now;
    const logger = createLogger({
        level: config.logLevel,
        write: deps.log,
        secrets: configSecrets(config),
        now,
    });
    const context: McpRequestContext = {
        users: createCachedUserResolver(createLightdashUserResolver(config.lightdash), config.userCacheTtlMs, now),
        now,
        logger,
        llm: deps.llm,
    };
    const server = http.createServer((req, res) => {
        const start = now();
        res.once('finish', () => {
            logger.debug('http request', {
                method: req.method,
                path: loggedPath(req.url),
                status: res.statusCode,
                durationMs: Math.max(0, now() - start),
            });
        });
        handle(config, context, verifier, req, res).catch((err: unknown) => {
            logger.error('request failed', { error: err instanceof Error ? err.name : typeof err });
            if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
            else res.end();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    logger.info('telemetry-mcp listening', { url });
    return {
        url,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}
