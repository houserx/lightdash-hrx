// demo-fake-prometheus. PROTECTED. Exercised through the Federation Engine's promql() table function.
import { expect, test } from '@playwright/test';
import { iso, readStack, sqlString, withEngine } from './helpers/stack';
import { inWindow, shiftScenarioIntoPast } from './helpers/scenarioWindows';

test('demo-fake-prometheus: hrx_fill_queue_backlog follows the scenario (baseline <= 60, incident >= 120, recovered <= 60) and is deterministic', async () => {
    const stack = readStack();
    const w = await shiftScenarioIntoPast(stack);
    const sql = `select timestamp, value, labels, series from promql('hrx_fill_queue_backlog', ${sqlString(iso(w.from))}, ${sqlString(iso(w.to))}, '15s')`;

    const [a, b] = await withEngine(stack, async (c) => [(await c.query(sql)).rows, (await c.query(sql)).rows]);
    expect(a.length).toBeGreaterThan(20);
    expect(JSON.stringify(a), 'the same query returns the same rows').toBe(JSON.stringify(b));

    const labels = a.map((r) => (typeof r.labels === 'string' ? JSON.parse(r.labels) : r.labels));
    expect(labels.some((l) => l.queue === 'fill'), 'a series with queue="fill"').toBe(true);

    const fill = a.filter((_, i) => labels[i].queue === 'fill');
    const values = (win: [Date, Date]) => fill.filter((r) => inWindow(r.timestamp, win)).map((r) => Number(r.value));

    const base = values(w.baseline);
    const inc = values(w.incident);
    const rec = values(w.recovered);
    expect(base.length).toBeGreaterThan(5);
    expect(inc.length).toBeGreaterThan(5);
    expect(rec.length).toBeGreaterThan(0);
    for (const v of base) expect(v).toBeLessThanOrEqual(60);
    for (const v of inc) expect(v).toBeGreaterThanOrEqual(120);
    for (const v of rec) expect(v).toBeLessThanOrEqual(60);
    expect(new Set(base).size, 'baseline values move').toBeGreaterThan(1);

    // instant query at "now" agrees with the timeline (recovered)
    const now = await withEngine(stack, (c) =>
        c.query(`select value, labels from promql_instant('hrx_fill_queue_backlog{queue="fill"}', ${sqlString(iso(w.to))})`),
    );
    expect(now.rows.length).toBeGreaterThan(0);
    for (const r of now.rows) expect(Number(r.value)).toBeLessThanOrEqual(60);
});
