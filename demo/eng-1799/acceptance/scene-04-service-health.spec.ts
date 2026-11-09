// demo-scene-04-service-health. PROTECTED.
import { test } from '@playwright/test';
import { expectSceneArtifacts, expectSceneSpecAsserts, readStack, restartScenario, runWalkthrough } from './helpers/stack';

test.describe.configure({ timeout: 300_000 });

test('demo-scene-04-service-health: the log stream filtered to errors, then the trace waterfall with the slow span opened (recorded)', async () => {
    const stack = readStack();
    await restartScenario(stack, -150, 900);
    expectSceneSpecAsserts('04-service-health', 4);
    runWalkthrough(['04-service-health']);
    expectSceneArtifacts('04-service-health', 8);
});
