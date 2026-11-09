// demo-fake-cloudwatch-metrics. PROTECTED. Exercised through the Federation Engine's cloudwatch() table function.
import { expect, test } from '@playwright/test';
import { iso, readStack, sqlString, withEngine } from './helpers/stack';
import { inWindow, shiftScenarioIntoPast } from './helpers/scenarioWindows';

const QUERY = JSON.stringify({
    id: 'q1',
    refId: 'A',
    region: 'default',
    namespace: 'AWS/SQS',
    metricName: 'ApproximateNumberOfMessagesVisible',
    dimensions: { QueueName: 'hrx-demo-fill-queue' },
    statistic: 'Maximum',
    period: '60',
});

test('demo-fake-cloudwatch-metrics: the SQS fill queue depth follows the scenario through CloudWatch GetMetricData', async () => {
    const stack = readStack();
    const w = await shiftScenarioIntoPast(stack);
    const rows = await withEngine(stack, async (c) =>
        (await c.query(`select timestamp, value, labels, series from cloudwatch(${sqlString(QUERY)}, ${sqlString(iso(w.from))}, ${sqlString(iso(w.to))})`)).rows,
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    // a one-minute bucket counts for a window when the whole minute lies inside it
    const full = (win: [Date, Date]) =>
        rows.filter((r) => inWindow(r.timestamp, win) && inWindow(new Date(new Date(r.timestamp).getTime() + 59_000), win)).map((r) => Number(r.value));
    expect(full(w.incident).length).toBeGreaterThan(0);
    expect(full(w.baseline).length).toBeGreaterThan(0);
    for (const v of full(w.incident)) expect(v).toBeGreaterThanOrEqual(120);
    for (const v of full(w.baseline)) expect(v).toBeLessThanOrEqual(60);
});
