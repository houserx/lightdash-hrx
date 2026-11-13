/**
 * Independent verifier for CONTRACTS.md §3 identity tokens:
 *   <base64url(payload_json)>.<base64url(HMAC-SHA256(secret, base64url(payload_json)))>
 * PROTECTED: do not edit.
 */
import crypto from 'node:crypto';

export interface IdentityPayload {
    v: number;
    iss: string;
    sub: string;
    email: string;
    org: string;
    project: string;
    agent: boolean;
    sys: boolean;
    attrs: {
        telemetry_restricted: boolean;
        platform_read: boolean;
        platform_write: boolean;
        platform_explain: boolean;
    };
    audit: {
        description: string | null;
        ticket: string | null;
        source: string;
        resource_uuid: string | null;
    };
    iat: number;
    exp: number;
    nonce: string;
}

/** Verifies the signature and returns the payload; throws if the token is malformed or forged. */
export function verifyIdentityToken(token: string, secret: string): IdentityPayload {
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('identity token must have exactly two parts');
    const [payloadB64, sigB64] = parts as [string, string];
    if (/[=+/]/.test(token)) throw new Error('identity token must be unpadded base64url');
    const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    if (expected !== sigB64) throw new Error('identity token signature mismatch');
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as IdentityPayload;
}
