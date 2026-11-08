/**
 * CONTRACTS.md §3 identity tokens, as minted by the telemetry MCP server for the engine:
 *
 *   <base64url(payload_json)>.<base64url(HMAC-SHA256(secret, base64url(payload_json)))>
 *
 * Unpadded base64url throughout. Payload keys are serialised in contract order so tokens are
 * byte-for-byte reproducible. The MCP server always mints `iss = "telemetry-mcp"`, `agent = true`,
 * `sys = false`, `audit.source = "mcp"` and a 60 s lifetime.
 */
import crypto from 'node:crypto';

export const IDENTITY_TOKEN_ISSUER = 'telemetry-mcp';
export const IDENTITY_TOKEN_LIFETIME_SECONDS = 60;
export const IDENTITY_TOKEN_NONCE_BYTES = 16;

export interface IdentityAttrs {
    telemetry_restricted: boolean;
    platform_read: boolean;
    platform_write: boolean;
    platform_explain: boolean;
}

export interface IdentityAuditInput {
    description?: string | null;
    ticket?: string | null;
}

export interface MintIdentityTokenInput {
    secret: string;
    /** Lightdash user uuid. */
    sub: string;
    email: string;
    /** Lightdash organization uuid. */
    org: string;
    /** Lightdash project uuid. */
    project: string;
    attrs: IdentityAttrs;
    /** Why the query runs; `null`/omitted means no description or ticket. */
    audit?: IdentityAuditInput | null;
    /** Clock override (unix seconds), for tests. Defaults to now. */
    nowSeconds?: number;
    /** Nonce override (unpadded base64url), for tests. Defaults to 16 random bytes. */
    nonce?: string;
}

const nullable = (value: string | null | undefined): string | null =>
    value === undefined || value === null ? null : value;

export function mintIdentityToken(input: MintIdentityTokenInput): string {
    const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const nonce =
        input.nonce ?? crypto.randomBytes(IDENTITY_TOKEN_NONCE_BYTES).toString('base64url');
    // Built literally (not spread) so key order always matches the contract.
    const payload = {
        v: 1,
        iss: IDENTITY_TOKEN_ISSUER,
        sub: input.sub,
        email: input.email,
        org: input.org,
        project: input.project,
        agent: true,
        sys: false,
        attrs: {
            telemetry_restricted: input.attrs.telemetry_restricted === true,
            platform_read: input.attrs.platform_read === true,
            platform_write: input.attrs.platform_write === true,
            platform_explain: input.attrs.platform_explain === true,
        },
        audit: {
            description: nullable(input.audit?.description),
            ticket: nullable(input.audit?.ticket),
            source: 'mcp',
            resource_uuid: null,
        },
        iat,
        exp: iat + IDENTITY_TOKEN_LIFETIME_SECONDS,
        nonce,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = crypto
        .createHmac('sha256', input.secret)
        .update(payloadB64)
        .digest('base64url');
    return `${payloadB64}.${signature}`;
}
