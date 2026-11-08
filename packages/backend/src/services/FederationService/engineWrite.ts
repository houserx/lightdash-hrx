/**
 * CONTRACTS §4.2 Write Mode plumbing for FederationService: request validation and the call
 * to the Federation Engine's POST /v1/write.
 */
import {
    ParameterError,
    type WriteMode,
    type WriteResult,
} from '@lightdash/common';
import { requestEngine } from './engineHttp';

const ENGINE_WRITE_TIMEOUT_MS = 60_000;

export type ParsedWriteRequest = {
    statement: string;
    mode: WriteMode;
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
    if (mode !== 'preview' && mode !== 'commit') {
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

/**
 * POSTs to the engine's /v1/write. A 4xx refusal (guard, confirmation token, identity) comes
 * back with the engine's status and message; anything else is an unexpected server error.
 */
export const postEngineWrite = async (
    httpBaseUrl: string,
    identityToken: string,
    payload: Record<string, unknown>,
): Promise<WriteResult> =>
    (await requestEngine({
        httpBaseUrl,
        identityToken,
        method: 'POST',
        path: '/v1/write',
        body: payload,
        timeoutMs: ENGINE_WRITE_TIMEOUT_MS,
        label: 'write',
    })) as WriteResult;
