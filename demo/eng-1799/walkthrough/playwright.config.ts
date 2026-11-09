// ENG-1799 demo: Playwright config for the recorded walkthrough. Run through walkthrough/run.sh, which runs one
// scene spec (`<scene-id>.spec.ts`) per Playwright process. Recording and the key-moment screenshot are handled by
// the `scene` fixture in lib/scene.ts, which writes out/scenes/<scene-id>/video.webm and key-moment.png.
import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
    testDir: '.',
    testMatch: /(^|\/)\d\d-[a-z0-9-]+\.spec\.ts$/,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: true,
    // Scenes that wait on the scenario clock set their own, longer timeouts.
    timeout: 180_000,
    expect: { timeout: 30_000 },
    reporter: [['list']],
    // Playwright's own scratch output stays out of the deliverables (out/) and out of .state/ (down.sh reaps
    // every process whose command line mentions .state).
    outputDir: path.resolve(__dirname, '..', '..', '..', 'tmp', 'demo-walkthrough', 'test-results'),
    use: {
        headless: true,
        viewport: { width: 1920, height: 1080 },
        actionTimeout: 30_000,
        navigationTimeout: 60_000,
        // the scene fixture records its own 1920x1080 video; Playwright's built-in recording stays off
        video: 'off',
        trace: 'off',
    },
});
