import { createHash, createHmac } from 'node:crypto';
import {
    MAX_WRITE_CONFIRMATION_TTL_SECONDS,
    mintWriteConfirmationToken,
} from './writeConfirmationToken';

const secret = 'unit-test-secret';
const now = new Date('2026-01-01T00:00:00Z');
const nonce = Buffer.alloc(16, 7);
const base = {
    statement: 'DELETE FROM widgets WHERE id = 1',
    userUuid: 'user-uuid',
    projectUuid: 'project-uuid',
    secret,
    now,
    nonce,
};

const decode = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

describe('mintWriteConfirmationToken', () => {
    it('signs a payload bound to statement, user, project, expiry and nonce', () => {
        const { token, payload } = mintWriteConfirmationToken(base);
        const [encoded, signature] = token.split('.');
        expect(signature).toBe(
            createHmac('sha256', secret).update(encoded).digest('base64url'),
        );
        expect(decode(token)).toEqual(payload);
        expect(payload).toEqual({
            v: 1,
            statement_sha256: createHash('sha256')
                .update(base.statement)
                .digest('hex'),
            sub: 'user-uuid',
            project: 'project-uuid',
            exp: now.getTime() / 1000 + MAX_WRITE_CONFIRMATION_TTL_SECONDS,
            nonce: nonce.toString('base64url'),
        });
    });

    it('caps the lifetime at 120 seconds', () => {
        const { payload } = mintWriteConfirmationToken({
            ...base,
            ttlSeconds: 3600,
        });
        expect(payload.exp - now.getTime() / 1000).toBe(120);
        expect(
            mintWriteConfirmationToken({ ...base, ttlSeconds: 30 }).payload
                .exp -
                now.getTime() / 1000,
        ).toBe(30);
    });

    it('binds different statements to different hashes', () => {
        const a = mintWriteConfirmationToken(base).payload;
        const b = mintWriteConfirmationToken({
            ...base,
            statement: `${base.statement} `,
        }).payload;
        expect(a.statement_sha256).not.toBe(b.statement_sha256);
    });

    it('uses a fresh random nonce by default', () => {
        const { nonce: _nonce, ...withoutNonce } = base;
        const a = mintWriteConfirmationToken(withoutNonce).payload.nonce;
        const b = mintWriteConfirmationToken(withoutNonce).payload.nonce;
        expect(Buffer.from(a, 'base64url')).toHaveLength(16);
        expect(a).not.toBe(b);
    });

    it('refuses a missing secret or a wrong-size nonce', () => {
        expect(() =>
            mintWriteConfirmationToken({ ...base, secret: '' }),
        ).toThrow(/secret/);
        expect(() =>
            mintWriteConfirmationToken({ ...base, nonce: Buffer.alloc(8) }),
        ).toThrow(/16 bytes/);
    });
});
