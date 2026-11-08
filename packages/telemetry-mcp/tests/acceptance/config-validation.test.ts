import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PKG_DIR } from './helpers/files';
import { api } from './helpers/harness';

const REQUIRED = [
    'MCP_PUBLIC_URL',
    'OKTA_ISSUER',
    'OKTA_AUDIENCE',
    'LIGHTDASH_URL',
    'LIGHTDASH_API_TOKEN',
    'LIGHTDASH_PROJECT_UUID',
    'ENGINE_PG_HOST',
    'ENGINE_PG_USER',
    'ENGINE_PG_PASSWORD',
    'ENGINE_HTTP_URL',
    'HRX_IDENTITY_SECRET',
];

const VALID: Record<string, string> = {
    MCP_PUBLIC_URL: 'https://telemetry-mcp.example.test',
    OKTA_ISSUER: 'https://okta.example.test/oauth2/default',
    OKTA_AUDIENCE: 'api://telemetry-mcp-test',
    LIGHTDASH_URL: 'https://lightdash.example.test',
    LIGHTDASH_API_TOKEN: 'test-service-token-not-real',
    LIGHTDASH_PROJECT_UUID: '5c0f8d2e-6b7a-4c1d-9e8f-0a1b2c3d4e5f',
    ENGINE_PG_HOST: 'engine.example.test',
    ENGINE_PG_USER: 'lightdash-operations',
    ENGINE_PG_PASSWORD: 'test-pg-password-not-real',
    ENGINE_HTTP_URL: 'https://engine.example.test:8088',
    HRX_IDENTITY_SECRET: 'test-identity-secret-not-real',
};

function errorOf(fn: () => unknown): string {
    try {
        fn();
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
    return '';
}

describe('config from env with validation', () => {
    it('exports loadConfig(env)', () => {
        expect(typeof api.loadConfig).toBe('function');
    });

    it('accepts a complete env and fills defaults for optional settings', () => {
        expect(() => api.loadConfig(VALID)).not.toThrow();
        expect(api.loadConfig(VALID)).toBeTruthy();
    });

    it('rejects an empty env, naming every missing required variable', () => {
        const msg = errorOf(() => api.loadConfig({}));
        expect(msg).not.toBe('');
        for (const name of REQUIRED) expect(msg).toContain(name);
    });

    it('rejects malformed values, naming each bad variable, without echoing secrets', () => {
        const msg = errorOf(() =>
            api.loadConfig({
                ...VALID,
                MCP_PORT: 'not-a-port',
                OKTA_ISSUER: 'not a url',
                MCP_SOURCES: '{not json',
                MCP_MAX_ROWS: '-5',
            }),
        );
        expect(msg).not.toBe('');
        for (const name of ['MCP_PORT', 'OKTA_ISSUER', 'MCP_SOURCES', 'MCP_MAX_ROWS']) expect(msg).toContain(name);
        expect(msg).not.toContain('test-identity-secret-not-real');
        expect(msg).not.toContain('test-service-token-not-real');
        expect(msg).not.toContain('test-pg-password-not-real');
    });

    it('rejects a source list entry with an unknown kind', () => {
        const msg = errorOf(() =>
            api.loadConfig({ ...VALID, MCP_SOURCES: JSON.stringify([{ name: 'x', kind: 'graphite' }]) }),
        );
        expect(msg).toContain('MCP_SOURCES');
    });

    it('makes the built entry point exit non-zero with a clear message when env is incomplete', () => {
        const res = spawnSync(process.execPath, [path.join(PKG_DIR, 'dist/main.js')], {
            env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
            encoding: 'utf8',
            timeout: 15_000,
        });
        expect(res.status).not.toBe(0);
        expect(res.status).not.toBeNull();
        expect(`${res.stderr}${res.stdout}`).toContain('OKTA_ISSUER');
    }, 20_000);
});
