import { describe, expect, it } from 'vitest';
import { createCachedUserResolver } from './userCache.js';
import { UserMappingError, type MappedUser, type UserResolver } from './userMapping.js';

const ATTRS = { telemetry_restricted: false, platform_read: true, platform_write: false, platform_explain: false };

/** A resolver that counts lookups and answers from a mutable table keyed by lower-cased email. */
function countingResolver(known: Map<string, MappedUser>) {
    let lookups = 0;
    const resolver: UserResolver = {
        async resolve(claims) {
            lookups += 1;
            await Promise.resolve();
            const email = String((claims as { email?: unknown }).email ?? '').toLowerCase();
            const user = known.get(email);
            if (!user) throw new UserMappingError('Your Okta user has no active Lightdash user with the same email');
            return user;
        },
    };
    return { resolver, lookups: () => lookups };
}

const user = (email: string, platformRead = true): MappedUser => ({
    userUuid: `u-${email}`,
    email,
    organizationUuid: 'org-1',
    attrs: { ...ATTRS, platform_read: platformRead },
});

describe('createCachedUserResolver', () => {
    it('looks a user up once within the TTL and again after it', async () => {
        const known = new Map([['a@example.test', user('a@example.test')]]);
        const inner = countingResolver(known);
        let clock = 1_000;
        const cached = createCachedUserResolver(inner.resolver, 5_000, () => clock);

        await cached.resolve({ email: 'a@example.test' });
        clock += 4_999;
        await cached.resolve({ email: 'A@Example.test' });
        expect(inner.lookups()).toBe(1);

        known.set('a@example.test', user('a@example.test', false));
        clock += 1;
        const fresh = await cached.resolve({ email: 'a@example.test' });
        expect(inner.lookups()).toBe(2);
        expect(fresh.attrs.platform_read).toBe(false);
    });

    it('keeps users apart', async () => {
        const known = new Map([
            ['a@example.test', user('a@example.test')],
            ['b@example.test', user('b@example.test')],
        ]);
        const inner = countingResolver(known);
        const cached = createCachedUserResolver(inner.resolver, 5_000, () => 0);
        expect((await cached.resolve({ email: 'a@example.test' })).userUuid).toBe('u-a@example.test');
        expect((await cached.resolve({ email: 'b@example.test' })).userUuid).toBe('u-b@example.test');
        expect(inner.lookups()).toBe(2);
    });

    it('shares one lookup between concurrent calls', async () => {
        const inner = countingResolver(new Map([['a@example.test', user('a@example.test')]]));
        const cached = createCachedUserResolver(inner.resolver, 5_000, () => 0);
        await Promise.all([1, 2, 3].map(() => cached.resolve({ email: 'a@example.test' })));
        expect(inner.lookups()).toBe(1);
    });

    it('does not cache failures', async () => {
        const known = new Map<string, MappedUser>();
        const inner = countingResolver(known);
        const cached = createCachedUserResolver(inner.resolver, 5_000, () => 0);
        await expect(cached.resolve({ email: 'new@example.test' })).rejects.toBeInstanceOf(UserMappingError);
        known.set('new@example.test', user('new@example.test'));
        await expect(cached.resolve({ email: 'new@example.test' })).resolves.toMatchObject({ email: 'new@example.test' });
        expect(inner.lookups()).toBe(2);
    });

    it('passes claims without an email straight through', async () => {
        const inner = countingResolver(new Map());
        const cached = createCachedUserResolver(inner.resolver, 5_000, () => 0);
        await expect(cached.resolve({ sub: '00u-opaque' })).rejects.toBeInstanceOf(UserMappingError);
        await expect(cached.resolve({ sub: '00u-opaque' })).rejects.toBeInstanceOf(UserMappingError);
        expect(inner.lookups()).toBe(2);
    });

    it('is off when the TTL is 0', async () => {
        const inner = countingResolver(new Map([['a@example.test', user('a@example.test')]]));
        const cached = createCachedUserResolver(inner.resolver, 0, () => 0);
        await cached.resolve({ email: 'a@example.test' });
        await cached.resolve({ email: 'a@example.test' });
        expect(inner.lookups()).toBe(2);
    });
});
