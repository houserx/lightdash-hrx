import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queriesMatching, startHarness, TS_SERIES_COLUMNS, type Harness } from './helpers/harness';

const NOW = Math.floor(Date.now() / 1000) * 1000;
let h: Harness;
beforeAll(async () => {
    h = await startHarness({ now: () => NOW });
    h.engine.on(/\bpromql\s*\(/i, { columns: TS_SERIES_COLUMNS, rows: [] });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('time arguments: ISO-8601 or relative to now', () => {
    it('resolves now and now-<duration> against the server clock into absolute timestamps', async () => {
        const r = await h.call('query_promql', { query: 'up', start: 'now-1h', end: 'now', step: '1m' });
        expect(r.isError, r.text).toBe(false);
        const q = queriesMatching(h.engine, /\bpromql\s*\(/i).at(-1)!;
        const instants = q.params.map((p) => (p === null ? NaN : Date.parse(p)));
        expect(instants).toContain(NOW - 3_600_000);
        expect(instants).toContain(NOW);
    });

    it('accepts d and m units', async () => {
        const r = await h.call('query_promql', { query: 'up', start: 'now-2d', end: 'now-30m', step: '5m' });
        expect(r.isError, r.text).toBe(false);
        const q = queriesMatching(h.engine, /\bpromql\s*\(/i).at(-1)!;
        const instants = q.params.map((p) => (p === null ? NaN : Date.parse(p)));
        expect(instants).toContain(NOW - 2 * 86_400_000);
        expect(instants).toContain(NOW - 30 * 60_000);
    });

    it('rejects unparseable times and an end before the start, without querying', async () => {
        const before = h.engine.dataQueries().length;
        const bad = [
            { start: 'yesterday-ish', end: 'now' },
            { start: 'now', end: 'now-1h' },
            { start: '2026-13-45T99:00:00Z', end: 'now' },
        ];
        for (const b of bad) {
            const r = await h.call('query_promql', { query: 'up', step: '1m', ...b });
            expect(r.isError).toBe(true);
        }
        expect(h.engine.dataQueries().length).toBe(before);
    });
});
