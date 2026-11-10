// ldq-identity-token-verify: tokens are checked exactly as the engine checks them: expired,
// issued more than 60s in the future, wrong version or bad signature are all rejected.
import { load } from './load';
import { signPayload, TEST_SECRET } from './tokens';

let identity: any;

beforeAll(async () => {
    identity = await load('../../services/FederationIdentity/identityToken');
}, 120_000);

const iat = 1767225600;
const payload = {
    v: 1,
    iss: 'lightdash',
    sub: 'user-uuid',
    email: 'support.person@example.com',
    org: 'org-uuid',
    project: 'project-uuid',
    agent: false,
    sys: false,
    attrs: {
        telemetry_restricted: false,
        platform_read: true,
        platform_write: false,
        platform_explain: false,
    },
    audit: { description: null, ticket: null, source: 'tile', resource_uuid: null },
    iat,
    exp: iat + 300,
    nonce: 'AAECAwQFBgcICQoLDA0ODw',
};
const at = (seconds: number) => new Date(seconds * 1000);

describe('verifyIdentityToken', () => {
    it('accepts a valid token and returns its payload', () => {
        expect(
            identity.verifyIdentityToken(signPayload(payload), {
                secret: TEST_SECRET,
                now: at(iat + 10),
            }),
        ).toEqual(payload);
    });

    it('round-trips a minted token', () => {
        const token = identity.mintIdentityToken(
            {
                iss: 'lightdash',
                sub: 'user-uuid',
                email: 'support.person@example.com',
                org: 'org-uuid',
                project: 'project-uuid',
                agent: false,
                attrs: { platform_read: true },
                audit: { source: 'investigate', description: 'why' },
            },
            { secret: TEST_SECRET, now: at(iat) },
        );
        expect(
            identity.verifyIdentityToken(token, {
                secret: TEST_SECRET,
                now: at(iat + 1),
            }),
        ).toMatchObject({ sub: 'user-uuid', audit: { description: 'why' } });
    });

    it('rejects an expired token', () => {
        expect(() =>
            identity.verifyIdentityToken(signPayload(payload), {
                secret: TEST_SECRET,
                now: at(iat + 301),
            }),
        ).toThrow();
    });

    it('rejects a token issued more than 60s in the future', () => {
        expect(() =>
            identity.verifyIdentityToken(signPayload(payload), {
                secret: TEST_SECRET,
                now: at(iat - 61),
            }),
        ).toThrow();
        expect(
            identity.verifyIdentityToken(signPayload(payload), {
                secret: TEST_SECRET,
                now: at(iat - 59),
            }).sub,
        ).toBe('user-uuid');
    });

    it('rejects a wrong version or a bad signature', () => {
        expect(() =>
            identity.verifyIdentityToken(signPayload({ ...payload, v: 2 }), {
                secret: TEST_SECRET,
                now: at(iat + 10),
            }),
        ).toThrow();
        expect(() =>
            identity.verifyIdentityToken(
                signPayload(payload, 'another-test-secret-not-real'),
                { secret: TEST_SECRET, now: at(iat + 10) },
            ),
        ).toThrow();
        expect(() =>
            identity.verifyIdentityToken('not-a-token', {
                secret: TEST_SECRET,
                now: at(iat + 10),
            }),
        ).toThrow();
    });
});
