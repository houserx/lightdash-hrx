/**
 * Federation Engine client over pg-wire (CONTRACTS §1).
 *
 * One new connection per query: connect, run the statement with bind parameters (pg's extended protocol, so user
 * input never travels inside the SQL text), then close the connection whatever happened. Nothing is pooled, so
 * no session state can leak from one tool call to the next.
 *
 * Not here yet: `mcp-engine-session` adds `SET hrx.identity` and `SET statement_timeout` before the query, and
 * `mcp-engine-error-mapping` turns SQLSTATEs into tool errors. Only §1.1 table functions and `information_schema`
 * may be queried, never `pg_*`.
 */
import pg from 'pg';
import type { Config } from '../config.js';

/** Gives up connecting after this long, so an unreachable engine fails the tool call instead of hanging it. */
export const ENGINE_CONNECT_TIMEOUT_MS = 10_000;

export interface EngineResult {
    columns: string[];
    rows: Record<string, unknown>[];
}

export interface EngineClient {
    query(sql: string, params?: readonly unknown[]): Promise<EngineResult>;
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

export function createEngineClient(engine: Config['engine']): EngineClient {
    return {
        async query(sql, params = []) {
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
