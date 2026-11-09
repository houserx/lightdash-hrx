// demo-dashboard-platform-db. PROTECTED.
import { expect, test } from '@playwright/test';
import { browserLogin, dashboardTiles, findDashboard, lightdashApi, NAMES, openDashboard, readStack } from './helpers/stack';

test.describe.configure({ timeout: 180_000 });

test('demo-dashboard-platform-db: Platform DB has SQL chart Tiles over the synthetic pharmacy schema that render without errors', async ({ page }) => {
    const stack = readStack();
    const ctx = await lightdashApi(stack);
    const dashboard = await findDashboard(ctx, stack.lightdash.projectUuid, NAMES.platformDb);
    const tiles = await dashboardTiles(ctx, stack.lightdash.projectUuid, dashboard);
    const sqlTiles = tiles.filter((t) => t.type === 'sql_chart');
    expect(sqlTiles.length, 'at least two SQL chart Tiles').toBeGreaterThanOrEqual(2);
    for (const t of sqlTiles) expect(t.json).toMatch(/platform_query/);
    expect(sqlTiles.map((t) => t.json).join(' ')).toMatch(/orders|fills|shipments|queues/);

    await browserLogin(page, stack);
    const errors: string[] = [];
    page.on('response', (r) => {
        if (r.url().includes('/api/') && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
    });
    await openDashboard(page, stack, ctx, NAMES.platformDb);
    for (const t of sqlTiles) await expect(page.getByText(t.title).first()).toBeVisible();
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
    await expect(page.getByText(/audited query requires a description|permission denied|42501|error running query/i)).toHaveCount(0);
    expect(errors).toEqual([]);
});
