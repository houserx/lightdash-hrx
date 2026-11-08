/**
 * Engine SQLSTATEs as tool error text (CONTRACTS §1.1, §1.2, §6).
 *
 * - `42501`: access denied. The engine's message names the missing claim (or says an Audited Query needs a
 *   description), so it is kept.
 * - `54000`: the result hit the source's `max_rows`. The caller gets advice to narrow the query.
 * - `58000`: the audit write failed, so the engine withheld the result. No rows are ever returned for it.
 * - Anything else stays an error result with the engine's message and SQLSTATE.
 *
 * Every engine message has already passed `redactSecrets` in the client, so no token or secret reaches this text.
 */
import type { EngineError } from './client.js';

export const SQLSTATE_ACCESS_DENIED = '42501';
export const SQLSTATE_RESULT_TOO_LARGE = '54000';
export const SQLSTATE_AUDIT_WRITE_FAILED = '58000';

/** Engine messages longer than this are cut, so a runaway message cannot flood the client. */
export const MAX_ENGINE_MESSAGE_LENGTH = 500;

const REDACTED = '[redacted]';

/** The other §1.2 `42501`: an Audited Query without `audit.description`. No claim is missing then. */
const AUDIT_DESCRIPTION_MISSING = /audited query requires a description/i;

/**
 * A §3 identity token or any JWT: base64url JSON (`eyJ…`) followed by one or two base64url segments. Removed from
 * every engine message whatever the engine echoes.
 */
const TOKEN_SHAPE = /eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){1,2}/g;

/** The text with every given secret and every token-shaped string replaced by `[redacted]`, then length-capped. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
    let out = text;
    // Longest first, so a secret that contains another is removed whole.
    const known = secrets
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .sort((a, b) => b.length - a.length);
    for (const secret of known) out = out.split(secret).join(REDACTED);
    out = out.replace(TOKEN_SHAPE, REDACTED);
    if (out.length > MAX_ENGINE_MESSAGE_LENGTH) out = `${out.slice(0, MAX_ENGINE_MESSAGE_LENGTH)}…`;
    return out;
}

/** The tool error text for a failed engine statement. `what` names the statement, for example "The PromQL query". */
export function engineErrorText(err: EngineError, what: string): string {
    const message = err.message.replace(/[\s.]+$/, '');
    switch (err.code) {
        case SQLSTATE_ACCESS_DENIED:
            return (
                `Access denied: the Federation Engine refused ${lowerFirst(what)}: ${message}. ` +
                (AUDIT_DESCRIPTION_MISSING.test(message)
                    ? 'This data is audited and the query must carry a description of why it is run.'
                    : 'Your Lightdash user attributes do not grant the claim it names; ask a Lightdash admin for ' +
                      'it if you need this data.') +
                ` (SQLSTATE ${err.code})`
            );
        case SQLSTATE_RESULT_TOO_LARGE:
            return (
                `Result too large: ${lowerFirst(what)} returned more rows than the source allows (${message}). ` +
                'Narrow the query and try again: use a shorter time range, a coarser step, more specific filters or ' +
                `labels, or aggregate the result. (SQLSTATE ${err.code})`
            );
        case SQLSTATE_AUDIT_WRITE_FAILED:
            return (
                `Audit write failed: the Federation Engine could not record the audit entry for ${lowerFirst(what)}, ` +
                'so it withheld the result and no rows were returned. Try again later; if it keeps failing, tell the ' +
                `platform team. (SQLSTATE ${err.code})`
            );
        case undefined:
            return `${what} failed: ${message}`;
        default:
            return `${what} failed: ${message} (SQLSTATE ${err.code})`;
    }
}

function lowerFirst(text: string): string {
    return text.length > 0 ? text[0].toLowerCase() + text.slice(1) : text;
}
