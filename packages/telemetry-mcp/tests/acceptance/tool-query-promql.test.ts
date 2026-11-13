import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queriesMatching, startHarness, TS_SERIES_COLUMNS, type Harness } from './helpers/harness';

const START = '2026-11-08T10:00:00Z';
const END = '2026-11-08T11:00:00Z';
const PROMQL = 'sum by (job) (rate(http_requests_total{job="api",code=~"5.."}[5m]))';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    const rows = [
        ['2026-11-08T10:00:00Z', 1.5, { job: 'api' }, '{job="api"}'],
        ['2026-11-08T10:01:00Z', 2.25, { job: 'api' }, '{job="api"}'],
    ];
    h.engine.on(/\bpromql\s*\(/i, { columns: TS_SERIES_COLUMNS, rows });
    h.engine.on(/\bpromql_instant\s*\(/i, { columns: TS_SERIES_COLUMNS, rows: rows.slice(0, 1) });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const sameInstant = (p: string | null, iso: string) => p !== null && Date.parse(p) === Date.parse(iso);
const parseLabels = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

describe('query_promql', () => {
    it('runs promql(query, start, end, step) with every user value as a bind parameter', async () => {
        const r = await h.call('query_promql', { query: PROMQL, start: START, end: END, step: '1m' });
        expect(r.isError, r.text).toBe(false);
        const q = queriesMatching(h.engine, /\bpromql\s*\(/i).at(-1)!;
        expect(q.protocol).toBe('extended');
        expect(q.sql).not.toContain('http_requests_total');
        expect(q.params).toContain(PROMQL);
        expect(q.params).toContain('1m');
        expect(q.params.some((p) => sameInstant(p, START))).toBe(true);
        expect(q.params.some((p) => sameInstant(p, END))).toBe(true);
    });

    it('returns the Time series long shape: columns, rows, rowCount, truncated', async () => {
        const r = await h.call('query_promql', { query: PROMQL, start: START, end: END, step: '1m' });
        expect(r.structured.columns).toEqual(['timestamp', 'value', 'labels', 'series']);
        expect(r.structured.rowCount).toBe(2);
        expect(r.structured.truncated).toBe(false);
        expect(r.structured.rows).toHaveLength(2);
        expect(r.structured.rows[1].value).toBe(2.25);
        expect(parseLabels(r.structured.rows[0].labels)).toEqual({ job: 'api' });
        expect(Date.parse(r.structured.rows[0].timestamp)).toBe(Date.parse('2026-11-08T10:00:00Z'));
        expect(r.structured.rows[0].series).toBe('{job="api"}');
    });

    it('passes an explicit source as a parameter', async () => {
        const r = await h.call('query_promql', {
            query: 'up',
            start: START,
            end: END,
            step: '30s',
            source: 'prometheus-production',
        });
        expect(r.isError, r.text).toBe(false);
        expect(queriesMatching(h.engine, /\bpromql\s*\(/i).at(-1)!.params).toContain('prometheus-production');
    });

    it('runs promql_instant(query, at) when given `at` instead of a range', async () => {
        const r = await h.call('query_promql', { query: 'up', at: END });
        expect(r.isError, r.text).toBe(false);
        const q = queriesMatching(h.engine, /\bpromql_instant\s*\(/i).at(-1)!;
        expect(q.params).toContain('up');
        expect(q.params.some((p) => sameInstant(p, END))).toBe(true);
        expect(r.structured.rowCount).toBe(1);
    });

    it('rejects a step that is not a Prometheus duration, without querying', async () => {
        const before = h.engine.dataQueries().length;
        for (const step of ['abc', '5 minutes', '1m; DROP']) {
            const r = await h.call('query_promql', { query: 'up', start: START, end: END, step });
            expect(r.isError).toBe(true);
        }
        expect(h.engine.dataQueries().length).toBe(before);
    });
});
