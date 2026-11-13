import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const VALID_ENV: Record<string, string> = {
    MCP_PUBLIC_URL: 'https://telemetry-mcp.example.test/',
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

function problemsOf(env: Record<string, string | undefined>): string[] {
    try {
        loadConfig(env);
    } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return (err as ConfigError).problems;
    }
    return [];
}

describe('loadConfig', () => {
    it('fills defaults for optional settings', () => {
        const config = loadConfig(VALID_ENV);
        expect(config).toMatchObject({
            host: '0.0.0.0',
            port: 8080,
            publicUrl: 'https://telemetry-mcp.example.test',
            okta: { jwksUri: 'https://okta.example.test/oauth2/default/v1/keys' },
            engine: { pgPort: 5433, pgDatabase: 'operations' },
            sources: [],
            platformSource: 'platform',
            statementTimeoutMs: 30_000,
            maxRows: 1000,
            maxOutputBytes: 200_000,
            userCacheTtlMs: 60_000,
            askMaxSteps: 60,
            anthropicApiKey: undefined,
            logLevel: 'info',
        });
    });

    it('parses MCP_SOURCES with flag defaults', () => {
        const config = loadConfig({
            ...VALID_ENV,
            MCP_SOURCES: JSON.stringify([
                { name: 'loki-platform', kind: 'loki', restricted: true },
                { name: 'platform', kind: 'platform_postgres', default: true },
            ]),
        });
        expect(config.sources).toEqual([
            { name: 'loki-platform', kind: 'loki', default: false, restricted: true },
            { name: 'platform', kind: 'platform_postgres', default: true, restricted: false },
        ]);
    });

    it('treats blank values as missing', () => {
        expect(problemsOf({ ...VALID_ENV, OKTA_AUDIENCE: '  ', HRX_IDENTITY_SECRET: '' })).toEqual([
            'OKTA_AUDIENCE is required',
            'HRX_IDENTITY_SECRET is required',
        ]);
    });

    it('reports every malformed value at once', () => {
        const problems = problemsOf({
            ...VALID_ENV,
            MCP_PORT: '70000',
            ENGINE_HTTP_URL: 'ftp://engine.example.test',
            LIGHTDASH_PROJECT_UUID: 'not-a-uuid',
            MCP_USER_CACHE_TTL_MS: '1.5',
            LOG_LEVEL: 'loud',
            MCP_SOURCES: JSON.stringify([{ name: 'a', kind: 'loki' }, { name: 'a', kind: 'tempo', default: 'yes' }]),
        });
        expect(problems.join('\n')).toMatchInlineSnapshot(`
          "MCP_PORT must be an integer between 0 and 65535
          LIGHTDASH_PROJECT_UUID must be a UUID
          ENGINE_HTTP_URL must be an absolute http(s) URL
          MCP_SOURCES[1].name duplicates an earlier entry
          MCP_SOURCES[1].default must be true or false
          MCP_USER_CACHE_TTL_MS must be an integer >= 0
          LOG_LEVEL must be one of debug, info, warn, error"
        `);
    });

    it('rejects a source list that is not a list, and unknown kinds', () => {
        expect(problemsOf({ ...VALID_ENV, MCP_SOURCES: '{}' })).toEqual([
            'MCP_SOURCES must be a JSON list of {name, kind, default?, restricted?}',
        ]);
        expect(problemsOf({ ...VALID_ENV, MCP_SOURCES: '[{"name":"x","kind":"graphite"}]' })[0]).toMatch(
            /^MCP_SOURCES\[0\]\.kind must be one of /,
        );
    });

    it('never echoes a value from env, even a malformed one', () => {
        const env = {
            MCP_PUBLIC_URL: 'leak-public-url',
            OKTA_ISSUER: 'leak-issuer',
            OKTA_JWKS_URI: 'https://user:leak-jwks-password@okta.example.test/keys',
            ENGINE_PG_PORT: 'leak-port',
            LIGHTDASH_PROJECT_UUID: 'leak-uuid',
            MCP_SOURCES: '[{"name":"leak-name","kind":"leak-kind"}]',
            LOG_LEVEL: 'leak-level',
            LIGHTDASH_API_TOKEN: 'leak-token',
            ENGINE_PG_PASSWORD: 'leak-password',
            HRX_IDENTITY_SECRET: 'leak-secret',
        };
        let message = '';
        try {
            loadConfig(env);
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain('OKTA_JWKS_URI must not contain credentials');
        expect(message).not.toContain('leak');
    });
});
