import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLightdashUserResolver, LIGHTDASH_GROUPS_PER_USER, UserMappingError } from './userMapping.js';

const ORG = '9b1e7c3a-2d4f-4a6b-8c0d-1e2f3a4b5c6d';
const LIGHTDASH = { url: 'http://lightdash.test', apiToken: 'svc-token-not-real', projectUuid: 'p-1' };

interface Member {
    userUuid: string;
    email: string;
    organizationUuid?: string;
    isActive?: boolean;
    groups?: { uuid: string }[];
}

/** Stubs fetch with a tiny Lightdash: a substring user search (like the real one) and a fixed attribute list. */
function stubLightdash(members: Member[], attributes: unknown[] = [], status = 200) {
    const calls: { url: URL; headers: Record<string, string> }[] = [];
    const fetchStub = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
        if (status !== 200) return new Response('{}', { status });
        if (url.pathname === '/api/v1/org/users') {
            const q = (url.searchParams.get('searchQuery') ?? '').toLowerCase();
            const data = members
                .filter((m) => m.email.toLowerCase().includes(q))
                .map((m) => ({ organizationUuid: ORG, isActive: true, ...m }));
            return Response.json({ status: 'ok', results: { data } });
        }
        if (url.pathname === '/api/v1/org/attributes') return Response.json({ status: 'ok', results: attributes });
        return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub);
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

const DECOY: Member = { userUuid: 'u-decoy', email: 'x.analyst@example.test' };
const TARGET: Member = { userUuid: 'u-target', email: 'analyst@example.test', groups: [{ uuid: 'g-1' }] };

describe('createLightdashUserResolver', () => {
    it('picks the user whose email equals the claim, not a decoy listed first that contains it', async () => {
        stubLightdash([DECOY, TARGET], [{ name: 'platform_explain', groups: [{ groupUuid: 'g-1', value: 'true' }] }]);
        const user = await createLightdashUserResolver(LIGHTDASH).resolve({ sub: '00u1', email: 'analyst@example.test' });
        expect(user).toEqual({
            userUuid: 'u-target',
            email: 'analyst@example.test',
            organizationUuid: ORG,
            attrs: { telemetry_restricted: false, platform_read: false, platform_write: false, platform_explain: true },
        });
    });

    it('matches an email-shaped sub case-insensitively and returns the Lightdash spelling of the email', async () => {
        stubLightdash([DECOY, TARGET]);
        const user = await createLightdashUserResolver(LIGHTDASH).resolve({ sub: 'Analyst@Example.TEST' });
        expect(user.userUuid).toBe('u-target');
        expect(user.email).toBe('analyst@example.test');
    });

    it('sends every call with the service-account ApiKey and asks for groups', async () => {
        const calls = stubLightdash([TARGET]);
        await createLightdashUserResolver(LIGHTDASH).resolve({ email: 'analyst@example.test' });
        expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/org/users', '/api/v1/org/attributes']);
        for (const c of calls) expect(c.headers.Authorization).toBe('ApiKey svc-token-not-real');
        expect(calls[0].url.searchParams.get('searchQuery')).toBe('analyst@example.test');
        expect(calls[0].url.searchParams.get('includeGroups')).toBe(String(LIGHTDASH_GROUPS_PER_USER));
    });

    it('rejects when only a decoy contains the email, or the exact match is inactive', async () => {
        stubLightdash([DECOY, { ...TARGET, isActive: false }]);
        const resolver = createLightdashUserResolver(LIGHTDASH);
        await expect(resolver.resolve({ email: 'analyst@example.test' })).rejects.toThrow(
            'Your Okta user has no active Lightdash user with the same email',
        );
        await expect(resolver.resolve({ email: 'nalyst@example.test' })).rejects.toBeInstanceOf(UserMappingError);
    });

    it('rejects without calling Lightdash when the token has no email', async () => {
        const calls = stubLightdash([TARGET]);
        await expect(createLightdashUserResolver(LIGHTDASH).resolve({ sub: '00u-okta-only' })).rejects.toThrow(
            'Your access token has no email to match a Lightdash user',
        );
        expect(calls).toHaveLength(0);
    });

    it('turns a Lightdash HTTP error or network failure into a UserMappingError', async () => {
        stubLightdash([TARGET], [], 403);
        await expect(createLightdashUserResolver(LIGHTDASH).resolve({ email: 'analyst@example.test' })).rejects.toThrow(
            'Lightdash refused the user lookup (HTTP 403)',
        );
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
        await expect(createLightdashUserResolver(LIGHTDASH).resolve({ email: 'analyst@example.test' })).rejects.toThrow(
            'Could not reach Lightdash to look up your user',
        );
    });
});
