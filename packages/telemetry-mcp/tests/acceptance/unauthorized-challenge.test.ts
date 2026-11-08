import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness';
import { postInitialize } from './helpers/http';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const METADATA_RE =
    /resource_metadata="https:\/\/telemetry-mcp\.example\.test\/\.well-known\/oauth-protected-resource(\/mcp)?"/;

describe('401 with a WWW-Authenticate challenge', () => {
    it('challenges a request with no Authorization header and points at the metadata', async () => {
        const res = await postInitialize(h.mcpUrl);
        expect(res.status).toBe(401);
        const challenge = res.headers.get('www-authenticate') ?? '';
        expect(challenge).toMatch(/^Bearer\b/);
        expect(challenge).toMatch(METADATA_RE);
    });

    it('challenges a GET on the MCP endpoint with no token', async () => {
        const res = await fetch(h.mcpUrl, { headers: { accept: 'text/event-stream' } });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate') ?? '').toMatch(/^Bearer\b/);
    });

    it('rejects a malformed token with error="invalid_token"', async () => {
        const res = await postInitialize(h.mcpUrl, 'not-a-jwt');
        expect(res.status).toBe(401);
        const challenge = res.headers.get('www-authenticate') ?? '';
        expect(challenge).toMatch(/^Bearer\b/);
        expect(challenge).toContain('error="invalid_token"');
        expect(challenge).toMatch(METADATA_RE);
    });

    it('rejects a non-Bearer scheme', async () => {
        const res = await fetch(h.mcpUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: 'Basic dXNlcjpwYXNz',
            },
            body: '{}',
        });
        expect(res.status).toBe(401);
    });

    it('never reaches Lightdash or the engine for an unauthenticated request', () => {
        expect(h.lightdash.requests).toHaveLength(0);
        expect(h.engine.connectionCount()).toBe(0);
    });
});
