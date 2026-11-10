// demo-lightdash-engine-query. PROTECTED.
import { expect, test } from '@playwright/test';
import { iso, lightdashApi, lightdashSql, readStack, sqlString } from './helpers/stack';
import { inWindow, shiftScenarioIntoPast } from './helpers/scenarioWindows';

test('demo-lightdash-engine-query: SQL on the Operations Project runs through Lightdash on the Federation Engine against the fake sources', async () => {
    const stack = readStack();
    const ctx = await lightdashApi(stack);
    const w = await shiftScenarioIntoPast(stack);

    const rows = await lightdashSql(
        ctx,
        stack.lightdash.projectUuid,
        `select timestamp, value from promql('hrx_fill_queue_backlog{queue="fill"}', ${sqlString(iso(w.from))}, ${sqlString(iso(w.to))}, '15s')`,
    );
    expect(rows.length).toBeGreaterThan(10);
    const inc = rows.filter((r) => inWindow(String(r.timestamp), w.incident)).map((r) => Number(r.value));
    expect(inc.length).toBeGreaterThan(0);
    for (const v of inc) expect(v).toBeGreaterThanOrEqual(120);

    const logs = await lightdashSql(
        ctx,
        stack.lightdash.projectUuid,
        `select count(*) as n from logql('{app="fill-service"} |= "level=error"', ${sqlString(iso(w.incident[0]))}, ${sqlString(iso(w.incident[1]))}, 5000)`,
    );
    expect(Number(logs[0].n)).toBeGreaterThan(10);
});
