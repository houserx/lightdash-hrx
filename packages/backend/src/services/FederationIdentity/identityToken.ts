/**
 * CONTRACTS §3 identity tokens: how Lightdash tells the Federation Engine who is asking.
 *
 *   <base64url(payload_json)>.<base64url(HMAC-SHA256(secret, base64url(payload_json)))>
 *
 * base64url is unpadded. The payload keys are always written in the contract's order, so the
 * same claims, clock and nonce give the same token byte for byte.
 */
import { createHmac, randomBytes } from 'node:crypto';

export const IDENTITY_TOKEN_VERSION = 1;
export const MAX_IDENTITY_TOKEN_TTL_SECONDS = 300;
const NONCE_BYTES = 16;

export type IdentityTokenIssuer = 'lightdash' | 'telemetry-mcp';

export type IdentityAuditSource =
    | 'investigate'
    | 'tile'
    | 'alert_rule'
    | 'mcp'
    | 'write_mode';

export type IdentityAttrs = {
    telemetry_restricted: boolean;
    platform_read: boolean;
    platform_write: boolean;
    platform_explain: boolean;
};

export type IdentityAudit = {
    description: string | null;
    ticket: string | null;
    source: IdentityAuditSource;
    resource_uuid: string | null;
};

export type IdentityTokenPayload = {
    v: typeof IDENTITY_TOKEN_VERSION;
    iss: IdentityTokenIssuer;
    sub: string;
    email: string;
    org: string;
    project: string;
    agent: boolean;
    sys: boolean;
    attrs: IdentityAttrs;
    audit: IdentityAudit;
    iat: number;
    exp: number;
    nonce: string;
};

/** What a caller supplies; omitted flags, attrs and audit fields default to false/null. */
export type IdentityTokenClaims = {
    iss: IdentityTokenIssuer;
    sub: string;
    email: string;
    org: string;
    project: string;
    agent?: boolean;
    sys?: boolean;
    attrs?: Partial<IdentityAttrs>;
    audit: Partial<IdentityAudit> & Pick<IdentityAudit, 'source'>;
};

export type MintIdentityTokenOptions = {
    secret: string;
    /** Clock; defaults to the current time. */
    now?: Date;
    /** 16 bytes; defaults to fresh random bytes. */
    nonce?: Buffer;
    /** Requested lifetime; capped at MAX_IDENTITY_TOKEN_TTL_SECONDS. */
    ttlSeconds?: number;
};

const signEncodedPayload = (encodedPayload: string, secret: string): string =>
    createHmac('sha256', secret).update(encodedPayload).digest('base64url');

/** Builds the payload with every key in CONTRACTS §3 order. */
const buildPayload = (
    claims: IdentityTokenClaims,
    iat: number,
    exp: number,
    nonce: string,
): IdentityTokenPayload => ({
    v: IDENTITY_TOKEN_VERSION,
    iss: claims.iss,
    sub: claims.sub,
    email: claims.email,
    org: claims.org,
    project: claims.project,
    agent: claims.agent === true,
    sys: claims.sys === true,
    attrs: {
        telemetry_restricted: claims.attrs?.telemetry_restricted === true,
        platform_read: claims.attrs?.platform_read === true,
        platform_write: claims.attrs?.platform_write === true,
        platform_explain: claims.attrs?.platform_explain === true,
    },
    audit: {
        description: claims.audit.description ?? null,
        ticket: claims.audit.ticket ?? null,
        source: claims.audit.source,
        resource_uuid: claims.audit.resource_uuid ?? null,
    },
    iat,
    exp,
    nonce,
});

export const mintIdentityToken = (
    claims: IdentityTokenClaims,
    {
        secret,
        now = new Date(),
        nonce = randomBytes(NONCE_BYTES),
        ttlSeconds = MAX_IDENTITY_TOKEN_TTL_SECONDS,
    }: MintIdentityTokenOptions,
): string => {
    if (!secret) {
        throw new Error('An identity signing secret is required');
    }
    if (nonce.length !== NONCE_BYTES) {
        throw new Error(`Identity token nonce must be ${NONCE_BYTES} bytes`);
    }
    const iat = Math.floor(now.getTime() / 1000);
    const lifetime = Math.max(
        0,
        Math.min(Math.floor(ttlSeconds), MAX_IDENTITY_TOKEN_TTL_SECONDS),
    );
    const payload = buildPayload(
        claims,
        iat,
        iat + lifetime,
        nonce.toString('base64url'),
    );
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        'base64url',
    );
    return `${encodedPayload}.${signEncodedPayload(encodedPayload, secret)}`;
};
