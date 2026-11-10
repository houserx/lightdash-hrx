// ENG-1799 demo line: acceptance test config. PROTECTED (demo/eng-1799/acceptance/**).
// Run through acceptance/run.sh, one spec at a time.
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    testMatch: /.*\.spec\.ts$/,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: true,
    // Specs that wait on the scenario clock set their own, longer timeouts.
    timeout: 120_000,
    expect: { timeout: 15_000 },
    reporter: [['list']],
    outputDir: '../../../tmp/demo-acceptance/test-results',
    use: {
        headless: true,
        viewport: { width: 1920, height: 1080 },
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
        video: 'off',
        trace: 'off',
    },
});
