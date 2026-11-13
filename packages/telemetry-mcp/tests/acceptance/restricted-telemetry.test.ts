import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANALYST, IDENTITY_SECRET, identityOf, startHarness, type Harness } from './helpers/harness';
import { verifyIdentityToken } from './helpers/identity';

let h: Harness;
beforeAll(async () => {
    // Even a user who holds telemetry_restricted in Lightdash must not read Restricted Telemetry via MCP.
    h = await startHarness({
        attributes: [
            { name: 'telemetry_restricted', users: [{ userUuid: ANALYST.userUuid, value: 'true' }] },
            { name: 'platform_read', users: [{ userUuid: ANALYST.userUuid, value: 'true' }] },
        ],
    });
    // The engine (§1.2) refuses restricted sources to agent identities.
    h.engine.on(
        (q) => /\blogql\s*\(/i.test(q.sql),
        (q) => {
            const id = verifyIdentityToken(identityOf(q), IDENTITY_SECRET);
            if (q.params.includes('loki-platform') && (id.agent || !id.attrs.telemetry_restricted)) {
                return {
                    error: {
                        code: '42501',
                        message: 'restricted telemetry requires attrs.telemetry_restricted and agent = false',
                    },
                };
            }
            return {
                columns: [
                    { name: 'timestamp', type: 'timestamptz' },
                    { name: 'line', type: 'text' },
                    { name: 'labels', type: 'json' },
                    { name: 'stream', type: 'text' },
                ],
                rows: [['2026-11-08T10:00:00Z', 'synthetic ordinary line', {}, '{}']],
            };
        },
    );
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('Restricted Telemetry is never readable through MCP', () => {
    it('marks restricted sources in list_sources', async () => {
        const r = await h.call('list_sources', {});
        expect(r.isError, r.text).toBe(false);
        const src = r.structured.sources.find((s: { name: string }) => s.name === 'loki-platform');
        expect(src.restricted).toBe(true);
    });

    it('fails a query against a restricted source with a clear error', async () => {
        const r = await h.call('query_logql', {
            query: '{namespace="platform"}',
            start: '2026-11-08T10:00:00Z',
            end: '2026-11-08T11:00:00Z',
            source: 'loki-platform',
        });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/restricted/i);
        expect(r.structured?.rows ?? []).toEqual([]);
    });

    it('always sends agent = true, whatever the user holds', async () => {
        const r = await h.call('query_logql', {
            query: '{app="api"}',
            start: '2026-11-08T10:00:00Z',
            end: '2026-11-08T11:00:00Z',
        });
        expect(r.isError, r.text).toBe(false);
        for (const q of h.engine.dataQueries().filter((x) => /\blogql\s*\(/i.test(x.sql))) {
            expect(verifyIdentityToken(identityOf(q), IDENTITY_SECRET).agent).toBe(true);
        }
    });
});
