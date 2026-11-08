import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORG_UUID, startHarness, type Harness } from './helpers/harness';

let h: Harness;
beforeAll(async () => {
    h = await startHarness({
        users: [
            {
                userUuid: '2a2a2a2a-1111-4222-8333-444444444444',
                email: 'former@example.test',
                organizationUuid: ORG_UUID,
                isActive: false,
            },
            {
                userUuid: '3b3b3b3b-1111-4222-8333-444444444444',
                email: 'analyst@example.test',
                organizationUuid: ORG_UUID,
            },
        ],
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('an unknown user gets no tools', () => {
    const cases: [string, Record<string, unknown>][] = [
        ['an email Lightdash does not know', { sub: '00u-stranger', email: 'stranger@example.test' }],
        ['a deactivated Lightdash user', { sub: '00u-former', email: 'former@example.test' }],
        ['a token with no email claim and a non-email sub', { sub: '00u-opaque-id', email: undefined }],
    ];
    for (const [label, claims] of cases) {
        it(`lists no tools and refuses calls for ${label}`, async () => {
            const token = h.okta.sign(claims);
            const tools = await h.listTools(token);
            expect(tools).toEqual([]);
            const r = await h.call('list_sources', {}, token);
            expect(r.isError).toBe(true);
        });
    }

    it('never opened an engine connection for them', () => {
        expect(h.engine.connectionCount()).toBe(0);
    });

    it('still serves a known user', async () => {
        const tools = await h.listTools(h.okta.sign({ sub: '00u-ok', email: 'analyst@example.test' }));
        expect(tools.length).toBeGreaterThan(0);
    });
});
