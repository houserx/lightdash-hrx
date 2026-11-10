// demo-scene-02-incident. PROTECTED.
import { expect, test } from '@playwright/test';
import { browserLogin, expectSceneArtifacts, expectSceneSpecAsserts, getScenario, hasRedMark, lightdashApi, NAMES, openDashboard, readStack, restartScenario, runWalkthrough } from './helpers/stack';

test.describe.configure({ timeout: 300_000 });

test('demo-scene-02-incident: the scene waits for the incident; the threshold is crossed and the stat turns red (recorded)', async ({ page }) => {
    const stack = readStack();
    const started = await restartScenario(stack, 20, 900);
    expectSceneSpecAsserts('02-incident');
    runWalkthrough(['02-incident']);
    expectSceneArtifacts('02-incident', 5);
    // the scene waited on the scenario clock rather than finishing in the baseline
    const now = await getScenario(stack);
    expect(now.phase).toBe('incident');
    expect(new Date(now.now).getTime() - new Date(started.incidentAt).getTime()).toBeGreaterThanOrEqual(0);

    const ctx = await lightdashApi(stack);
    await browserLogin(page, stack);
    await openDashboard(page, stack, ctx, NAMES.pharmacyOps);
    await expect.poll(() => hasRedMark(page, /Current fill queue backlog/i), { timeout: 60_000 }).toBe(true);
});
