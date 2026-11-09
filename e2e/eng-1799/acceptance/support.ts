/* eslint-disable */
// @ts-nocheck
/**
 * Shared helpers for the ENG-1799 e2e acceptance checks (protected).
 *
 * The harness under test lives in `e2e/eng-1799/harness/` (not protected; the integration line
 * builds it). Its API is described in PROGRESS.md ("Harness API"). The checks reach it only
 * through `harness()` below, so a missing harness fails every check with a clear message.
 */
import { createHash, createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const EXPECTED_ENGINE_BINARY = path.join(REPO_ROOT, 'tmp/cargo-target/debug/engine');
export const IDENTITY_SECRET = 'test-identity-secret-not-real';
export const AUDIT_INTEGRITY_KEY = 'test-integrity-key-not-real';

/** Synthetic identities. Never real people. */
export const USER_UUID = '0f6c1f7e-1111-4c4c-8a8a-000000000001';
export const USER_EMAIL = 'e2e.analyst@example.test';
export const ORG_UUID = '0f6c1f7e-2222-4c4c-8a8a-000000000002';
export const PROJECT_UUID = '0f6c1f7e-3333-4c4c-8a8a-000000000003';

export const ALL_FALSE = {
    telemetry_restricted: false,
    platform_read: false,
    platform_write: false,
    platform_explain: false,
};

let cached: any;
export async function harness(): Promise<any> {
    if (cached) return cached;
    const file = path.join(REPO_ROOT, 'e2e/eng-1799/harness/index.ts');
    if (!fs.existsSync(file)) {
        throw new Error('e2e/eng-1799/harness/index.ts does not exist yet (feature int-harness-engine)');
    }
    const spec = '../harness/index';
    cached = await import(/* @vite-ignore */ spec);
    return cached;
}

/** Lightdash source modules, loaded lazily by path relative to the repo root. */
export async function load(relativeToRepo: string): Promise<any> {
    const spec = path.join(REPO_ROOT, relativeToRepo);
    return import(/* @vite-ignore */ spec);
}

/** CreatePostgresCredentials for a federation-flavour connection to a harness engine. */
export function federationCredentials(engine: any, overrides: Record<string, unknown> = {}) {
    return {
        type: 'postgres',
        flavor: 'federation',
        host: engine.host ?? '127.0.0.1',
        port: engine.pgPort,
        user: engine.user,
        password: engine.password,
        dbname: engine.database ?? 'operations',
        schema: 'public',
        sslmode: 'disable',
        identitySigningSecret: IDENTITY_SECRET,
        httpBaseUrl: engine.httpUrl,
        ...overrides,
    };
}

export type PgOutcome = { rows: any[]; fields: { name: string; dataTypeID: number }[]; error?: { code?: string; message: string } };

/**
 * Runs `statements` in order on ONE new pg-wire connection to the engine (extended protocol for
 * the last statement when `params` is given). Returns the last statement's rows, or the first
 * error with its SQLSTATE.
 */
export async function pgRun(engine: any, statements: string[], params?: unknown[]): Promise<PgOutcome> {
    const client = new pg.Client({
        host: engine.host ?? '127.0.0.1',
        port: engine.pgPort,
        user: engine.user,
        password: engine.password,
        database: engine.database ?? 'operations',
    });
    try {
        await client.connect();
    } catch (error: any) {
        await client.end().catch(() => undefined);
        return { rows: [], fields: [], error: { code: error?.code, message: String(error?.message ?? error) } };
    }
    try {
        let last: any = { rows: [], fields: [] };
        for (let i = 0; i < statements.length; i++) {
            const isLast = i === statements.length - 1;
            last = isLast && params ? await client.query(statements[i], params) : await client.query(statements[i]);
        }
        return { rows: last.rows, fields: last.fields.map((f: any) => ({ name: f.name, dataTypeID: f.dataTypeID })) };
    } catch (error: any) {
        return { rows: [], fields: [], error: { code: error?.code, message: String(error?.message ?? error) } };
    } finally {
        await client.end().catch(() => undefined);
    }
}

export const setIdentity = (token: string) => `SET hrx.identity = '${token.replaceAll("'", "''")}'`;

/** The db-query-portal's computeIntegrityHash (api/src/services/audit.service.ts @ aea73de). */
export function portalIntegrityHash(item: any, key: string | null = AUDIT_INTEGRITY_KEY): string {
    const canonical = JSON.stringify({
        sql: item.sql,
        mode: item.mode,
        description: item.description,
        database: item.database,
        // The portal hashes its input, where a missing ticket is null; the stored item omits it.
        linearTicketId: item.linearTicketId ?? null,
        executedBySub: item.executedBySub,
        status: item.status,
        rowCount: item.rowCount,
        preview: item.preview,
        action: item.action ?? 'query',
        createdAt: item.createdAt,
    });
    if (key) return `hmac-sha256:${createHmac('sha256', key).update(canonical).digest('hex')}`;
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Decodes the payload of a §3 identity token or an A6 confirmation token (no verification). */
export function decodePayload(token: string): any {
    const [payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/** Re-signs a modified payload with the wrong key: a tampered token. */
export function tamper(token: string, change: (payload: any) => void): string {
    const payload = decodePayload(token);
    change(payload);
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const [, signature] = token.split('.');
    return `${body}.${signature}`;
}

export async function waitFor<T>(what: string, probe: () => Promise<T | undefined | null | false>, timeoutMs = 60_000, everyMs = 250): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
        try {
            const value = await probe();
            if (value) return value as T;
        } catch (error) {
            last = error;
        }
        await new Promise((r) => setTimeout(r, everyMs));
    }
    throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * A Lightdash session account for service-layer calls (the backend's own account mock), with the
 * given CASL rules. Its user and organization are the mock's: use the returned ids.
 */
export async function buildAccount(rules: { action: string; subject: string }[] = [{ action: 'view', subject: 'Project' }, { action: 'manage', subject: 'SqlRunner' }]) {
    const { buildAccount: build, defaultSessionUser } = await load('packages/backend/src/auth/account/account.mock.ts');
    const { Ability } = await import('@casl/ability');
    const account = build();
    account.user.ability = new Ability(rules);
    return {
        account,
        userUuid: defaultSessionUser.userUuid as string,
        email: defaultSessionUser.email as string,
        organizationUuid: defaultSessionUser.organizationUuid as string,
    };
}

/** FederationService (ldq) wired to a project, in the account mock's organization, whose connection is the harness engine. */
export async function buildFederationService(engine: any, attributes: Record<string, string[]>) {
    const { FederationService } = await load('packages/backend/src/services/FederationService/FederationService.ts');
    const { defaultSessionUser } = await load('packages/backend/src/auth/account/account.mock.ts');
    const project = {
        projectUuid: PROJECT_UUID,
        organizationUuid: defaultSessionUser.organizationUuid,
        name: 'Operations',
        warehouseConnection: federationCredentials(engine),
    };
    return new FederationService({
        projectModel: { getWithSensitiveFields: async () => project },
        userAttributesModel: { getAttributeValuesForOrgMember: async () => attributes },
    });
}

/** An MCP client session against the telemetry MCP server at `baseUrl` with an Okta access token. */
export async function mcpConnect(baseUrl: string, accessToken: string) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'e2e-eng-1799', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    await client.connect(transport);
    return {
        client,
        async call(name: string, args: Record<string, unknown> = {}) {
            try {
                const result: any = await client.callTool({ name, arguments: args });
                const text = (result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
                return { isError: Boolean(result.isError), structured: result.structuredContent, text };
            } catch (error: any) {
                return { isError: true, structured: undefined, text: String(error?.message ?? error) };
            }
        },
        close: () => client.close(),
    };
}

/** ISO helpers on a fixed synthetic day. */
export const T0 = Date.parse('2026-11-08T10:00:00.000Z');
export const iso = (ms: number) => new Date(ms).toISOString();

export async function httpJson(method: string, url: string, { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {}) {
    const response = await fetch(url, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any;
    try {
        json = text ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    return { status: response.status, json, text };
}

const disposers: (() => Promise<unknown>)[] = [];
/** Remembers a started resource (anything with stop() or close()) so disposeAll() stops it. */
export function track<T>(resource: T): T {
    const r: any = resource;
    const fn = r?.stop ?? r?.close;
    if (typeof fn === 'function') disposers.push(() => fn.call(r));
    return resource;
}
/** Stops every tracked resource, newest first. Call it from afterAll. */
export async function disposeAll(): Promise<void> {
    while (disposers.length) {
        try {
            await disposers.pop()!();
        } catch {
            // keep stopping the rest
        }
    }
}

/** A §1.1 time window on the synthetic day: [T0, T0 + minutes]. */
export const windowSql = (minutes: number) => `'${iso(T0)}', '${iso(T0 + minutes * 60_000)}'`;

/** Seconds in a Prometheus step as sent to a source: a number ("60", "60.000") or a duration ("1m", "1h30m"). */
export function durationSeconds(value: string): number {
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
    const units: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
    let total = 0;
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g;
    let consumed = '';
    for (const m of value.matchAll(re)) {
        total += Number(m[1]) * units[m[2]];
        consumed += m[0];
    }
    if (consumed !== value) throw new Error(`not a duration: ${value}`);
    return total;
}

/** A §3 identity token minted by the Lightdash backend's own minting code (ldq identityToken.ts). */
export async function mintBackendToken(over: {
    sub?: string;
    email?: string;
    org?: string;
    project?: string;
    agent?: boolean;
    sys?: boolean;
    attrs?: Record<string, boolean>;
    audit?: { description?: string | null; ticket?: string | null; source?: string; resource_uuid?: string | null };
    now?: Date;
    ttlSeconds?: number;
    secret?: string;
} = {}): Promise<string> {
    const { mintIdentityToken } = await load('packages/backend/src/services/FederationIdentity/identityToken.ts');
    return mintIdentityToken(
        {
            iss: 'lightdash',
            sub: over.sub ?? USER_UUID,
            email: over.email ?? USER_EMAIL,
            org: over.org ?? ORG_UUID,
            project: over.project ?? PROJECT_UUID,
            agent: over.agent ?? false,
            sys: over.sys ?? false,
            attrs: { ...ALL_FALSE, ...(over.attrs ?? {}) },
            audit: { description: null, ticket: null, resource_uuid: null, source: 'investigate', ...(over.audit ?? {}) },
        },
        { secret: over.secret ?? IDENTITY_SECRET, now: over.now ?? new Date(), ttlSeconds: over.ttlSeconds },
    );
}

/** An authenticated call to a harness Lightdash (`Authorization: ApiKey <personal access token>`). */
export async function ld(lightdash: any, method: string, apiPath: string, body?: unknown) {
    return httpJson(method, `${lightdash.baseUrl}${apiPath}`, { headers: { Authorization: `ApiKey ${lightdash.apiKey}` }, body });
}

/** A result cell's raw value, whether rows come as plain values or as Lightdash ResultRow cells. */
export const rawOf = (cell: any) => (cell && typeof cell === 'object' && 'value' in cell && cell.value && typeof cell.value === 'object' && 'raw' in cell.value ? cell.value.raw : cell);

/** Runs an async query (POST .../query/<kind>) and polls GET .../query/{queryUuid} until it settles. */
export async function runAsyncQuery(lightdash: any, kind: string, body: Record<string, unknown>) {
    const started = await ld(lightdash, 'POST', `/api/v2/projects/${lightdash.projectUuid}/query/${kind}`, { context: 'sqlRunner', ...body });
    if (started.status !== 200) return { status: 'error', error: `HTTP ${started.status}: ${started.text}`, rows: [] as any[] };
    const { queryUuid } = started.json.results;
    return waitFor(
        `query ${queryUuid}`,
        async () => {
            const page = await ld(lightdash, 'GET', `/api/v2/projects/${lightdash.projectUuid}/query/${queryUuid}?page=1&pageSize=1000`);
            const r = page.json?.results;
            if (page.status !== 200) return { status: 'error', error: `HTTP ${page.status}: ${page.text}`, rows: [] as any[] };
            if (r?.status === 'ready') return { status: 'ready', error: null, rows: (r.rows ?? []).map((row: any) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, rawOf(v)]))) };
            if (r?.status === 'error' || r?.status === 'expired' || r?.status === 'cancelled') return { status: r.status, error: r.error ?? r.status, rows: [] as any[] };
            return undefined;
        },
        90_000,
        500,
    );
}

/** Waits until the wall clock enters the next `seconds`-aligned slot (Alert Rule scheduling). */
export async function nextSlot(seconds: number) {
    const ms = seconds * 1000;
    const wait = ms - (Date.now() % ms) + 250;
    await new Promise((r) => setTimeout(r, wait));
}
