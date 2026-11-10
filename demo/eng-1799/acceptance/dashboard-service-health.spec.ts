// demo-dashboard-service-health. PROTECTED.
import { expect, test } from '@playwright/test';
import { browserLogin, dashboardTiles, findDashboard, lightdashApi, NAMES, openDashboard, readStack, restartScenario } from './helpers/stack';

test.describe.configure({ timeout: 240_000 });

test('demo-dashboard-service-health: Service health shows a log stream, a trace waterfall and a heatmap or state timeline', async ({ page }) => {
    const stack = readStack();
    const ctx = await lightdashApi(stack);
    await restartScenario(stack, -180, 900);

    const dashboard = await findDashboard(ctx, stack.lightdash.projectUuid, NAMES.serviceHealth);
    const tiles = await dashboardTiles(ctx, stack.lightdash.projectUuid, dashboard);
    expect(tiles.some((t) => /"type"\s*:\s*"log_stream"/.test(t.json)), 'a log_stream Tile').toBe(true);
    expect(tiles.some((t) => /"type"\s*:\s*"trace_waterfall"/.test(t.json)), 'a trace_waterfall Tile').toBe(true);
    expect(tiles.some((t) => /heatmap|state.?timeline/i.test(t.title)), 'a heatmap or state timeline Tile').toBe(true);

    await browserLogin(page, stack);
    await openDashboard(page, stack, ctx, NAMES.serviceHealth);
    await expect(page.locator('[data-testid="log-stream-row"]').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="log-stream-row"][data-level="error"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="trace-span-row"]').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="trace-span-row"]').filter({ hasText: 'shipping-label-api' }).first()).toBeVisible();
});
