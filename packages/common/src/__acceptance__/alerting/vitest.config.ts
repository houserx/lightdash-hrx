/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// Alerting acceptance tests for @lightdash/common. Run through ./run.sh.
export default defineConfig({
    root: path.resolve(__dirname, '../../..'),
    test: {
        name: 'common-alerting-acceptance',
        include: ['src/__acceptance__/alerting/**/*.accept.ts'],
        environment: 'node',
        globals: true,
        // Importing the whole package entry can take several seconds cold.
        testTimeout: 60_000,
        env: { TZ: 'UTC', LANG: 'en_US.UTF-8', NODE_ENV: 'test' },
    },
});
