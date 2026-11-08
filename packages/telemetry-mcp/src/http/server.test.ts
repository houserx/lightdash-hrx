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
});
