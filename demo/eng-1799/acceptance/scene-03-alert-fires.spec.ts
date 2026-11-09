// demo-scene-03-alert-fires. PROTECTED.
import { expect, test } from '@playwright/test';
import { expectSceneArtifacts, expectSceneSpecAsserts, incidentNotifications, NAMES, notificationsFor, readStack, restartScenario, runWalkthrough } from './helpers/stack';

test.describe.configure({ timeout: 300_000 });

test('demo-scene-03-alert-fires: the alert list shows the rule firing and the fake incident.io page shows the notification (recorded)', async () => {
    const stack = readStack();
    await restartScenario(stack, -60, 900);
    expectSceneSpecAsserts('03-alert-fires');
    runWalkthrough(['03-alert-fires']);
    expectSceneArtifacts('03-alert-fires', 5);
    expect(notificationsFor(await incidentNotifications(stack), NAMES.backlogRule, 'firing').length).toBeGreaterThan(0);
});
