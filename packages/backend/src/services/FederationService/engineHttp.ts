/**
 * Plain-HTTP calls from FederationService to the Federation Engine (CONTRACTS §4.2), each with
 * a fresh identity token as its bearer. The token is never part of an error message.
 */
import { LightdashError, UnexpectedServerError } from '@lightdash/common';

type EngineRequest = {
    httpBaseUrl: string;
    identityToken: string;
    method: 'GET' | 'POST';
    /** The engine path, e.g. `/v1/write`. */
    path: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    timeoutMs: number;
    /** What the call does, for messages: "write" gives "Federation Engine write failed …". */
    label: string;
};

const REDACTED = '[redacted]';

/**
 * Removes the identity token, and each of its dot-separated parts, from text that came from
 * outside Lightdash (the engine's error body, a fetch failure). An engine that echoes the
 * bearer back in an error must not get it into a Lightdash error response or log line.
 */
export const redactIdentityToken = (
    text: string,
    identityToken: string,
): string => {
    const secrets = [identityToken, ...identityToken.split('.')]
        .filter((part) => part.length >= 8)
        .sort((a, b) => b.length - a.length);
    return secrets.reduce(
        (redacted, secret) => redacted.split(secret).join(REDACTED),
        text,
    );
};

const engineErrorMessage = (
    body: unknown,
    status: number,
    label: string,
): string => {
    if (typeof body === 'object' && body !== null) {
        const { error, message } = body as Record<string, unknown>;
        if (typeof error === 'string' && error) return error;
        if (typeof message === 'string' && message) return message;
    }
    return `Federation Engine ${label} failed with status ${status}`;
};

/**
 * Calls the engine and returns its JSON object body. A 4xx refusal comes back with the
 * engine's status and message; anything else that isn't a JSON object is an unexpected
 * server error.
 */
export const requestEngine = async ({
    httpBaseUrl,
    identityToken,
    method,
    path,
    query,
    body: requestBody,
    timeoutMs,
    label,
}: EngineRequest): Promise<object> => {
    const url = new URL(`${httpBaseUrl.replace(/\/+$/, '')}${path}`);
    Object.entries(query ?? {}).forEach(([key, value]) =>
        url.searchParams.set(key, value),
    );
    let response: Response;
    try {
        response = await fetch(url, {
            method,
            headers: {
                ...(requestBody ? { 'content-type': 'application/json' } : {}),
                authorization: `Bearer ${identityToken}`,
            },
            body: requestBody ? JSON.stringify(requestBody) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        throw new UnexpectedServerError(
            `Could not reach the Federation Engine: ${redactIdentityToken(
                error instanceof Error ? error.message : String(error),
                identityToken,
            )}`,
        );
    }
    const text = await response.text();
    let body: unknown;
    try {
        body = text ? JSON.parse(text) : undefined;
    } catch {
        body = undefined;
    }
    if (!response.ok) {
        const message = redactIdentityToken(
            engineErrorMessage(body, response.status, label),
            identityToken,
        );
        if (response.status >= 400 && response.status < 500) {
            throw new LightdashError({
                message,
                name: 'FederationEngineError',
                statusCode: response.status,
                data: {},
            });
        }
        throw new UnexpectedServerError(message);
    }
    if (typeof body !== 'object' || body === null) {
        throw new UnexpectedServerError(
            `The Federation Engine returned an invalid ${label} result`,
        );
    }
    return body;
};
