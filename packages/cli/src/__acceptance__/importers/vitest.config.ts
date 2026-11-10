/* eslint-disable */
// @ts-nocheck
// Acceptance tests (protected) for the ENG-1799 importer CLI commands. Each test spawns the CLI
// from source on synthetic or fixture input and reads the files it writes. Run one file at a
// time through ./run.sh.
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    root: path.resolve(__dirname, '../../..'),
    test: {
        name: 'cli-importers-acceptance',
        include: ['src/__acceptance__/importers/**/*.test.ts'],
        environment: 'node',
        globals: true,
        maxWorkers: 2,
        testTimeout: 150_000,
        hookTimeout: 150_000,
        env: {
            TZ: 'UTC',
            LANG: 'en_US.UTF-8',
            NODE_ENV: 'test',
            FORCE_COLOR: '0',
        },
    },
    resolve: {
        alias: {
            '@lightdash/common': path.resolve(__dirname, '../../../../common/src'),
            '@lightdash/warehouses': path.resolve(__dirname, '../../../../warehouses/src'),
        },
    },
});
