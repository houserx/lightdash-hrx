import { describe, expect, it } from 'vitest';
import { exists, read } from './helpers/files';

// The Dockerfile is written, never built, by this line.
describe('Dockerfile', () => {
    it('exists in the package', () => {
        expect(exists('Dockerfile')).toBe(true);
    });

    it('builds from a pinned Node 24 image with a frozen pnpm install and runs dist/main.js as non-root', () => {
        const df = read('Dockerfile');
        const froms = [...df.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]!);
        expect(froms.length).toBeGreaterThan(0);
        for (const image of froms) {
            expect(image).toMatch(/^node:24/);
            expect(image).not.toMatch(/:latest$/);
        }
        expect(df).toMatch(/pnpm[^\n]*install[^\n]*--frozen-lockfile/);
        expect(df).toMatch(/telemetry-mcp/);
        expect(df).toMatch(/^USER\s+(?!root\b)\S+/m);
        expect(df).toMatch(/^EXPOSE\s+\d+/m);
        expect(df).toMatch(/^(CMD|ENTRYPOINT)\b[^\n]*dist\/main\.js/m);
        expect(df).toMatch(/^HEALTHCHECK\b[^\n]*(\n[^\n]*)?healthz/m);
    });

    it('bakes in no secrets', () => {
        const df = read('Dockerfile');
        for (const name of ['HRX_IDENTITY_SECRET', 'LIGHTDASH_API_TOKEN', 'ENGINE_PG_PASSWORD', 'ANTHROPIC_API_KEY']) {
            expect(df).not.toMatch(new RegExp(`^(ENV|ARG)\\s+${name}\\b`, 'm'));
        }
    });
});
