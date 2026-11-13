/**
 * Per-user TTL cache in front of a `UserResolver` (`MCP_USER_CACHE_TTL_MS`).
 *
 * A successful mapping is kept for the TTL, keyed by the lower-cased email the mapping uses, then looked up again so
 * attribute changes in Lightdash take effect. Concurrent lookups for the same email share one Lightdash request.
 * Failures are not cached: an unknown or deactivated user is refused on every request until Lightdash knows them, and
 * a Lightdash outage is not remembered after it ends. A TTL of 0 turns the cache off.
 */
import type { JWTPayload } from 'jose';
import { emailFromClaims, type MappedUser, type UserResolver } from './userMapping.js';

interface Entry {
    user: MappedUser;
    /** Clock time (epoch ms) at which the entry stops being used. */
    expiresAt: number;
}

export function createCachedUserResolver(inner: UserResolver, ttlMs: number, now: () => number): UserResolver {
    if (ttlMs <= 0) return inner;
    const entries = new Map<string, Entry>();
    const inFlight = new Map<string, Promise<MappedUser>>();

    /** Drops expired entries so the map holds only users seen within the last TTL. */
    const prune = (t: number): void => {
        for (const [key, entry] of entries) if (entry.expiresAt <= t) entries.delete(key);
    };

    return {
        resolve(claims: JWTPayload): Promise<MappedUser> {
            const email = emailFromClaims(claims);
            if (!email) return inner.resolve(claims);
            const key = email.toLowerCase();
            const cached = entries.get(key);
            if (cached && cached.expiresAt > now()) return Promise.resolve(cached.user);
            const pending = inFlight.get(key);
            if (pending) return pending;

            const tracked = inner
                .resolve(claims)
                .then((user) => {
                    const t = now();
                    prune(t);
                    entries.set(key, { user, expiresAt: t + ttlMs });
                    return user;
                })
                .finally(() => inFlight.delete(key));
            inFlight.set(key, tracked);
            return tracked;
        },
    };
}
