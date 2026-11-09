// demo-fake-loki. PROTECTED. Exercised through the Federation Engine's logql()/logql_metric() table functions.
import { expect, test } from '@playwright/test';
import { iso, readStack, sqlString, withEngine } from './helpers/stack';
import { inWindow, minutes, shiftScenarioIntoPast } from './helpers/scenarioWindows';

const ERRORS = '{app="fill-service"} |= "level=error"';

test('demo-fake-loki: fill-service error logs spike in the incident and mention the slow downstream call', async () => {
    const stack = readStack();
    const w = await shiftScenarioIntoPast(stack);

    const lines = await withEngine(stack, async (c) =>
        (await c.query(`select timestamp, line, labels, stream from logql(${sqlString(ERRORS)}, ${sqlString(iso(w.from))}, ${sqlString(iso(w.to))}, 5000, 'forward')`)).rows,
    );
    for (const l of lines) expect(l.line).toContain('level=error');
    const count = (win: [Date, Date]) => lines.filter((l) => inWindow(l.timestamp, win)).length;
    expect(count(w.incident) / minutes(w.incident), 'incident error lines per minute').toBeGreaterThanOrEqual(10);
    expect(count(w.baseline) / minutes(w.baseline), 'baseline error lines per minute').toBeLessThanOrEqual(2);
    expect(lines.filter((l) => inWindow(l.timestamp, w.incident)).some((l) => /shipping-label-api/.test(l.line))).toBe(true);

    // ordinary (non-error) lines exist too
    const all = await withEngine(stack, async (c) =>
        (await c.query(`select line from logql('{app="fill-service"}', ${sqlString(iso(w.baseline[0]))}, ${sqlString(iso(w.baseline[1]))}, 5000)`)).rows,
    );
    expect(all.length).toBeGreaterThan(count(w.baseline));

    // the metric form agrees
    const metric = await withEngine(stack, async (c) =>
        (await c.query(`select timestamp, value from logql_metric(${sqlString(`sum(count_over_time(${ERRORS} [1m]))`)}, ${sqlString(iso(w.from))}, ${sqlString(iso(w.to))}, '30s')`)).rows,
    );
    const mv = (win: [Date, Date], pad: number) =>
        metric.filter((r) => inWindow(r.timestamp, [new Date(win[0].getTime() + pad), win[1]])).map((r) => Number(r.value));
    expect(mv(w.incident, 60_000).length).toBeGreaterThan(0);
    for (const v of mv(w.incident, 60_000)) expect(v).toBeGreaterThanOrEqual(10);
    for (const v of mv(w.baseline, 60_000)) expect(v).toBeLessThanOrEqual(2);
});
