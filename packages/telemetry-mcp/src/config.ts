/**
 * Server settings read from env.
 *
 * `loadConfig` collects every problem before failing, so one start attempt tells the operator about every
 * missing or malformed variable. Messages name the variable and the rule it broke but never echo a value:
 * several variables are secrets, and a malformed secret is still a secret.
 */

/** Telemetry Source kinds the Federation Engine knows (CONTRACTS §1.4). */
export const SOURCE_KINDS = [
    'prometheus',
    'loki',
    'cloudwatch',
    'cloudwatch_logs',
    'tempo',
    'platform_postgres',
    'bigquery',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** The non-secret part of one engine `[[sources]]` entry, mirrored in `MCP_SOURCES`. */
export interface SourceConfig {
    name: string;
    kind: SourceKind;
    default: boolean;
    restricted: boolean;
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
    host: string;
    port: number;
    /** Public base URL of this server, without a trailing slash. */
    publicUrl: string;
    okta: {
        /** Exactly as configured: it must equal the token's `iss` claim. */
        issuer: string;
        audience: string;
        jwksUri: string;
    };
    lightdash: {
        /** Without a trailing slash. */
        url: string;
        apiToken: string;
        projectUuid: string;
    };
    engine: {
        pgHost: string;
        pgPort: number;
        pgUser: string;
        pgPassword: string;
        pgDatabase: string;
        /** Without a trailing slash. */
        httpUrl: string;
    };
    identitySecret: string;
    sources: SourceConfig[];
    platformSource: string;
    statementTimeoutMs: number;
    maxRows: number;
    maxOutputBytes: number;
    userCacheTtlMs: number;
    askMaxSteps: number;
    /** Absent when the AI features are not configured. */
    anthropicApiKey: string | undefined;
    logLevel: LogLevel;
}

export class ConfigError extends Error {
    readonly problems: string[];

    constructor(problems: string[]) {
        super(
            `Invalid configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${problems
                .map((p) => `  - ${p}`)
                .join('\n')}`,
        );
        this.name = 'ConfigError';
        this.problems = problems;
    }
}

type Env = Record<string, string | undefined>;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads env and checks it, recording problems instead of throwing so every one is reported. */
class Reader {
    readonly problems: string[] = [];

    constructor(private readonly env: Env) {}

    /** Trimmed value, or undefined when unset or blank. */
    private raw(name: string): string | undefined {
        const value = this.env[name];
        if (value === undefined) return undefined;
        const trimmed = value.trim();
        return trimmed === '' ? undefined : trimmed;
    }

    private problem(message: string): void {
        this.problems.push(message);
    }

    requiredString(name: string): string {
        const value = this.raw(name);
        if (value === undefined) this.problem(`${name} is required`);
        return value ?? '';
    }

    /** A secret: required, used exactly as given (only blank counts as missing), never echoed. */
    requiredSecret(name: string): string {
        const value = this.env[name];
        if (value === undefined || value.trim() === '') {
            this.problem(`${name} is required`);
            return '';
        }
        return value;
    }

    optionalSecret(name: string): string | undefined {
        const value = this.env[name];
        return value === undefined || value.trim() === '' ? undefined : value;
    }

    optionalString(name: string, fallback: string): string {
        return this.raw(name) ?? fallback;
    }

    /** An absolute http(s) URL. `stripSlash` drops trailing slashes so callers can append paths. */
    url(name: string, opts: { required: true; stripSlash: boolean }): string;
    url(name: string, opts: { required: false; stripSlash: boolean }): string | undefined;
    url(name: string, opts: { required: boolean; stripSlash: boolean }): string | undefined {
        const value = this.raw(name);
        if (value === undefined) {
            if (opts.required) this.problem(`${name} is required`);
            return opts.required ? '' : undefined;
        }
        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            this.problem(`${name} must be an absolute http(s) URL`);
            return '';
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            this.problem(`${name} must be an absolute http(s) URL`);
            return '';
        }
        if (parsed.username !== '' || parsed.password !== '') {
            this.problem(`${name} must not contain credentials`);
            return '';
        }
        return opts.stripSlash ? value.replace(/\/+$/, '') : value;
    }

    uuid(name: string): string {
        const value = this.requiredString(name);
        if (value !== '' && !UUID_RE.test(value)) this.problem(`${name} must be a UUID`);
        return value;
    }

    integer(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
        const value = this.raw(name);
        if (value === undefined) return fallback;
        const n = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) {
            const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `between ${min} and ${max}`;
            this.problem(`${name} must be an integer ${range}`);
            return fallback;
        }
        return n;
    }

    oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
        const value = this.raw(name);
        if (value === undefined) return fallback;
        const lower = value.toLowerCase();
        if (!(allowed as readonly string[]).includes(lower)) {
            this.problem(`${name} must be one of ${allowed.join(', ')}`);
            return fallback;
        }
        return lower as T;
    }

    sources(name: string): SourceConfig[] {
        const value = this.raw(name);
        if (value === undefined) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(value);
        } catch {
            this.problem(`${name} must be valid JSON (a list of {name, kind, default?, restricted?})`);
            return [];
        }
        if (!Array.isArray(parsed)) {
            this.problem(`${name} must be a JSON list of {name, kind, default?, restricted?}`);
            return [];
        }
        const sources: SourceConfig[] = [];
        const seen = new Set<string>();
        parsed.forEach((entry: unknown, i) => {
            const where = `${name}[${i}]`;
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                this.problem(`${where} must be an object`);
                return;
            }
            const e = entry as Record<string, unknown>;
            const problemsBefore = this.problems.length;
            if (typeof e.name !== 'string' || e.name.trim() === '') {
                this.problem(`${where}.name must be a non-empty string`);
            } else if (seen.has(e.name)) {
                this.problem(`${where}.name duplicates an earlier entry`);
            }
            if (typeof e.kind !== 'string' || !(SOURCE_KINDS as readonly string[]).includes(e.kind)) {
                this.problem(`${where}.kind must be one of ${SOURCE_KINDS.join(', ')}`);
            }
            for (const flag of ['default', 'restricted'] as const) {
                if (e[flag] !== undefined && typeof e[flag] !== 'boolean') {
                    this.problem(`${where}.${flag} must be true or false`);
                }
            }
            if (this.problems.length > problemsBefore) return;
            const source = e as { name: string; kind: SourceKind; default?: boolean; restricted?: boolean };
            seen.add(source.name);
            sources.push({
                name: source.name,
                kind: source.kind,
                default: source.default ?? false,
                restricted: source.restricted ?? false,
            });
        });
        return sources;
    }
}

/**
 * Builds the server's settings from env. Throws a `ConfigError` naming every missing or malformed variable;
 * the message never contains a value read from env.
 */
export function loadConfig(env: Env): Config {
    const r = new Reader(env);

    const host = r.optionalString('MCP_HOST', '0.0.0.0');
    const port = r.integer('MCP_PORT', 8080, 0, 65535);
    const publicUrl = r.url('MCP_PUBLIC_URL', { required: true, stripSlash: true });

    const issuer = r.url('OKTA_ISSUER', { required: true, stripSlash: false });
    const audience = r.requiredString('OKTA_AUDIENCE');
    const jwksUri =
        r.url('OKTA_JWKS_URI', { required: false, stripSlash: false }) ?? `${issuer.replace(/\/+$/, '')}/v1/keys`;

    const lightdashUrl = r.url('LIGHTDASH_URL', { required: true, stripSlash: true });
    const lightdashApiToken = r.requiredSecret('LIGHTDASH_API_TOKEN');
    const projectUuid = r.uuid('LIGHTDASH_PROJECT_UUID');

    const pgHost = r.requiredString('ENGINE_PG_HOST');
    const pgPort = r.integer('ENGINE_PG_PORT', 5433, 1, 65535);
    const pgUser = r.requiredString('ENGINE_PG_USER');
    const pgPassword = r.requiredSecret('ENGINE_PG_PASSWORD');
    const pgDatabase = r.optionalString('ENGINE_PG_DATABASE', 'operations');
    const engineHttpUrl = r.url('ENGINE_HTTP_URL', { required: true, stripSlash: true });

    const identitySecret = r.requiredSecret('HRX_IDENTITY_SECRET');

    const sources = r.sources('MCP_SOURCES');
    const platformSource = r.optionalString('MCP_PLATFORM_SOURCE', 'platform');
    const statementTimeoutMs = r.integer('MCP_STATEMENT_TIMEOUT_MS', 30_000, 1);
    const maxRows = r.integer('MCP_MAX_ROWS', 1000, 1);
    const maxOutputBytes = r.integer('MCP_MAX_OUTPUT_BYTES', 200_000, 1);
    const userCacheTtlMs = r.integer('MCP_USER_CACHE_TTL_MS', 60_000, 0);
    const askMaxSteps = r.integer('MCP_ASK_MAX_STEPS', 60, 1);
    const anthropicApiKey = r.optionalSecret('ANTHROPIC_API_KEY');
    const logLevel = r.oneOf('LOG_LEVEL', LOG_LEVELS, 'info');

    if (r.problems.length > 0) throw new ConfigError(r.problems);

    return {
        host,
        port,
        publicUrl,
        okta: { issuer, audience, jwksUri },
        lightdash: { url: lightdashUrl, apiToken: lightdashApiToken, projectUuid },
        engine: { pgHost, pgPort, pgUser, pgPassword, pgDatabase, httpUrl: engineHttpUrl },
        identitySecret,
        sources,
        platformSource,
        statementTimeoutMs,
        maxRows,
        maxOutputBytes,
        userCacheTtlMs,
        askMaxSteps,
        anthropicApiKey,
        logLevel,
    };
}
