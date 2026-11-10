/* eslint-disable */
// @ts-nocheck
// Acceptance tests (protected) for the ENG-1799 importers' pure conversion logic in
// @lightdash/common. Run one file at a time through ./run.sh.
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    root: path.resolve(__dirname, '../../..'),
    test: {
        name: 'common-importers-acceptance',
        include: ['src/__acceptance__/importers/**/*.test.ts'],
        environment: 'node',
        globals: true,
        maxWorkers: 2,
        // Importing the package entry can take several seconds cold.
        testTimeout: 60_000,
        hookTimeout: 120_000,
        env: { TZ: 'UTC', LANG: 'en_US.UTF-8', NODE_ENV: 'test' },
    },
});
