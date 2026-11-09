/**
 * Write Mode confirmation tokens for MCP Previews (Contract assumption 4).
 *
 * The MCP server mints its own under `HRX_IDENTITY_SECRET`, in the §3 envelope, with exactly the payload the
 * Federation Engine verifies (federation-engine/src/write.rs `verify_confirmation`; CONTRACTS §4.2, amended
 * 2026-11-09) and the Lightdash backend mints:
 *
 *   <base64url(json{v:1, typ:"write_confirmation", statement_sha256, sub, project, iat, exp, nonce})>
 *       .<base64url(HMAC-SHA256(secret, payload_b64))>
 *
 * Unpadded base64url throughout; keys in that order so tokens are reproducible. The token binds the Preview to the
 * exact statement, the caller and the project, and expires 60 s after `iat` (the engine allows at most 120 s).
 */
import crypto from 'node:crypto';

export const CONFIRMATION_TOKEN_LIFETIME_SECONDS = 60;
/** The engine refuses a confirmation token without this `typ`. */
export const CONFIRMATION_TOKEN_TYPE = 'write_confirmation';

export interface MintConfirmationTokenInput {
    secret: string;
    /** The statement the token confirms, byte for byte. */
    statement: string;
    /** Lightdash user uuid. */
    sub: string;
    /** Lightdash project uuid. */
    project: string;
    /** Clock (unix seconds). */
    nowSeconds: number;
    /** Nonce override (unpadded base64url), for tests. Defaults to 16 random bytes. */
    nonce?: string;
}

export function mintConfirmationToken(input: MintConfirmationTokenInput): string {
    const iat = Math.floor(input.nowSeconds);
    const payload = {
        v: 1,
        typ: CONFIRMATION_TOKEN_TYPE,
        statement_sha256: crypto.createHash('sha256').update(input.statement, 'utf8').digest('hex'),
        sub: input.sub,
        project: input.project,
        iat,
        exp: iat + CONFIRMATION_TOKEN_LIFETIME_SECONDS,
        nonce: input.nonce ?? crypto.randomBytes(16).toString('base64url'),
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', input.secret).update(payloadB64).digest('base64url');
    return `${payloadB64}.${signature}`;
}
