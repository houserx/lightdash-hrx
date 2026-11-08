import { describe, expect, it } from 'vitest';
import { emailFromClaims, resolveAttrs, type MappedUser, type UserResolver } from '../auth/userMapping.js';
import { sessionStatements } from './client.js';
import { createIdentitySession } from './session.js';

const SECRET = 'test-secret-not-real';
const PROJECT = '5c0f8d2e-6b7a-4c1d-9e8f-0a1b2c3d4e5f';
const USER: MappedUser = {
    userUuid: '3f6d0c1e-8a52-4d0b-9c7e-1a2b3c4d5e6f',
    email: 'analyst@example.test',
    organizationUuid: '9b1e7c3a-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
    attrs: { telemetry_restricted: false, platform_read: true, platform_write: false, platform_explain: true },
};

const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));

describe('sessionStatements', () => {
    it('sets the identity first, then the statement timeout', () => {
        expect(sessionStatements('abc_-1.xyz-_2', 30000)).toEqual([
            "SET hrx.identity = 'abc_-1.xyz-_2'",
            'SET statement_timeout = 30000',
        ]);
    });

    it('refuses anything that is not a §3 token or a positive integer timeout', () => {
        expect(() => sessionStatements("a.b'; DROP TABLE x; --", 30000)).toThrow(/§3 token/);
        expect(() => sessionStatements('a.b.c', 30000)).toThrow(/§3 token/);
        expect(() => sessionStatements('a.b', 0)).toThrow(/timeout/);
        expect(() => sessionStatements('a.b', 1.5)).toThrow(/timeout/);
    });
});

describe('createIdentitySession', () => {
    it('mints a fresh §3 token per query for the mapped user, resolving the user once', async () => {
        let resolves = 0;
        const users: UserResolver = {
            async resolve() {
                resolves += 1;
                return USER;
            },
        };
        const now = 1_800_000_000_000;
        const session = createIdentitySession(
            { identitySecret: SECRET, statementTimeoutMs: 30000, lightdash: { url: 'x', apiToken: 'y', projectUuid: PROJECT } },
            users,
            { email: USER.email },
            () => now,
        );
        expect(session.statementTimeoutMs).toBe(30000);
        const a = payloadOf(await session.identityToken(null));
        const b = payloadOf(await session.identityToken({ description: 'why', ticket: 'ENG-1' }));
        expect(resolves).toBe(1);
        expect(a).toMatchObject({
            iss: 'telemetry-mcp',
            sub: USER.userUuid,
            email: USER.email,
            org: USER.organizationUuid,
            project: PROJECT,
            agent: true,
            attrs: USER.attrs,
            audit: { description: null, ticket: null, source: 'mcp' },
            iat: now / 1000,
        });
        expect(b.audit).toMatchObject({ description: 'why', ticket: 'ENG-1' });
        expect(a.nonce).not.toBe(b.nonce);
    });
});

describe('user mapping helpers', () => {
    it('takes the email claim, else an email-shaped sub', () => {
        expect(emailFromClaims({ sub: '00u1', email: 'a@example.test' })).toBe('a@example.test');
        expect(emailFromClaims({ sub: 'A@Example.TEST' })).toBe('A@Example.TEST');
        expect(emailFromClaims({ sub: '00u1' })).toBeUndefined();
    });

    it('resolves direct values, then group "true" values, then defaults; only "true" is true', () => {
        const attrs = resolveAttrs(
            [
                { name: 'platform_read', groups: [{ groupUuid: 'g1', value: 'true' }], attributeDefault: 'false' },
                { name: 'platform_explain', users: [{ userUuid: 'u1', value: 'false' }], attributeDefault: 'true' },
                { name: 'platform_write', users: [{ userUuid: 'u1', value: 'yes' }] },
                { name: 'telemetry_restricted', attributeDefault: 'true' },
            ],
            'u1',
            new Set(['g1']),
        );
        expect(attrs).toEqual({
            telemetry_restricted: true,
            platform_read: true,
            platform_write: false,
            platform_explain: false,
        });
        expect(resolveAttrs([], 'u1', new Set())).toEqual({
            telemetry_restricted: false,
            platform_read: false,
            platform_write: false,
            platform_explain: false,
        });
    });
});
