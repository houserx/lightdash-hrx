import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SECRET, identityOf, startHarness, type Harness } from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';

let clock = Date.now();
let h: Harness;
beforeAll(async () => {
    h = await startHarness({ env: { MCP_USER_CACHE_TTL_MS: '5000' }, now: () => clock });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('user mapping is cached briefly', () => {
    it('looks the user up once for several calls within the TTL', async () => {
        const token = h.token();
        await h.call('list_sources', {}, token);
        await h.call('list_sources', {}, token);
        await h.call('list_sources', {}, token);
        expect(h.lightdash.userLookups()).toBe(1);
    });

    it('looks the user up again after the TTL, and picks up changed attributes', async () => {
        h.lightdash.setAttributes([{ name: 'platform_read', attributeDefault: 'false' }]);
        clock += 6000;
        const r = await h.call('list_sources', {}, h.token());
        expect(r.isError, r.text).toBe(false);
        expect(h.lightdash.userLookups()).toBe(2);
        const q = h.engine.dataQueries().filter((x) => /information_schema\.tables/i.test(x.sql)).at(-1)!;
        expect(verifyIdentityToken(identityOf(q), IDENTITY_SECRET).attrs.platform_read).toBe(false);
    });
});
