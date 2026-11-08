import { describe, expect, it } from 'vitest';
import { api, IDENTITY_SECRET } from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';

// CONTRACTS.md §3, byte for byte: payload keys in contract order, unpadded base64url, HMAC-SHA256
// over the base64url payload, iss = "telemetry-mcp", agent = true, sys = false, 60 s lifetime.
const FIXED = {
    secret: IDENTITY_SECRET,
    sub: '3f6d0c1e-8a52-4d0b-9c7e-1a2b3c4d5e6f',
    email: 'analyst@example.test',
    org: '9b1e7c3a-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
    project: '5c0f8d2e-6b7a-4c1d-9e8f-0a1b2c3d4e5f',
    attrs: { telemetry_restricted: false, platform_read: true, platform_write: false, platform_explain: true },
    nowSeconds: 1767225600,
    nonce: 'AAECAwQFBgcICQoLDA0ODw',
};

const EXPECTED_WITH_AUDIT =
    'eyJ2IjoxLCJpc3MiOiJ0ZWxlbWV0cnktbWNwIiwic3ViIjoiM2Y2ZDBjMWUtOGE1Mi00ZDBiLTljN2UtMWEyYjNjNGQ1ZTZmIiwiZW1haWwiOiJhbmFseXN0QGV4YW1wbGUudGVzdCIsIm9yZyI6IjliMWU3YzNhLTJkNGYtNGE2Yi04YzBkLTFlMmYzYTRiNWM2ZCIsInByb2plY3QiOiI1YzBmOGQyZS02YjdhLTRjMWQtOWU4Zi0wYTFiMmMzZDRlNWYiLCJhZ2VudCI6dHJ1ZSwic3lzIjpmYWxzZSwiYXR0cnMiOnsidGVsZW1ldHJ5X3Jlc3RyaWN0ZWQiOmZhbHNlLCJwbGF0Zm9ybV9yZWFkIjp0cnVlLCJwbGF0Zm9ybV93cml0ZSI6ZmFsc2UsInBsYXRmb3JtX2V4cGxhaW4iOnRydWV9LCJhdWRpdCI6eyJkZXNjcmlwdGlvbiI6IkNvdW50IG9yZGVycyBieSBzdGF0dXMiLCJ0aWNrZXQiOiJFTkctMTIzIiwic291cmNlIjoibWNwIiwicmVzb3VyY2VfdXVpZCI6bnVsbH0sImlhdCI6MTc2NzIyNTYwMCwiZXhwIjoxNzY3MjI1NjYwLCJub25jZSI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHcifQ.NyfLQx-XjVw4zAwqXTt5ZM4hQapnDYnNuvSs0TeQ_Os';

const EXPECTED_NO_AUDIT =
    'eyJ2IjoxLCJpc3MiOiJ0ZWxlbWV0cnktbWNwIiwic3ViIjoiM2Y2ZDBjMWUtOGE1Mi00ZDBiLTljN2UtMWEyYjNjNGQ1ZTZmIiwiZW1haWwiOiJhbmFseXN0QGV4YW1wbGUudGVzdCIsIm9yZyI6IjliMWU3YzNhLTJkNGYtNGE2Yi04YzBkLTFlMmYzYTRiNWM2ZCIsInByb2plY3QiOiI1YzBmOGQyZS02YjdhLTRjMWQtOWU4Zi0wYTFiMmMzZDRlNWYiLCJhZ2VudCI6dHJ1ZSwic3lzIjpmYWxzZSwiYXR0cnMiOnsidGVsZW1ldHJ5X3Jlc3RyaWN0ZWQiOmZhbHNlLCJwbGF0Zm9ybV9yZWFkIjp0cnVlLCJwbGF0Zm9ybV93cml0ZSI6ZmFsc2UsInBsYXRmb3JtX2V4cGxhaW4iOnRydWV9LCJhdWRpdCI6eyJkZXNjcmlwdGlvbiI6bnVsbCwidGlja2V0IjpudWxsLCJzb3VyY2UiOiJtY3AiLCJyZXNvdXJjZV91dWlkIjpudWxsfSwiaWF0IjoxNzY3MjI1NjAwLCJleHAiOjE3NjcyMjU2NjAsIm5vbmNlIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EdyJ9.P_31Yknb77h_-HKN08ZQGfgw5Yy1fhuwQMuv_cjxfXw';

describe('identity tokens (CONTRACTS §3)', () => {
    it('exports mintIdentityToken', () => {
        expect(typeof api.mintIdentityToken).toBe('function');
    });

    it('produces the exact contract bytes for fixed inputs with an audit description', () => {
        const token = api.mintIdentityToken({
            ...FIXED,
            audit: { description: 'Count orders by status', ticket: 'ENG-123' },
        });
        expect(token).toBe(EXPECTED_WITH_AUDIT);
    });

    it('produces the exact contract bytes for fixed inputs without an audit description', () => {
        const token = api.mintIdentityToken({ ...FIXED, audit: null });
        expect(token).toBe(EXPECTED_NO_AUDIT);
    });

    it('uses a fresh 16-byte nonce and the current clock when none is given', () => {
        const { nonce: _n, nowSeconds: _t, ...rest } = FIXED;
        const before = Math.floor(Date.now() / 1000);
        const a = verifyIdentityToken(api.mintIdentityToken({ ...rest, audit: null }), IDENTITY_SECRET);
        const b = verifyIdentityToken(api.mintIdentityToken({ ...rest, audit: null }), IDENTITY_SECRET);
        expect(a.nonce).not.toBe(b.nonce);
        expect(Buffer.from(a.nonce, 'base64url')).toHaveLength(16);
        expect(a.iat).toBeGreaterThanOrEqual(before - 1);
        expect(a.iat).toBeLessThanOrEqual(before + 2);
        expect(a.exp - a.iat).toBe(60);
        expect(a.iss).toBe('telemetry-mcp');
        expect(a.agent).toBe(true);
        expect(a.sys).toBe(false);
    });
});
