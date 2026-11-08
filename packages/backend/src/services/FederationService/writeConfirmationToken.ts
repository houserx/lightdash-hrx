/**
 * CONTRACTS §4.2 Write Mode confirmation tokens: one human confirmation for one statement.
 *
 *   <base64url(payload_json)>.<base64url(HMAC-SHA256(secret, base64url(payload_json)))>
 *
 * Same envelope and secret as the §3 identity tokens. The payload binds the token to the
 * statement (by its sha256), the user, the project and a short expiry; the nonce lets the
 * engine refuse a token it has already seen (single use, 409 on reuse).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const WRITE_CONFIRMATION_TOKEN_VERSION = 1;
/** CONTRACTS §4.2: exp ≤ 120 s after the token is minted. */
export const MAX_WRITE_CONFIRMATION_TTL_SECONDS = 120;
const NONCE_BYTES = 16;

export type WriteConfirmationTokenPayload = {
    v: typeof WRITE_CONFIRMATION_TOKEN_VERSION;
    /** Lowercase hex sha256 of the statement's UTF-8 bytes, exactly as submitted. */
    statement_sha256: string;
    /** User uuid. */
    sub: string;
    /** Project uuid. */
    project: string;
    exp: number;
    /** 16 random bytes, unpadded base64url. */
    nonce: string;
};

export type MintWriteConfirmationTokenArgs = {
    statement: string;
    userUuid: string;
    projectUuid: string;
    secret: string;
    /** Clock; defaults to the current time. */
    now?: Date;
    /** 16 bytes; defaults to fresh random bytes. */
    nonce?: Buffer;
    /** Requested lifetime; capped at MAX_WRITE_CONFIRMATION_TTL_SECONDS. */
    ttlSeconds?: number;
};

export const statementSha256 = (statement: string): string =>
    createHash('sha256').update(statement).digest('hex');

export const mintWriteConfirmationToken = ({
    statement,
    userUuid,
    projectUuid,
    secret,
    now = new Date(),
    nonce = randomBytes(NONCE_BYTES),
    ttlSeconds = MAX_WRITE_CONFIRMATION_TTL_SECONDS,
}: MintWriteConfirmationTokenArgs): {
    token: string;
    payload: WriteConfirmationTokenPayload;
} => {
    if (!secret) {
        throw new Error('An identity signing secret is required');
    }
    if (nonce.length !== NONCE_BYTES) {
        throw new Error(
            `Write confirmation nonce must be ${NONCE_BYTES} bytes`,
        );
    }
    const lifetime = Math.max(
        0,
        Math.min(Math.floor(ttlSeconds), MAX_WRITE_CONFIRMATION_TTL_SECONDS),
    );
    const payload: WriteConfirmationTokenPayload = {
        v: WRITE_CONFIRMATION_TOKEN_VERSION,
        statement_sha256: statementSha256(statement),
        sub: userUuid,
        project: projectUuid,
        exp: Math.floor(now.getTime() / 1000) + lifetime,
        nonce: nonce.toString('base64url'),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        'base64url',
    );
    const signature = createHmac('sha256', secret)
        .update(encodedPayload)
        .digest('base64url');
    return { token: `${encodedPayload}.${signature}`, payload };
};
