// demo-fake-tempo. PROTECTED. Exercised through the Federation Engine's traceql()/trace() table functions.
import { expect, test } from '@playwright/test';
import { iso, readStack, sqlString, withEngine } from './helpers/stack';
import { inWindow, minutes, shiftScenarioIntoPast } from './helpers/scenarioWindows';

test('demo-fake-tempo: fill-service traces show a slow shipping-label-api call only during the incident', async () => {
    const stack = readStack();
    const w = await shiftScenarioIntoPast(stack);
    const search = (q: string, win: [Date, Date]) =>
        withEngine(stack, async (c) =>
            (await c.query(`select trace_id, root_service, root_name, start, duration_ms, span_count from traceql(${sqlString(q)}, ${sqlString(iso(win[0]))}, ${sqlString(iso(win[1]))}, 500)`)).rows,
        );

    const all = await search('{ resource.service.name = "fill-service" }', [w.from, w.to]);
    for (const t of all) expect(t.root_service).toBe('fill-service');
    expect(all.filter((t) => inWindow(t.start, w.baseline)).length / minutes(w.baseline), 'traces per minute').toBeGreaterThanOrEqual(2);

    const slow = await search('{ resource.service.name = "fill-service" && duration > 2s }', [w.from, w.to]);
    for (const t of slow) expect(Number(t.duration_ms)).toBeGreaterThan(2000);
    expect(slow.filter((t) => inWindow(t.start, w.incident)).length / minutes(w.incident), 'slow traces per minute in the incident').toBeGreaterThanOrEqual(1);
    expect(slow.filter((t) => inWindow(t.start, w.baseline) || inWindow(t.start, w.recovered)), 'no slow traces outside the incident').toEqual([]);

    const spansOf = (id: string) =>
        withEngine(stack, async (c) =>
            (await c.query(`select trace_id, span_id, parent_span_id, service, name, start, duration_ms, status, attributes from trace(${sqlString(id)})`)).rows,
        );
    const slowSpans = await spansOf(slow.find((t) => inWindow(t.start, w.incident))!.trace_id);
    expect(slowSpans.length).toBeGreaterThanOrEqual(3);
    const downstream = slowSpans.find((s) => s.service === 'shipping-label-api');
    expect(downstream, 'a shipping-label-api span').toBeTruthy();
    expect(Number(downstream!.duration_ms)).toBeGreaterThanOrEqual(2000);
    expect(slowSpans.some((s) => s.span_id === downstream!.parent_span_id), 'the slow span has its parent in the trace').toBe(true);

    const fast = all.find((t) => inWindow(t.start, w.baseline))!;
    const fastDownstream = (await spansOf(fast.trace_id)).find((s) => s.service === 'shipping-label-api');
    expect(fastDownstream).toBeTruthy();
    expect(Number(fastDownstream!.duration_ms)).toBeLessThan(500);
});
