import { describe, expect, it } from 'vitest';
import { AVOID_TERMS, exists, read } from './helpers/files';

const ENV_VARS = [
    'MCP_PUBLIC_URL',
    'MCP_HOST',
    'MCP_PORT',
    'OKTA_ISSUER',
    'OKTA_AUDIENCE',
    'OKTA_JWKS_URI',
    'LIGHTDASH_URL',
    'LIGHTDASH_API_TOKEN',
    'LIGHTDASH_PROJECT_UUID',
    'ENGINE_PG_HOST',
    'ENGINE_PG_PORT',
    'ENGINE_PG_USER',
    'ENGINE_PG_PASSWORD',
    'ENGINE_PG_DATABASE',
    'ENGINE_HTTP_URL',
    'HRX_IDENTITY_SECRET',
    'MCP_SOURCES',
    'MCP_PLATFORM_SOURCE',
    'MCP_STATEMENT_TIMEOUT_MS',
    'MCP_MAX_ROWS',
    'MCP_MAX_OUTPUT_BYTES',
    'MCP_USER_CACHE_TTL_MS',
    'ANTHROPIC_API_KEY',
];
const TOOLS = [
    'list_sources',
    'query_promql',
    'query_logql',
    'query_cloudwatch',
    'query_cloudwatch_logs',
    'search_traces',
    'get_trace',
    'alert_state',
    'alert_history',
    'platform_schema',
    'platform_query',
    'platform_explain',
    'ask_data',
    'write_preview',
];

describe('package README', () => {
    it('exists', () => {
        expect(exists('README.md')).toBe(true);
    });

    it('documents every env var, every tool, and how to build and test', () => {
        const md = read('README.md');
        for (const v of ENV_VARS) expect(md, v).toContain(v);
        for (const t of TOOLS) expect(md, t).toContain(t);
        expect(md).toContain('pnpm -F @lightdash/telemetry-mcp');
        expect(md).toContain('docs/eng-1799/telemetry-mcp.md');
    });

    it('uses the glossary, not its avoided terms', () => {
        const md = read('README.md').toLowerCase();
        for (const t of AVOID_TERMS) expect(md, t).not.toContain(t);
    });
});
