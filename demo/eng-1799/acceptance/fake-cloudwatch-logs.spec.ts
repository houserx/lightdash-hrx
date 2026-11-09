// demo-fake-cloudwatch-logs. PROTECTED. Exercised through the Federation Engine's cloudwatch_logs() table function.
import { expect, test } from '@playwright/test';
import { iso, readStack, sqlString, withEngine } from './helpers/stack';
import { inWindow, minutes, shiftScenarioIntoPast } from './helpers/scenarioWindows';

test('demo-fake-cloudwatch-logs: Logs Insights over /hrx/demo/fill-service shows the ERROR spike', async () => {
    const stack = readStack();
    const w = await shiftScenarioIntoPast(stack);
    const q = 'fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 2000';
    const rows = await withEngine(stack, async (c) =>
        (await c.query(`select timestamp, message, fields from cloudwatch_logs('/hrx/demo/fill-service', ${sqlString(q)}, ${sqlString(iso(w.from))}, ${sqlString(iso(w.to))})`)).rows,
    );
    for (const r of rows) expect(r.message).toContain('ERROR');
    const perMin = (win: [Date, Date]) => rows.filter((r) => inWindow(r.timestamp, win)).length / minutes(win);
    expect(perMin(w.incident)).toBeGreaterThanOrEqual(10);
    expect(perMin(w.baseline)).toBeLessThanOrEqual(2);

    const everything = await withEngine(stack, async (c) =>
        (await c.query(`select message from cloudwatch_logs('/hrx/demo/fill-service', 'fields @timestamp, @message | limit 2000', ${sqlString(iso(w.baseline[0]))}, ${sqlString(iso(w.baseline[1]))})`)).rows,
    );
    expect(everything.length, 'non-error lines exist too').toBeGreaterThan(rows.filter((r) => inWindow(r.timestamp, w.baseline)).length);
});
