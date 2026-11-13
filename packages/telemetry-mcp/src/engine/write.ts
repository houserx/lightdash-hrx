/**
 * Federation Engine Write Mode over HTTP (CONTRACTS §4, §7): `POST ENGINE_HTTP_URL/v1/write`, always with
 * `mode: "preview"`. The MCP server never asks for a commit: a Preview runs the statement in a transaction that the
 * engine rolls back, and answers `{audit_id, rows_affected, preview, returning}`.
 *
 * Every call carries a freshly minted identity token of the caller (with the Preview's description and ticket in its
 * audit block) as `Authorization: Bearer <token>`, and a confirmation token bound to the statement, the caller and
 * the project (Contract assumption 4). A non-2xx status, an unreachable engine, or a reply that is not a Preview
 * (`preview !== true`) becomes an `EngineWriteError` whose message names the HTTP status and the engine's own
 * message, with the tokens and anything token-shaped removed.
 */
import { mintConfirmationToken } from '../identity/confirmation.js';
import { engineErrorMessage } from './audit.js';
import type { EngineSession } from './client.js';
import { redactSecrets } from './errors.js';

/** Time the engine gets beyond `MCP_STATEMENT_TIMEOUT_MS` (connect, audit write, rollback) before the call gives up. */
export const ENGINE_WRITE_TIMEOUT_MARGIN_MS = 10_000;

export interface PreviewRequest {
    statement: string;
    description: string;
    ticket: string | null;
}

/** The engine's Preview reply, as returned to the MCP client. */
export interface PreviewResult {
    [key: string]: unknown;
    audit_id: string;
    rows_affected: number;
    preview: true;
    /** The statement's RETURNING rows, or null when it has no RETURNING clause. */
    returning: Record<string, unknown>[] | null;
}

export interface EngineWriter {
    preview(request: PreviewRequest): Promise<PreviewResult>;
}

/** A failed Preview. The message is safe to show to the MCP client. */
export class EngineWriteError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'EngineWriteError';
    }
}

/** `sub` and `project` of a §3 identity token this server minted (its payload is our own JSON). */
function identityClaims(token: string): { sub: string; project: string } {
    const payload = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as {
        sub?: unknown;
        project?: unknown;
    };
    if (typeof payload.sub !== 'string' || typeof payload.project !== 'string') {
        throw new Error('identity token has no sub or project');
    }
    return { sub: payload.sub, project: payload.project };
}

function isPreviewResult(body: unknown): body is PreviewResult {
    const b = body as Partial<PreviewResult> | null | undefined;
    return (
        typeof b?.audit_id === 'string' &&
        b.audit_id !== '' &&
        typeof b.rows_affected === 'number' &&
        Number.isSafeInteger(b.rows_affected) &&
        b.rows_affected >= 0 &&
        (b.returning === null ||
            (Array.isArray(b.returning) && b.returning.every((r) => typeof r === 'object' && r !== null)))
    );
}

export interface EngineWriterOptions {
    /** `ENGINE_HTTP_URL` (no trailing slash). */
    httpUrl: string;
    session: EngineSession;
    /** `HRX_IDENTITY_SECRET`, which signs the confirmation token. */
    identitySecret: string;
    /** The server clock (epoch ms). */
    now: () => number;
    /** Other values that must never appear in an error message; each call's tokens are always redacted. */
    secrets?: readonly (string | undefined)[];
}

export function createEngineWriter(options: EngineWriterOptions): EngineWriter {
    const { httpUrl, session, identitySecret, now, secrets = [] } = options;
    const what = 'The Preview';
    return {
        async preview({ statement, description, ticket }) {
            let identityToken: string;
            let confirmationToken: string;
            try {
                identityToken = await session.identityToken({ description, ticket });
                const { sub, project } = identityClaims(identityToken);
                confirmationToken = mintConfirmationToken({
                    secret: identitySecret,
                    statement,
                    sub,
                    project,
                    nowSeconds: Math.floor(now() / 1000),
                });
            } catch (err) {
                throw new EngineWriteError(err instanceof Error ? err.message : 'could not identify the caller', {
                    cause: err,
                });
            }
            const redact = (text: string) =>
                redactSecrets(text, [identityToken, confirmationToken, identitySecret, ...secrets]);
            let response: Response;
            try {
                response = await fetch(`${httpUrl}/v1/write`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${identityToken}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify({
                        statement,
                        mode: 'preview',
                        confirmation_token: confirmationToken,
                        description,
                        ticket,
                    }),
                    signal: AbortSignal.timeout(session.statementTimeoutMs + ENGINE_WRITE_TIMEOUT_MARGIN_MS),
                });
            } catch (err) {
                throw new EngineWriteError(`${what} failed: could not reach the Federation Engine`, { cause: err });
            }
            const body: unknown = await response.json().catch(() => undefined);
            if (!response.ok) {
                const message = engineErrorMessage(body);
                throw new EngineWriteError(
                    redact(`${what} failed with HTTP ${response.status}${message ? `: ${message}` : ''}`),
                );
            }
            if ((body as { preview?: unknown } | null | undefined)?.preview !== true) {
                throw new EngineWriteError(
                    `${what} failed: the Federation Engine did not confirm the statement ran as a Preview ` +
                        '(preview was not true). Nothing is returned; tell the platform team.',
                );
            }
            if (!isPreviewResult(body)) {
                throw new EngineWriteError(`${what} failed: the Federation Engine sent an unexpected response`);
            }
            return {
                audit_id: body.audit_id,
                rows_affected: body.rows_affected,
                preview: true,
                returning: body.returning,
            };
        },
    };
}
