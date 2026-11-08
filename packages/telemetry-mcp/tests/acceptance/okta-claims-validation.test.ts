import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANALYST, startHarness, type Harness } from './helpers/harness';
import { postInitialize } from './helpers/http';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const now = (): number => Math.floor(Date.now() / 1000);

async function expectRejected(token: string): Promise<void> {
    const res = await postInitialize(h.mcpUrl, token);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate') ?? '').toContain('error="invalid_token"');
}

describe('bearer access-token validation against Okta JWKS', () => {
    it('accepts a valid token', async () => {
        const res = await postInitialize(h.mcpUrl, h.token());
        expect(res.status).toBe(200);
    });

    it('accepts a token whose aud is an array containing the audience', async () => {
        const res = await postInitialize(h.mcpUrl, h.token({ aud: ['other-api', h.env.OKTA_AUDIENCE] }));
        expect(res.status).toBe(200);
    });

    it('rejects the wrong issuer', async () => {
        await expectRejected(h.token({ iss: 'https://evil.example.test/oauth2/default' }));
    });

    it('rejects the wrong audience', async () => {
        await expectRejected(h.token({ aud: 'api://some-other-resource' }));
    });

    it('rejects an expired token', async () => {
        await expectRejected(h.token({ iat: now() - 7200, exp: now() - 600 }));
    });

    it('rejects a token that is not yet valid (nbf)', async () => {
        await expectRejected(h.token({ nbf: now() + 600 }));
    });

    it('rejects a token without exp', async () => {
        const t = h.okta.sign(
            { iss: h.okta.issuer, aud: h.env.OKTA_AUDIENCE, iat: now(), sub: 'x', email: ANALYST.email },
            { omitDefaults: true },
        );
        await expectRejected(t);
    });

    it('rejects a token signed by a key that is not in the JWKS', async () => {
        await expectRejected(h.okta.signWithForeignKey({ sub: 'x', email: ANALYST.email }));
    });

    it('rejects alg=none and HMAC-signed tokens', async () => {
        const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const payload = enc({ iss: h.okta.issuer, aud: h.env.OKTA_AUDIENCE, iat: now(), exp: now() + 600, email: ANALYST.email });
        await expectRejected(`${enc({ alg: 'none', typ: 'JWT' })}.${payload}.`);
        const head = enc({ alg: 'HS256', typ: 'JWT', kid: h.okta.currentKid() });
        const sig = crypto.createHmac('sha256', 'guess').update(`${head}.${payload}`).digest('base64url');
        await expectRejected(`${head}.${payload}.${sig}`);
    });

    it('rejects a tampered payload', async () => {
        const [head, , sig] = h.token().split('.');
        const forged = Buffer.from(
            JSON.stringify({ iss: h.okta.issuer, aud: h.env.OKTA_AUDIENCE, iat: now(), exp: now() + 600, email: 'someone-else@example.test' }),
        ).toString('base64url');
        await expectRejected(`${head}.${forged}.${sig}`);
    });
});
