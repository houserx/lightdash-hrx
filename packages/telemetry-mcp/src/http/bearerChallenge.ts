import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from '../config.js';
import { MCP_PATH } from './protectedResource.js';

/**
 * Outcome of reading the bearer token off a request to `/mcp` (RFC 6750 §2.1, §3).
 * - `missing`: no Authorization header, or a scheme other than Bearer. The challenge carries no error code.
 * - `malformed`: a Bearer header whose token is empty or not a compact JWS. Challenged with `invalid_token`.
 * - `token`: a JWT-shaped bearer token, still to be verified against Okta.
 */
export type BearerExtraction =
    | { kind: 'missing' }
    | { kind: 'malformed' }
    | { kind: 'token'; token: string };

const JWS_COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export function extractBearer(headers: IncomingHttpHeaders): BearerExtraction {
    const header = headers.authorization;
    if (header === undefined) return { kind: 'missing' };
    const match = /^(\S+)(?:\s+(.*))?$/.exec(header.trim());
    if (!match || match[1].toLowerCase() !== 'bearer') return { kind: 'missing' };
    const token = (match[2] ?? '').trim();
    if (!JWS_COMPACT.test(token)) return { kind: 'malformed' };
    return { kind: 'token', token };
}

/** The metadata URL MCP clients follow from a 401 (RFC 9728 §5.1): the path-suffixed form for `/mcp`. */
export function resourceMetadataUrl(config: Config): string {
    return `${config.publicUrl}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

export interface BearerError {
    error: 'invalid_token';
    description: string;
}

/**
 * `WWW-Authenticate` value for a 401 on `/mcp`. Never includes anything taken from the request,
 * so a presented token can't be echoed back.
 */
export function bearerChallenge(config: Config, err?: BearerError): string {
    const params: string[] = [];
    if (err) {
        params.push(`error="${err.error}"`, `error_description="${err.description}"`);
    }
    params.push(`resource_metadata="${resourceMetadataUrl(config)}"`);
    return `Bearer ${params.join(', ')}`;
}
