import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_URL, startHarness, type Harness } from './helpers/harness';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('OAuth 2.1 protected-resource metadata (RFC 9728)', () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        it(`serves ${path} without auth, naming the MCP endpoint and Okta`, async () => {
            const res = await fetch(`${h.serverUrl}${path}`);
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type') ?? '').toContain('application/json');
            const doc = (await res.json()) as Record<string, unknown>;
            expect(doc.resource).toBe(`${PUBLIC_URL}/mcp`);
            expect(doc.authorization_servers).toEqual([h.okta.issuer]);
            expect(doc.bearer_methods_supported).toContain('header');
        });
    }

    it('does not consult Lightdash to serve metadata', () => {
        expect(h.lightdash.requests).toHaveLength(0);
    });
});
