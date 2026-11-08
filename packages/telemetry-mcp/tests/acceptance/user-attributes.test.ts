import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SECRET, identityOf, ORG_UUID, startHarness, type Harness } from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';
import type { FakeUser } from './helpers/lightdash';

const GROUP_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const GROUP_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const OPS: FakeUser = {
    userUuid: '0f0f0f0f-1111-4222-8333-444444444444',
    email: 'ops@example.test',
    organizationUuid: ORG_UUID,
    groups: [
        { uuid: GROUP_A, name: 'platform-readers' },
        { uuid: GROUP_B, name: 'support' },
    ],
};
const PLAIN: FakeUser = {
    userUuid: '0e0e0e0e-1111-4222-8333-555555555555',
    email: 'plain@example.test',
    organizationUuid: ORG_UUID,
    groups: [],
};

let h: Harness;
beforeAll(async () => {
    h = await startHarness({
        users: [OPS, PLAIN],
        attributes: [
            // via group membership
            { name: 'platform_read', groups: [{ groupUuid: GROUP_A, value: 'true' }], attributeDefault: 'false' },
            // direct user value
            { name: 'platform_explain', users: [{ userUuid: OPS.userUuid, value: 'true' }] },
            // only the exact string "true" is true
            { name: 'platform_write', users: [{ userUuid: OPS.userUuid, value: 'yes' }] },
            // org default
            { name: 'telemetry_restricted', attributeDefault: 'true' },
        ],
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

async function attrsFor(email: string) {
    const r = await h.call('list_sources', {}, h.okta.sign({ sub: `00u-${email}`, email }));
    expect(r.isError, r.text).toBe(false);
    const q = h.engine.dataQueries().filter((x) => /information_schema\.tables/i.test(x.sql)).at(-1)!;
    return verifyIdentityToken(identityOf(q), IDENTITY_SECRET).attrs;
}

describe('user attributes from Lightdash (users, groups, defaults)', () => {
    it('resolves direct values, group values and defaults; only "true" is true', async () => {
        expect(await attrsFor(OPS.email)).toEqual({
            telemetry_restricted: true,
            platform_read: true,
            platform_write: false,
            platform_explain: true,
        });
    });

    it('gives a user with no values only what the defaults grant', async () => {
        expect(await attrsFor(PLAIN.email)).toEqual({
            telemetry_restricted: true,
            platform_read: false,
            platform_write: false,
            platform_explain: false,
        });
    });

    it('reads attributes from GET /api/v1/org/attributes', () => {
        expect(h.lightdash.requests.some((r) => r.path === '/api/v1/org/attributes')).toBe(true);
    });
});
