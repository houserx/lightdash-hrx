// Scene 1: sign in, open Pharmacy Ops overview, change the Dashboard Time Range and turn auto-refresh on.
//
// Two controls sit next to the Dashboard Time Range in the header:
//   - "Refresh" (a select): how often the Dashboard Time Range's relative bounds move forward (seeded at 30s);
//   - "Auto-refresh options" (a menu, "Auto-refresh while viewing"): re-runs every Tile on an interval (Off by default).
// The scene picks "Last 1 hour", sets Refresh to 10s and turns auto-refresh on at 5m.
// Key moment: the dashboard re-rendered over the last hour with both refresh settings visible in the header.
import { beat, expect, openDashboardFromList, QUERY_ERROR_TEXT, signIn, test, tile } from './lib/scene';

const DASHBOARD = 'Pharmacy Ops overview';

test('01-sign-in: sign in, open Pharmacy Ops overview, pick another Dashboard Time Range and turn auto-refresh on', async ({
    page,
    scene,
    stack,
}) => {
    await signIn(page, stack);
    await expect(page.getByRole('button', { name: /Operations Project/ }).first(), 'signed in to the Operations Project').toBeVisible();
    await beat(page);

    await openDashboardFromList(page, stack, DASHBOARD);
    await expect(page.getByText(DASHBOARD, { exact: true }).first()).toBeVisible();
    const stat = tile(page, 'Current fill queue backlog');
    await expect(stat, 'the stat Tile shows a number').toContainText(/\d/);
    await expect(tile(page, 'Fill queue backlog').locator('canvas, svg').first(), 'the time series Tile renders').toBeVisible();
    await expect(page.getByText(QUERY_ERROR_TEXT)).toHaveCount(0);
    // the header control that opens the Dashboard Time Range picker (the picker's presets are buttons too)
    const rangeButton = page.locator('button[aria-haspopup="dialog"]').filter({ hasText: /^Last \d+ (minutes?|hours?|days?)$/ });
    await expect(rangeButton, 'the Dashboard Time Range starts at the seeded 30 minutes').toHaveText('Last 30 minutes');
    await beat(page);

    // Dashboard Time Range: last 30 minutes -> last 1 hour
    await rangeButton.click();
    const lastHour = page.getByText('Last 1 hour', { exact: true });
    await expect(lastHour).toBeVisible();
    await beat(page, 800);
    await lastHour.click();
    await expect(rangeButton).toHaveText('Last 1 hour');
    await expect(page, 'the range is in the URL').toHaveURL(/[?&]from=now-1h(&|$)/);
    await expect(stat).toContainText(/\d/);
    await beat(page);

    // the Dashboard Time Range's Refresh: 30s -> 10s
    const refresh = page.getByRole('combobox', { name: 'Refresh' });
    await expect(refresh).toHaveValue('30s');
    await refresh.selectOption('10s');
    await expect(refresh).toHaveValue('10s');
    await expect(page).toHaveURL(/[?&]refresh=10s(&|$)/);
    await beat(page);

    // Auto-refresh while viewing: Off -> every 5 minutes
    await page.getByRole('button', { name: 'Auto-refresh options' }).click();
    const menu = page.getByRole('menu').filter({ hasText: 'Auto-refresh while viewing' });
    await expect(menu).toBeVisible();
    await beat(page, 800);
    await menu.getByRole('menuitem', { name: '5m', exact: true }).click();
    await expect(menu).toBeHidden();
    await page.getByRole('button', { name: 'Auto-refresh options' }).click();
    await expect(menu.getByRole('menuitem', { name: '5m', exact: true }), 'auto-refresh is on at 5m').toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: 'Off', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // the Tiles are back after the changes, without errors
    await expect(stat).toContainText(/\d/);
    await expect(page.getByText(QUERY_ERROR_TEXT)).toHaveCount(0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await beat(page, 1_500);
    await scene.keyMoment(page);
    await beat(page);
});
