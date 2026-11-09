// demo-scene-08-recovery. PROTECTED.
import { expect, test } from '@playwright/test';
import { expectSceneArtifacts, expectSceneSpecAsserts, incidentNotifications, NAMES, notificationsFor, readStack, restartScenario, runWalkthrough } from './helpers/stack';

test.describe.configure({ timeout: 330_000 });

test('demo-scene-08-recovery: the alert resolves and the resolve notification arrives (recorded)', async () => {
    const stack = readStack();
    await restartScenario(stack, -120, 35);
    expectSceneSpecAsserts('08-recovery');
    runWalkthrough(['08-recovery'], 300_000);
    expectSceneArtifacts('08-recovery', 5);
    expect(notificationsFor(await incidentNotifications(stack), NAMES.backlogRule, 'resolved').length).toBeGreaterThan(0);
});
