import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenError, createOktaVerifier, type AccessTokenVerifier } from './okta.js';

const AUDIENCE = 'api://telemetry-mcp-unit';
const KID = 'unit-key-1';
const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = (): number => Math.floor(Date.now() / 1000);

const signing = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

let server: http.Server;
let issuer: string;
let jwksFetches = 0;
let verifier: AccessTokenVerifier;

function sign(payload: Record<string, unknown>, key = signing.privateKey, kid = KID): string {
    const data = `${enc({ alg: 'RS256', typ: 'JWT', kid })}.${enc(payload)}`;
    return `${data}.${crypto.sign('sha256', Buffer.from(data), key).toString('base64url')}`;
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { iss: issuer, aud: AUDIENCE, iat: now(), exp: now() + 600, sub: 'unit-user', ...extra };
}

async function rejection(token: string): Promise<string> {
    const err = await verifier.verify(token).then(
        () => undefined,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AccessTokenError);
    return (err as AccessTokenError).description;
}

beforeAll(async () => {
    const jwk = { ...signing.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
    server = http.createServer((_req, res) => {
        jwksFetches += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2/default`;
    verifier = createOktaVerifier({ issuer, audience: AUDIENCE, jwksUri: `${issuer}/v1/keys` });
});

afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
});

describe('createOktaVerifier', () => {
    it('does not fetch the JWKS until a token is verified', () => {
        createOktaVerifier({ issuer, audience: AUDIENCE, jwksUri: `${issuer}/v1/keys` });
        expect(jwksFetches).toBe(0);
    });

    it('accepts a valid RS256 token and returns its claims', async () => {
        const token = sign(claims());
        const verified = await verifier.verify(token);
        expect(verified.token).toBe(token);
        expect(verified.claims.sub).toBe('unit-user');
    });

    it('accepts an aud array that contains the audience', async () => {
        await expect(verifier.verify(sign(claims({ aud: ['other', AUDIENCE] })))).resolves.toBeDefined();
    });

    it('caches the JWKS across verifications', async () => {
        const before = jwksFetches;
        await verifier.verify(sign(claims()));
        await verifier.verify(sign(claims()));
        expect(jwksFetches).toBe(before);
    });

    it('rejects bad claims with a fixed description', async () => {
        expect(await rejection(sign(claims({ iss: 'https://evil.example.test' })))).toMatch(/not issued/);
        expect(await rejection(sign(claims({ aud: 'api://other' })))).toMatch(/not intended/);
        expect(await rejection(sign(claims({ iat: now() - 7200, exp: now() - 600 })))).toMatch(/expired/);
        expect(await rejection(sign(claims({ nbf: now() + 600 })))).toMatch(/not valid yet/);
        const { exp: _exp, ...noExp } = claims();
        expect(await rejection(sign(noExp))).toMatch(/no expiry/);
    });

    it('rejects a key that is not in the JWKS, alg none, HS256 and a tampered payload', async () => {
        await rejection(sign(claims(), foreign.privateKey));
        await rejection(sign(claims(), signing.privateKey, 'unknown-kid'));
        await rejection(`${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims())}.`);
        const head = enc({ alg: 'HS256', typ: 'JWT', kid: KID });
        const body = enc(claims());
        const mac = crypto.createHmac('sha256', 'guess').update(`${head}.${body}`).digest('base64url');
        expect(await rejection(`${head}.${body}.${mac}`)).toMatch(/accepted algorithm/);
        const [h, , s] = sign(claims()).split('.');
        await rejection(`${h}.${enc(claims({ sub: 'someone-else' }))}.${s}`);
    });

    it('never puts token content in the description', async () => {
        const description = await rejection(sign(claims({ iss: 'https://marker-value.example.test' })));
        expect(description).not.toContain('marker-value');
    });

    it('fails closed when the JWKS cannot be fetched', async () => {
        const unreachable = createOktaVerifier({ issuer, audience: AUDIENCE, jwksUri: 'http://127.0.0.1:1/v1/keys' });
        await expect(unreachable.verify(sign(claims()))).rejects.toBeInstanceOf(AccessTokenError);
    });
});
