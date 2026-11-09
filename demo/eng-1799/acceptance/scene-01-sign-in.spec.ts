// demo-scene-01-sign-in. PROTECTED.
import { expect, test } from '@playwright/test';
import { browserLogin, expectSceneArtifacts, expectSceneSpecAsserts, hasRedMark, lightdashApi, NAMES, openDashboard, readStack, restartScenario, runWalkthrough } from './helpers/stack';

test.describe.configure({ timeout: 300_000 });

test('demo-scene-01-sign-in: sign in, open Pharmacy Ops, change the Dashboard Time Range, turn auto-refresh on (recorded)', async ({ page }) => {
    const stack = readStack();
    await restartScenario(stack, 600, 900);
    expectSceneSpecAsserts('01-sign-in');
    runWalkthrough(['01-sign-in']);
    expectSceneArtifacts('01-sign-in', 8);

    // still the baseline: the stat is not red
    const ctx = await lightdashApi(stack);
    await browserLogin(page, stack);
    await openDashboard(page, stack, ctx, NAMES.pharmacyOps);
    await page.waitForTimeout(3_000);
    expect(await hasRedMark(page, /Current fill queue backlog/i)).toBe(false);
});
