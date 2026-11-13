import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness';
import { postInitialize } from './helpers/http';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('JWKS caching and key rotation', () => {
    it('fetches the JWKS once and reuses it across requests', async () => {
        for (let i = 0; i < 4; i += 1) {
            const res = await postInitialize(h.mcpUrl, h.token({ jti: `t-${i}` }));
            expect(res.status).toBe(200);
        }
        expect(h.okta.jwksFetches()).toBe(1);
    });

    it('picks up a rotated signing key by refetching the JWKS on an unknown kid', async () => {
        const before = h.okta.jwksFetches();
        h.okta.rotate();
        // An unknown kid may refetch at most once per second (cooldown <= 1 s), so step past it.
        await new Promise((r) => setTimeout(r, 1100));
        const res = await postInitialize(h.mcpUrl, h.token({ jti: 'after-rotation' }));
        expect(res.status).toBe(200);
        expect(h.okta.jwksFetches()).toBe(before + 1);
        // And the new key is then served from cache.
        const again = await postInitialize(h.mcpUrl, h.token({ jti: 'after-rotation-2' }));
        expect(again.status).toBe(200);
        expect(h.okta.jwksFetches()).toBe(before + 1);
    });

    it('rejects a kid that the refreshed JWKS does not contain, without hammering Okta', async () => {
        const before = h.okta.jwksFetches();
        for (let i = 0; i < 5; i += 1) {
            const res = await postInitialize(h.mcpUrl, h.okta.signWithForeignKey({ email: 'x@example.test' }, `bogus-kid-${i}`));
            expect(res.status).toBe(401);
        }
        expect(h.okta.jwksFetches() - before).toBeLessThanOrEqual(2);
    });
});
