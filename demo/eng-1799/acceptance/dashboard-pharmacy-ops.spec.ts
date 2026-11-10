// demo-dashboard-pharmacy-ops (content) and demo-dashboard-pharmacy-ops-ui (rendering). PROTECTED.
// Checks: run.sh --stack dashboard-pharmacy-ops.spec.ts --grep "demo-dashboard-pharmacy-ops:" | --grep "demo-dashboard-pharmacy-ops-ui:"
import { expect, test } from '@playwright/test';
import {
    browserLogin,
    dashboardTiles,
    findDashboard,
    hasRedMark,
    lightdashApi,
    NAMES,
    openDashboard,
    readStack,
    restartScenario,
    tileByTitle,
} from './helpers/stack';

test.describe.configure({ timeout: 240_000 });

test('demo-dashboard-pharmacy-ops: Pharmacy Ops overview has a time series with threshold lines, a stat, a bar gauge and value mappings', async () => {
    const stack = readStack();
    const ctx = await lightdashApi(stack);
    const dashboard = await findDashboard(ctx, stack.lightdash.projectUuid, NAMES.pharmacyOps);
    expect(dashboard.timeRange, 'the dashboard has a Dashboard Time Range').toBeTruthy();
    const tiles = await dashboardTiles(ctx, stack.lightdash.projectUuid, dashboard);
    expect(tiles.length).toBeGreaterThanOrEqual(4);

    const series = tileByTitle(tiles, /^Fill queue backlog$/i);
    expect(series, 'a "Fill queue backlog" time series Tile').toBeTruthy();
    expect(series!.json).toContain('hrx_fill_queue_backlog');
    expect(series!.json).toMatch(/"thresholds"/);
    expect(series!.json, `threshold step at ${NAMES.backlogThreshold}`).toMatch(new RegExp(`"value"\\s*:\\s*${NAMES.backlogThreshold}\\b`));

    const stat = tileByTitle(tiles, /^Current fill queue backlog$/i);
    expect(stat, 'a "Current fill queue backlog" stat Tile').toBeTruthy();
    expect(stat!.json).toContain('hrx_fill_queue_backlog');

    expect(tileByTitle(tiles, /by queue/i), 'a bar gauge Tile "... by queue"').toBeTruthy();
    expect(tiles.some((t) => /valueMappings/.test(t.json)), 'a Tile with value mappings').toBe(true);
});

test('demo-dashboard-pharmacy-ops-ui: the dashboard renders live; the stat turns red in the incident and not in the baseline', async ({ page }) => {
    const stack = readStack();
    const ctx = await lightdashApi(stack);
    await browserLogin(page, stack);

    await restartScenario(stack, 900, 1200); // baseline only
    await openDashboard(page, stack, ctx, NAMES.pharmacyOps);
    await expect(page.getByText(/Current fill queue backlog/i).first()).toBeVisible();
    await expect(page.getByText(/^Fill queue backlog$/i).first()).toBeVisible();
    // the Dashboard Time Range control and its Refresh select are in the header
    await expect(page.getByRole('button', { name: /last|minutes|hour/i }).first()).toBeVisible();
    await expect(page.getByText(/there was an error|error running query|unable to load|42501|42P01|audited query requires a description/i)).toHaveCount(0);
    await page.waitForTimeout(3_000);
    expect(await hasRedMark(page, /Current fill queue backlog/i), 'stat is not red in the baseline').toBe(false);

    await restartScenario(stack, -120, 900); // incident in progress
    // reload until the Tile shows the incident (cached results expire with the rounded Dashboard Time Range)
    let red = false;
    for (let i = 0; i < 8 && !red; i++) {
        await page.reload();
        await expect(page.getByText(/Current fill queue backlog/i).first()).toBeVisible({ timeout: 60_000 });
        await page.waitForTimeout(5_000);
        red = await hasRedMark(page, /Current fill queue backlog/i);
        if (!red) await page.waitForTimeout(5_000);
    }
    expect(red, 'stat turns red in the incident').toBe(true);
});
