/**
 * A fake Okta authorization server for the telemetry MCP server: serves the JWKS of an RS256 key
 * of its own (two fakes never share a key) and mints access tokens with it.
 */
import * as crypto from 'node:crypto';
import { jsonReply, startFakeServer, type FakeServer } from './fakeServer';

/** The audience every fake mints for unless told otherwise (`OKTA_AUDIENCE` of the MCP). */
export const OKTA_AUDIENCE = 'api://telemetry-mcp-e2e';

export type MintAccessTokenOptions = {
    sub: string;
    /** Left out of the token when undefined. */
    email?: string;
    /** Default: the fake's `audience`. */
    aud?: string;
    /** `exp` - now. Default 3600; negative for an expired token. */
    expiresInSeconds?: number;
};

export type FakeOkta = FakeServer & {
    /** `<url>/oauth2/default`, the `iss` of every minted token. */
    issuer: string;
    /** `<issuer>/v1/keys` */
    jwksUri: string;
    audience: string;
    mintAccessToken(opts: MintAccessTokenOptions): Promise<string>;
};

const b64url = (value: Buffer | string) =>
    Buffer.from(value).toString('base64url');

export async function startFakeOkta(): Promise<FakeOkta> {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });
    const kid = `e2e-${crypto.randomBytes(6).toString('hex')}`;
    const jwk = {
        ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
        kid,
        alg: 'RS256',
        use: 'sig',
    };
    let issuer = '';
    const server = await startFakeServer((request) => {
        if (request.method !== 'GET')
            return jsonReply({ error: 'method_not_allowed' }, 405);
        if (request.path === '/oauth2/default/v1/keys')
            return jsonReply({ keys: [jwk] });
        if (
            request.path ===
            '/oauth2/default/.well-known/oauth-authorization-server'
        ) {
            return jsonReply({ issuer, jwks_uri: `${issuer}/v1/keys` });
        }
        return jsonReply({ error: 'not_found' }, 404);
    });
    issuer = `${server.url}/oauth2/default`;

    return {
        ...server,
        issuer,
        jwksUri: `${issuer}/v1/keys`,
        audience: OKTA_AUDIENCE,
        async mintAccessToken({ sub, email, aud, expiresInSeconds = 3600 }) {
            const now = Math.floor(Date.now() / 1000);
            const payload: Record<string, unknown> = {
                iss: issuer,
                aud: aud ?? OKTA_AUDIENCE,
                sub,
                iat: now,
                exp: now + expiresInSeconds,
            };
            if (email !== undefined) payload.email = email;
            const data = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))}.${b64url(JSON.stringify(payload))}`;
            const signature = crypto.sign(
                'sha256',
                Buffer.from(data),
                privateKey,
            );
            return `${data}.${b64url(signature)}`;
        },
    };
}
