/**
 * The Federation Engine audit browser (CONTRACTS §1.3): `GET /v1/audit?ticket=&user=&month=YYYY-MM&cursor=` on the
 * engine's HTTP side port. It needs `attrs.platform_read` and answers `{ items: Execution[], nextCursor }`, where an
 * item is the portal's audit record (§6, portal `api/src/dynamo/executions.ts`).
 *
 * Every call carries a freshly minted identity token of the caller as `Authorization: Bearer <token>` (not audited:
 * the token's audit block is all nulls). A failed call becomes an `AuditBrowserError` whose message names the HTTP
 * status and the engine's own message, with the token and anything token-shaped removed.
 */
import type { EngineSession } from './client.js';
import { redactSecrets } from './errors.js';

/** Gives up on the audit browser after this long, so a hung engine fails the caller instead of blocking it. */
export const AUDIT_BROWSER_TIMEOUT_MS = 10_000;

/** One audit record, in the portal's `Execution` shape. */
export interface Execution {
    id: string;
    sql: string;
    mode: 'read' | 'write';
    description: string;
    database: string;
    linearTicketId?: string;
    savedScriptId?: string;
    executedByEmail: string;
    executedBySub: string;
    status: 'success' | 'error';
    rowCount: number | null;
    durationMs: number;
    errorMessage: string | null;
    /** True when the write ran inside a rolled-back Preview transaction (no data was committed). */
    preview: boolean;
    action: 'query' | 'export' | 'assertion' | 'ai_ask';
    integrityHash: string;
    createdAt: string;
    createdAtMonth: string;
}

/** The §1.3 filters. Undefined values are not sent. */
export interface AuditQuery {
    ticket?: string;
    user?: string;
    /** `YYYY-MM`. */
    month?: string;
    cursor?: string;
}

export interface AuditPage {
    items: Execution[];
    nextCursor: string | null;
}

export interface AuditBrowser {
    list(query?: AuditQuery): Promise<AuditPage>;
}

/** A failed audit browser call. The message is safe to show to the MCP client. */
export class AuditBrowserError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'AuditBrowserError';
    }
}

/** The path and query string for one audit browser call. */
export function auditPath(query: AuditQuery = {}): string {
    const params = new URLSearchParams();
    for (const key of ['ticket', 'user', 'month', 'cursor'] as const) {
        const value = query[key];
        if (value !== undefined) params.set(key, value);
    }
    const search = params.toString();
    return `/v1/audit${search ? `?${search}` : ''}`;
}

function engineErrorMessage(body: unknown): string | undefined {
    const b = body as { error?: unknown; message?: unknown } | null | undefined;
    const nested = (b?.error as { message?: unknown } | null | undefined)?.message;
    for (const candidate of [b?.message, b?.error, nested]) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    }
    return undefined;
}

/**
 * `httpUrl` is `ENGINE_HTTP_URL` (no trailing slash). `secrets` are other values that must never appear in an error
 * message; each call's identity token is always redacted.
 */
export function createEngineAuditBrowser(
    httpUrl: string,
    session: Pick<EngineSession, 'identityToken'>,
    secrets: readonly (string | undefined)[] = [],
): AuditBrowser {
    const what = 'The Federation Engine audit browser request';
    return {
        async list(query) {
            let token: string;
            try {
                token = await session.identityToken(null);
            } catch (err) {
                throw new AuditBrowserError(err instanceof Error ? err.message : 'could not identify the caller', {
                    cause: err,
                });
            }
            let response: Response;
            try {
                response = await fetch(`${httpUrl}${auditPath(query)}`, {
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                    signal: AbortSignal.timeout(AUDIT_BROWSER_TIMEOUT_MS),
                });
            } catch (err) {
                throw new AuditBrowserError(`${what} failed: could not reach the Federation Engine`, { cause: err });
            }
            const body: unknown = await response.json().catch(() => undefined);
            if (!response.ok) {
                const message = engineErrorMessage(body);
                throw new AuditBrowserError(
                    redactSecrets(`${what} failed with HTTP ${response.status}${message ? `: ${message}` : ''}`, [
                        token,
                        ...secrets,
                    ]),
                );
            }
            const page = body as { items?: unknown; nextCursor?: unknown } | undefined;
            const nextCursor = page?.nextCursor;
            if (
                !Array.isArray(page?.items) ||
                !(nextCursor === undefined || nextCursor === null || typeof nextCursor === 'string')
            ) {
                throw new AuditBrowserError(`${what} failed: the Federation Engine sent an unexpected response`);
            }
            return {
                items: page.items as Execution[],
                nextCursor: typeof nextCursor === 'string' && nextCursor !== '' ? nextCursor : null,
            };
        },
    };
}
