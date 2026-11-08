/**
 * Federation Engine client over pg-wire (CONTRACTS §1).
 *
 * One new connection per query: connect, send `SET hrx.identity = '<§3 token>'` and `SET statement_timeout = <ms>`,
 * run the statement with bind parameters (pg's extended protocol, so user input never travels inside the SQL text),
 * then close the connection whatever happened. Nothing is pooled, so no session state can leak from one tool call to
 * the next, and every query carries a freshly minted identity token (new `iat`, new nonce).
 *
 * Not here yet: `mcp-engine-error-mapping` turns SQLSTATEs into tool errors. Only §1.1 table functions and
 * `information_schema` may be queried, never `pg_*`.
 */
import pg from 'pg';
import type { Config } from '../config.js';
import type { IdentityAuditInput } from '../identity/token.js';

/** Gives up connecting after this long, so an unreachable engine fails the tool call instead of hanging it. */
export const ENGINE_CONNECT_TIMEOUT_MS = 10_000;

/** §3 tokens are unpadded base64url plus one `.`, so they can be quoted in a `SET` literal without escaping. */
const IDENTITY_TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface EngineResult {
    columns: string[];
    rows: Record<string, unknown>[];
}

export interface EngineQueryOptions {
    /** The audit block of the identity token (Audited Queries need a description). Default: no audit. */
    audit?: IdentityAuditInput | null;
}

export interface EngineClient {
    query(sql: string, params?: readonly unknown[], options?: EngineQueryOptions): Promise<EngineResult>;
}

/** Who the queries run as. `identityToken` is called once per query and must mint a fresh §3 token. */
export interface EngineSession {
    identityToken(audit: IdentityAuditInput | null): Promise<string>;
    statementTimeoutMs: number;
}

/** A failed engine statement. `code` is the SQLSTATE when the engine sent one. */
export class EngineError extends Error {
    readonly code: string | undefined;

    constructor(message: string, code: string | undefined, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'EngineError';
        this.code = code;
    }
}

function sqlState(err: unknown): string | undefined {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** The two session `SET`s sent before every query, in order. */
export function sessionStatements(identityToken: string, statementTimeoutMs: number): string[] {
    if (!IDENTITY_TOKEN_SHAPE.test(identityToken)) throw new Error('identity token is not a §3 token');
    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1) {
        throw new Error('statement timeout must be a positive integer');
    }
    return [`SET hrx.identity = '${identityToken}'`, `SET statement_timeout = ${statementTimeoutMs}`];
}

export function createEngineClient(engine: Config['engine'], session: EngineSession): EngineClient {
    return {
        async query(sql, params = [], options = {}) {
            // Minted before connecting: a user who cannot be identified never opens a connection. The error is the
            // identity layer's own fixed sentence (no token, claim or secret in it).
            let setStatements: string[];
            try {
                setStatements = sessionStatements(
                    await session.identityToken(options.audit ?? null),
                    session.statementTimeoutMs,
                );
            } catch (err) {
                throw new EngineError(err instanceof Error ? err.message : 'could not identify the caller', undefined, {
                    cause: err,
                });
            }
            const client = new pg.Client({
                host: engine.pgHost,
                port: engine.pgPort,
                user: engine.pgUser,
                password: engine.pgPassword,
                database: engine.pgDatabase,
                connectionTimeoutMillis: ENGINE_CONNECT_TIMEOUT_MS,
            });
            // An idle-connection error after the query must not crash the process; the query result already decided.
            client.on('error', () => undefined);
            try {
                await client.connect();
                // Simple-protocol SETs on the same connection, before the query.
                for (const statement of setStatements) await client.query(statement);
                const result = await client.query({ text: sql, values: [...params] });
                return { columns: result.fields.map((f) => f.name), rows: result.rows };
            } catch (err) {
                const code = sqlState(err);
                // The driver's message can name the host or user; keep only the engine's own message.
                const message = code && err instanceof Error ? err.message : 'could not reach the Federation Engine';
                throw new EngineError(message, code, { cause: err });
            } finally {
                await client.end().catch(() => undefined);
            }
        },
    };
}
