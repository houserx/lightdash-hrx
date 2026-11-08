import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SECRET, startHarness, TS_SERIES_COLUMNS, type Harness } from './helpers/harness';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    const by = (needle: string) => (q: { params: (string | null)[] }) => q.params.includes(needle);
    h.engine.on(by('deny_me'), {
        error: { code: '42501', message: 'permission denied: missing claim attrs.telemetry_restricted' },
    });
    h.engine.on(by('too_big'), { error: { code: '54000', message: 'result exceeds max_rows' } });
    h.engine.on(by('audit_fail'), { error: { code: '58000', message: 'audit write failed' } });
    h.engine.on(by('weird_fail'), { error: { code: 'XX000', message: 'internal engine failure' } });
    h.engine.on(by('fine'), { columns: TS_SERIES_COLUMNS, rows: [] });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const call = (query: string) =>
    h.call('query_promql', { query, start: '2026-11-08T10:00:00Z', end: '2026-11-08T11:00:00Z', step: '1m' });

describe('engine SQLSTATEs become clear tool errors', () => {
    it('42501 -> access denied, naming the missing claim', async () => {
        const r = await call('deny_me');
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/access denied|permission/i);
        expect(r.text).toContain('telemetry_restricted');
    });

    it('54000 -> result too large, with advice to narrow the query', async () => {
        const r = await call('too_big');
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/too large|max_rows/i);
        expect(r.text).toMatch(/narrow|shorter|smaller|reduce/i);
    });

    it('58000 -> audit write failed, result withheld', async () => {
        const r = await call('audit_fail');
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/audit/i);
        expect(r.structured?.rows ?? []).toEqual([]);
    });

    it('any other engine error is still an error result, not a crash', async () => {
        const r = await call('weird_fail');
        expect(r.isError).toBe(true);
        // The server keeps working afterwards.
        const ok = await call('fine');
        expect(ok.isError, ok.text).toBe(false);
    });

    it('error text never leaks the identity secret, an identity token or the engine password', async () => {
        const r = await call('deny_me');
        expect(r.text).not.toContain(IDENTITY_SECRET);
        expect(r.text).not.toContain('test-pg-password-not-real');
        expect(r.text).not.toMatch(/eyJ[\w-]{20,}\.[\w-]{20,}/);
    });
});
