// ldq-identity-token-mint: CONTRACTS §3 tokens are byte-exact for fixed inputs and clock:
// canonical key order, base64url without padding, HMAC-SHA256 over the encoded payload.
import { load } from './load';
import { TEST_SECRET } from './tokens';

let identity: any;

beforeAll(async () => {
    identity = await load('../../services/FederationIdentity/identityToken');
}, 120_000);

const nonce = Buffer.from([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);
const now = new Date('2026-01-01T00:00:00.000Z');

// Keys deliberately out of order: the token must use the contract's order.
const claims = {
    audit: {
        resource_uuid: null,
        source: 'investigate',
        ticket: 'ENG-123',
        description: 'Investigate a failed refill',
    },
    attrs: {
        platform_explain: true,
        platform_write: false,
        platform_read: true,
        telemetry_restricted: false,
    },
    sys: false,
    agent: false,
    project: '7a8b9c0d-0000-4000-8000-0000000000bb',
    org: '0b1c2d3e-0000-4000-8000-0000000000aa',
    email: 'support.person@example.com',
    sub: '3f6e1a2b-0000-4000-8000-000000000001',
    iss: 'lightdash',
};

const EXPECTED =
    'eyJ2IjoxLCJpc3MiOiJsaWdodGRhc2giLCJzdWIiOiIzZjZlMWEyYi0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJlbWFpbCI6InN1cHBvcnQucGVyc29uQGV4YW1wbGUuY29tIiwib3JnIjoiMGIxYzJkM2UtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMGFhIiwicHJvamVjdCI6IjdhOGI5YzBkLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDBiYiIsImFnZW50IjpmYWxzZSwic3lzIjpmYWxzZSwiYXR0cnMiOnsidGVsZW1ldHJ5X3Jlc3RyaWN0ZWQiOmZhbHNlLCJwbGF0Zm9ybV9yZWFkIjp0cnVlLCJwbGF0Zm9ybV93cml0ZSI6ZmFsc2UsInBsYXRmb3JtX2V4cGxhaW4iOnRydWV9LCJhdWRpdCI6eyJkZXNjcmlwdGlvbiI6IkludmVzdGlnYXRlIGEgZmFpbGVkIHJlZmlsbCIsInRpY2tldCI6IkVORy0xMjMiLCJzb3VyY2UiOiJpbnZlc3RpZ2F0ZSIsInJlc291cmNlX3V1aWQiOm51bGx9LCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6MTc2NzIyNTkwMCwibm9uY2UiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R3In0.bD6nC49aCI6RCSKvGXG0MlNePFA6_vBKzkBvdb7LbsY';

const EXPECTED_AGENT_TILE =
    'eyJ2IjoxLCJpc3MiOiJsaWdodGRhc2giLCJzdWIiOiIzZjZlMWEyYi0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJlbWFpbCI6InN1cHBvcnQucGVyc29uQGV4YW1wbGUuY29tIiwib3JnIjoiMGIxYzJkM2UtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMGFhIiwicHJvamVjdCI6IjdhOGI5YzBkLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDBiYiIsImFnZW50Ijp0cnVlLCJzeXMiOmZhbHNlLCJhdHRycyI6eyJ0ZWxlbWV0cnlfcmVzdHJpY3RlZCI6ZmFsc2UsInBsYXRmb3JtX3JlYWQiOmZhbHNlLCJwbGF0Zm9ybV93cml0ZSI6ZmFsc2UsInBsYXRmb3JtX2V4cGxhaW4iOmZhbHNlfSwiYXVkaXQiOnsiZGVzY3JpcHRpb24iOm51bGwsInRpY2tldCI6bnVsbCwic291cmNlIjoidGlsZSIsInJlc291cmNlX3V1aWQiOiI5ZDhjN2I2YS0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwY2MifSwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjE3NjcyMjU5MDAsIm5vbmNlIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EdyJ9.Xp13502dWUpfFQeZsL9ztLdDZMKa80ij7d-TxKyWSb8';

describe('mintIdentityToken', () => {
    it('mints the exact token for fixed inputs, clock and nonce', () => {
        expect(
            identity.mintIdentityToken(claims, {
                secret: TEST_SECRET,
                now,
                nonce,
            }),
        ).toBe(EXPECTED);
    });

    it('fills missing audit fields with null and keeps the agent flag', () => {
        expect(
            identity.mintIdentityToken(
                {
                    iss: 'lightdash',
                    sub: '3f6e1a2b-0000-4000-8000-000000000001',
                    email: 'support.person@example.com',
                    org: '0b1c2d3e-0000-4000-8000-0000000000aa',
                    project: '7a8b9c0d-0000-4000-8000-0000000000bb',
                    agent: true,
                    attrs: {},
                    audit: {
                        source: 'tile',
                        resource_uuid: '9d8c7b6a-0000-4000-8000-0000000000cc',
                    },
                },
                { secret: TEST_SECRET, now, nonce },
            ),
        ).toBe(EXPECTED_AGENT_TILE);
    });

    it('caps the lifetime at 300 seconds', () => {
        const token = identity.mintIdentityToken(claims, {
            secret: TEST_SECRET,
            now,
            nonce,
            ttlSeconds: 3600,
        });
        const payload = JSON.parse(
            Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
        );
        expect(payload.exp - payload.iat).toBe(300);
    });

    it('uses a fresh random nonce when none is given', () => {
        const a = identity.mintIdentityToken(claims, { secret: TEST_SECRET, now });
        const b = identity.mintIdentityToken(claims, { secret: TEST_SECRET, now });
        expect(a).not.toBe(b);
    });
});
