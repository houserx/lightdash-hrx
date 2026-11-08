/**
 * Fake Okta authorization server for acceptance tests: serves a JWKS from keys generated in the test
 * and signs RS256 access tokens. Node built-ins only. PROTECTED: do not edit.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOkta {
    /** e.g. http://127.0.0.1:PORT/oauth2/default */
    issuer: string;
    /** `${issuer}/v1/keys` */
    jwksUri: string;
    jwksFetches(): number;
    /** Sign an access token (kid may name a key already rotated out of the JWKS). Defaults: iss=issuer, aud=audience, iat=now, exp=now+3600 (seconds). */
    sign(claims: Record<string, unknown>, opts?: { kid?: string; omitDefaults?: boolean; nowSeconds?: number }): string;
    /** Sign with a key that is NOT in the JWKS but claims `kid` (default: the current kid). */
    signWithForeignKey(claims: Record<string, unknown>, kid?: string): string;
    /** Adds a new key, makes it current, and (unless keepOld) removes old keys from the JWKS. Returns the new kid. */
    rotate(opts?: { keepOld?: boolean }): string;
    currentKid(): string;
    close(): Promise<void>;
}

export const TEST_AUDIENCE = 'api://telemetry-mcp-test';

function b64url(input: Buffer | string): string {
    return Buffer.from(input).toString('base64url');
}

interface Key {
    kid: string;
    privateKey: crypto.KeyObject;
    jwk: Record<string, unknown>;
}

function newKey(kid: string): Key {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    return { kid, privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: crypto.KeyObject): string {
    const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.sign('sha256', Buffer.from(data), key);
    return `${data}.${b64url(sig)}`;
}

export async function startFakeOkta(opts: { audience?: string } = {}): Promise<FakeOkta> {
    const audience = opts.audience ?? TEST_AUDIENCE;
    let keys: Key[] = [newKey('test-key-1')];
    const allKeys: Key[] = [...keys];
    let current = keys[0]!;
    let fetches = 0;
    let counter = 1;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/oauth2/default/v1/keys') {
            fetches += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ keys: keys.map((k) => k.jwk) }));
            return;
        }
        if (url.pathname === '/oauth2/default/.well-known/oauth-authorization-server') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/v1/keys` }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const issuer = `http://127.0.0.1:${port}/oauth2/default`;

    return {
        issuer,
        jwksUri: `${issuer}/v1/keys`,
        jwksFetches: () => fetches,
        sign(claims, o = {}) {
            const now = o.nowSeconds ?? Math.floor(Date.now() / 1000);
            const key = o.kid ? allKeys.find((k) => k.kid === o.kid) ?? current : current;
            const payload = o.omitDefaults
                ? claims
                : { iss: issuer, aud: audience, iat: now, exp: now + 3600, ...claims };
            return signJwt({ alg: 'RS256', typ: 'JWT', kid: key.kid }, payload, key.privateKey);
        },
        signWithForeignKey(claims, kid) {
            const now = Math.floor(Date.now() / 1000);
            const foreign = newKey(kid ?? current.kid);
            return signJwt(
                { alg: 'RS256', typ: 'JWT', kid: kid ?? current.kid },
                { iss: issuer, aud: audience, iat: now, exp: now + 3600, ...claims },
                foreign.privateKey,
            );
        },
        rotate(o = {}) {
            counter += 1;
            const k = newKey(`test-key-${counter}`);
            allKeys.push(k);
            keys = o.keepOld ? [...keys, k] : [k];
            current = k;
            return k.kid;
        },
        currentKid: () => current.kid,
        async close() {
            server.closeAllConnections?.();
            await new Promise<void>((r) => server.close(() => r()));
        },
    };
}
