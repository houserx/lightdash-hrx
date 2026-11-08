/**
 * CONTRACTS §4.2 Write Mode plumbing for FederationService: request validation and the call
 * to the Federation Engine's POST /v1/write.
 */
import {
    LightdashError,
    NotSupportedError,
    ParameterError,
    UnexpectedServerError,
    type WriteResult,
} from '@lightdash/common';

const ENGINE_WRITE_TIMEOUT_MS = 60_000;

export type ParsedWriteRequest = {
    statement: string;
    mode: 'preview';
    confirmationToken: string;
    description: string;
    ticket: string | null;
};

const isNonBlankString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim() !== '';

/**
 * Validates a Write Mode request body. The description is checked first: Write Mode never
 * reaches the engine without one. The statement and confirmation token are sent exactly as
 * given (the token is bound to the statement's bytes); description and ticket are trimmed,
 * and a blank ticket is null.
 */
export const parseWriteRequest = (body: unknown): ParsedWriteRequest => {
    const { statement, mode, confirmationToken, description, ticket } = (
        typeof body === 'object' && body !== null ? body : {}
    ) as Record<string, unknown>;
    if (!isNonBlankString(description)) {
        throw new ParameterError('A description is required for Write Mode');
    }
    if (!isNonBlankString(statement)) {
        throw new ParameterError('A statement is required');
    }
    if (mode === 'commit') {
        throw new NotSupportedError('Write Mode commit is not available yet');
    }
    if (mode !== 'preview') {
        throw new ParameterError('mode must be "preview" or "commit"');
    }
    if (!isNonBlankString(confirmationToken)) {
        throw new ParameterError('A confirmation token is required');
    }
    if (ticket !== undefined && ticket !== null && typeof ticket !== 'string') {
        throw new ParameterError('ticket must be a string');
    }
    return {
        statement,
        mode,
        confirmationToken,
        description: description.trim(),
        ticket: ticket?.trim() || null,
    };
};

const engineErrorMessage = (body: unknown, status: number): string => {
    if (typeof body === 'object' && body !== null) {
        const { error, message } = body as Record<string, unknown>;
        if (typeof error === 'string' && error) return error;
        if (typeof message === 'string' && message) return message;
    }
    return `Federation Engine write failed with status ${status}`;
};

/**
 * POSTs to the engine's /v1/write. A 4xx refusal (guard, confirmation token, identity) comes
 * back with the engine's status and message; anything else is an unexpected server error.
 */
export const postEngineWrite = async (
    httpBaseUrl: string,
    identityToken: string,
    payload: Record<string, unknown>,
): Promise<WriteResult> => {
    const url = `${httpBaseUrl.replace(/\/+$/, '')}/v1/write`;
    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${identityToken}`,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(ENGINE_WRITE_TIMEOUT_MS),
        });
    } catch (error) {
        throw new UnexpectedServerError(
            `Could not reach the Federation Engine: ${
                error instanceof Error ? error.message : String(error)
            }`,
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
        const message = engineErrorMessage(body, response.status);
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
            'The Federation Engine returned an invalid write result',
        );
    }
    return body as WriteResult;
};
