import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startServer, type RunningServer } from './server.js';

const ENV: Record<string, string> = {
    MCP_HOST: '127.0.0.1',
    MCP_PORT: '0',
    MCP_PUBLIC_URL: 'https://telemetry-mcp.example.test',
    OKTA_ISSUER: 'https://okta.example.test/oauth2/default',
    OKTA_AUDIENCE: 'api://telemetry-mcp-test',
    LIGHTDASH_URL: 'https://lightdash.example.test',
    LIGHTDASH_API_TOKEN: 'test-token-not-real',
    LIGHTDASH_PROJECT_UUID: '5c0f8d2e-6b7a-4c1d-9e8f-0a1b2c3d4e5f',
    ENGINE_PG_HOST: 'engine.example.test',
    ENGINE_PG_USER: 'lightdash-operations',
    ENGINE_PG_PASSWORD: 'test-password-not-real',
    ENGINE_HTTP_URL: 'https://engine.example.test:8088',
    HRX_IDENTITY_SECRET: 'test-secret-not-real',
};

describe('http server', () => {
    let server: RunningServer | undefined;
    afterEach(async () => {
        await server?.close();
        server = undefined;
    });

    it('answers /healthz without auth', async () => {
        server = await startServer({ config: loadConfig(ENV) });
        const res = await fetch(`${server.url}/healthz`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('returns 404 for unknown paths', async () => {
        server = await startServer({ config: loadConfig(ENV) });
        const res = await fetch(`${server.url}/nope`);
        expect(res.status).toBe(404);
    });

    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        it(`serves protected-resource metadata at ${path} without auth`, async () => {
            server = await startServer({ config: loadConfig(ENV) });
            const res = await fetch(`${server.url}${path}`);
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('application/json');
            expect(await res.json()).toEqual({
                resource: 'https://telemetry-mcp.example.test/mcp',
                authorization_servers: ['https://okta.example.test/oauth2/default'],
                bearer_methods_supported: ['header'],
                resource_name: 'HouseRx telemetry MCP',
            });
        });
    }

    it('strips a trailing slash from MCP_PUBLIC_URL in the metadata resource', async () => {
        const config = loadConfig({ ...ENV, MCP_PUBLIC_URL: 'https://telemetry-mcp.example.test/' });
        server = await startServer({ config });
        const res = await fetch(`${server.url}/.well-known/oauth-protected-resource`);
        expect(((await res.json()) as { resource: string }).resource).toBe('https://telemetry-mcp.example.test/mcp');
    });

    it('rejects non-GET methods on the metadata path', async () => {
        server = await startServer({ config: loadConfig(ENV) });
        const res = await fetch(`${server.url}/.well-known/oauth-protected-resource`, { method: 'POST' });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
    });

    it('challenges /mcp without a token, pointing at the metadata', async () => {
        server = await startServer({ config: loadConfig(ENV) });
        for (const method of ['POST', 'GET', 'DELETE']) {
            const res = await fetch(`${server.url}/mcp`, { method });
            expect(res.status).toBe(401);
            expect(res.headers.get('www-authenticate')).toBe(
                'Bearer resource_metadata="https://telemetry-mcp.example.test/.well-known/oauth-protected-resource/mcp"',
            );
        }
    });

    it('answers invalid_token for a malformed token without echoing it', async () => {
        server = await startServer({ config: loadConfig(ENV) });
        const res = await fetch(`${server.url}/mcp`, {
            method: 'POST',
            headers: { authorization: 'Bearer not-a-jwt' },
        });
        expect(res.status).toBe(401);
        const challenge = res.headers.get('www-authenticate') ?? '';
        expect(challenge).toContain('error="invalid_token"');
        expect(challenge).not.toContain('not-a-jwt');
        expect(await res.json()).toEqual({ error: 'invalid_token', error_description: 'The access token is malformed' });
    });

    it('rejects a JWT-shaped token that does not decode, without contacting Okta', async () => {
        server = await startServer({ config: loadConfig(ENV) });
        const res = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer aaa.bbb.ccc' } });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate') ?? '').toContain('error="invalid_token"');
    });
});
