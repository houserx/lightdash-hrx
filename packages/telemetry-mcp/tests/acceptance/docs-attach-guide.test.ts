import { describe, expect, it } from 'vitest';
import { AVOID_TERMS, exists, read, REPO_ROOT } from './helpers/files';

const DOC = 'docs/eng-1799/telemetry-mcp.md';

describe(`${DOC}: attaching the server and the auth flow`, () => {
    it('exists', () => {
        expect(exists(DOC, REPO_ROOT)).toBe(true);
    });

    it('explains attaching to a Lightdash agent and to Claude Code', () => {
        const md = read(DOC, REPO_ROOT);
        expect(md).toMatch(/^#+ .*Lightdash agent/im);
        expect(md).toMatch(/^#+ .*Claude Code/im);
        expect(md).toMatch(/claude mcp add[^\n]*--transport http/);
        expect(md).toContain('/mcp');
    });

    it('explains the auth flow end to end', () => {
        const md = read(DOC, REPO_ROOT);
        expect(md).toMatch(/^#+ .*Auth/im);
        for (const s of [
            'Okta',
            '/.well-known/oauth-protected-resource',
            'WWW-Authenticate',
            'JWKS',
            'aud',
            'user attribute',
            'hrx.identity',
            'telemetry-mcp',
            'agent',
            'Restricted Telemetry',
            'platform_read',
            'platform_write',
        ]) {
            expect(md, s).toContain(s);
        }
    });

    it('states that write_preview only previews and nothing can commit', () => {
        const md = read(DOC, REPO_ROOT);
        expect(md).toContain('write_preview');
        expect(md).toMatch(/Preview/);
        expect(md).toMatch(/never commit|cannot commit|no commit/i);
    });

    it('uses the glossary, not its avoided terms', () => {
        const md = read(DOC, REPO_ROOT).toLowerCase();
        for (const t of AVOID_TERMS) expect(md, t).not.toContain(t);
    });
});
