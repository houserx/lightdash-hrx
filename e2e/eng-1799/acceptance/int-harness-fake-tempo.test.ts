/* eslint-disable */
// @ts-nocheck
// int-harness-fake-tempo: a fake Tempo serves fixed synthetic traces; the real engine's traceql()
// and trace() read them.
import { syntheticTrace, TRACE_ID } from './fixtures';
import { disposeAll, harness, iso, pgRun, T0, track, windowSql } from './support';

afterAll(disposeAll);

describe('int-harness-fake-tempo', () => {
    it('traceql() lists the trace and trace() returns its spans', async () => {
        const h = await harness();
        const tempo = track(await h.startFakeTempo({ traces: [syntheticTrace] }));
        const engine = track(await h.startEngine({ tempo }));

        const search = await pgRun(engine, [
            `SELECT trace_id, root_service, root_name, start, duration_ms, span_count FROM traceql('{ resource.service.name = "refills-api" }', ${windowSql(5)})`,
        ]);
        expect(search.error).toBeUndefined();
        expect(search.rows).toHaveLength(1);
        expect(search.rows[0]).toMatchObject({ trace_id: TRACE_ID, root_service: 'refills-api', root_name: 'POST /refills', duration_ms: 120 });
        expect(Number(search.rows[0].span_count)).toBe(2);
        expect(new Date(search.rows[0].start).toISOString()).toBe(iso(T0 + 1_000));

        const spans = await pgRun(engine, [`SELECT span_id, parent_span_id, service, name, duration_ms, status, attributes FROM trace('${TRACE_ID}') ORDER BY start`]);
        expect(spans.error).toBeUndefined();
        expect(spans.rows.map((r) => [r.span_id, r.parent_span_id ?? null, r.service, r.status])).toEqual([
            ['b7ad6b7169203331', null, 'refills-api', 'ok'],
            ['00f067aa0ba902b7', 'b7ad6b7169203331', 'pharmacy-db', 'error'],
        ]);
        expect(spans.rows[0].attributes['http.status_code']).toBe(201);

        const unknown = await pgRun(engine, [`SELECT * FROM trace('ffffffffffffffffffffffffffffffff')`]);
        expect(unknown.error).toBeUndefined();
        expect(unknown.rows).toHaveLength(0);
    });
});
