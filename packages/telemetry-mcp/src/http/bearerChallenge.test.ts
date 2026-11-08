import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { bearerChallenge, extractBearer, resourceMetadataUrl } from './bearerChallenge.js';

const config = loadConfig({
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
});

describe('extractBearer', () => {
    it('treats no header and other schemes as missing credentials', () => {
        expect(extractBearer({})).toEqual({ kind: 'missing' });
        expect(extractBearer({ authorization: 'Basic dXNlcjpwYXNz' })).toEqual({ kind: 'missing' });
        expect(extractBearer({ authorization: '' })).toEqual({ kind: 'missing' });
    });

    it('flags empty and non-JWS bearer tokens as malformed', () => {
        for (const value of ['Bearer', 'Bearer ', 'Bearer not-a-jwt', 'Bearer a.b', 'Bearer a.b.c.d', 'Bearer a b.c.d']) {
            expect(extractBearer({ authorization: value })).toEqual({ kind: 'malformed' });
        }
    });

    it('returns a JWS-shaped token, scheme case-insensitive', () => {
        expect(extractBearer({ authorization: 'bearer aaa.bbb.ccc' })).toEqual({ kind: 'token', token: 'aaa.bbb.ccc' });
        expect(extractBearer({ authorization: 'Bearer  aaa.bbb.ccc ' })).toEqual({ kind: 'token', token: 'aaa.bbb.ccc' });
    });
});

describe('bearerChallenge', () => {
    it('points at the /mcp protected-resource metadata', () => {
        expect(resourceMetadataUrl(config)).toBe(
            'https://telemetry-mcp.example.test/.well-known/oauth-protected-resource/mcp',
        );
        expect(bearerChallenge(config)).toBe(
            'Bearer resource_metadata="https://telemetry-mcp.example.test/.well-known/oauth-protected-resource/mcp"',
        );
    });

    it('adds the error code and description', () => {
        expect(bearerChallenge(config, { error: 'invalid_token', description: 'The access token is malformed' })).toBe(
            'Bearer error="invalid_token", error_description="The access token is malformed", ' +
                'resource_metadata="https://telemetry-mcp.example.test/.well-known/oauth-protected-resource/mcp"',
        );
    });
});
