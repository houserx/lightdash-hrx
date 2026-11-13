import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintIdentityToken } from './token.js';

const BASE = {
    secret: 'unit-test-secret',
    sub: 'user-uuid',
    email: 'someone@example.test',
    org: 'org-uuid',
    project: 'project-uuid',
    attrs: {
        platform_explain: true,
        platform_write: false,
        platform_read: true,
        telemetry_restricted: false,
    },
    nowSeconds: 1000,
    nonce: 'bm9uY2U',
};

const decode = (token: string) => {
    const [payload, sig] = token.split('.') as [string, string];
    return {
        payload,
        sig,
        json: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    };
};

describe('mintIdentityToken', () => {
    it('signs the base64url payload with HMAC-SHA256 and uses no padding', () => {
        const token = mintIdentityToken(BASE);
        const { payload, sig } = decode(token);
        expect(token).not.toMatch(/[=+/]/);
        expect(sig).toBe(
            crypto.createHmac('sha256', BASE.secret).update(payload).digest('base64url'),
        );
    });

    it('serialises keys in contract order regardless of input order', () => {
        const { json } = decode(mintIdentityToken(BASE));
        expect(Object.keys(json)).toEqual([
            'v', 'iss', 'sub', 'email', 'org', 'project', 'agent', 'sys',
            'attrs', 'audit', 'iat', 'exp', 'nonce',
        ]);
        expect(Object.keys(json.attrs)).toEqual([
            'telemetry_restricted', 'platform_read', 'platform_write', 'platform_explain',
        ]);
        expect(json.audit).toEqual({
            description: null,
            ticket: null,
            source: 'mcp',
            resource_uuid: null,
        });
        expect(json).toMatchObject({ v: 1, iss: 'telemetry-mcp', agent: true, sys: false });
        expect(json.exp - json.iat).toBe(60);
    });

    it('keeps a description without a ticket', () => {
        const { json } = decode(mintIdentityToken({ ...BASE, audit: { description: 'why' } }));
        expect(json.audit.description).toBe('why');
        expect(json.audit.ticket).toBeNull();
    });
});
