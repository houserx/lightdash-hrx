import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SECRET, identityOf, ORG_UUID, SERVICE_TOKEN, startHarness, type Harness } from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';
import type { FakeUser } from './helpers/lightdash';

const DECOY: FakeUser = {
    userUuid: '11111111-2222-4333-8444-555555555555',
    email: 'x.analyst@example.test',
    organizationUuid: ORG_UUID,
};
const TARGET: FakeUser = {
    userUuid: '66666666-7777-4888-9999-aaaaaaaaaaaa',
    email: 'analyst@example.test',
    organizationUuid: ORG_UUID,
};

let h: Harness;
beforeAll(async () => {
    // The decoy's email contains the target's email, and is listed first.
    h = await startHarness({
        users: [DECOY, TARGET],
        attributes: [{ name: 'platform_read', users: [{ userUuid: TARGET.userUuid, value: 'true' }] }],
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const lastIdentity = () => {
    const q = h.engine.dataQueries().filter((x) => /information_schema\.tables/i.test(x.sql)).at(-1)!;
    return verifyIdentityToken(identityOf(q), IDENTITY_SECRET);
};

describe('Okta user -> Lightdash user, through the Lightdash API with a service account', () => {
    it('maps the email claim to the Lightdash user with exactly that email', async () => {
        const r = await h.call('list_sources', {}, h.okta.sign({ sub: '00u-okta-id-1', email: 'analyst@example.test' }));
        expect(r.isError, r.text).toBe(false);
        expect(lastIdentity()).toMatchObject({ sub: TARGET.userUuid, email: TARGET.email, org: ORG_UUID });
        expect(lastIdentity().attrs.platform_read).toBe(true);
    });

    it('falls back to an email-shaped sub when there is no email claim, case-insensitively', async () => {
        const r = await h.call('list_sources', {}, h.okta.sign({ sub: 'Analyst@Example.TEST', email: undefined }));
        expect(r.isError, r.text).toBe(false);
        expect(lastIdentity().sub).toBe(TARGET.userUuid);
    });

    it('authenticates to Lightdash with the service-account token', () => {
        const userCalls = h.lightdash.requests.filter((r) => r.path === '/api/v1/org/users');
        expect(userCalls.length).toBeGreaterThan(0);
        for (const c of userCalls) expect(c.headers.authorization).toBe(`ApiKey ${SERVICE_TOKEN}`);
    });
});
