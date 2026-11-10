/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// Alerting acceptance tests for the CLI. They spawn the CLI from source
// (tsx src/index.ts) against a mock Lightdash API on 127.0.0.1:0, so no
// build is needed. Run through ./run.sh.
export default defineConfig({
    root: path.resolve(__dirname, '../../..'),
    test: {
        name: 'cli-alerting-acceptance',
        include: ['src/__acceptance__/alerting/**/*.accept.ts'],
        environment: 'node',
        globals: true,
        testTimeout: 120_000,
        env: {
            TZ: 'UTC',
            LANG: 'en_US.UTF-8',
            NODE_ENV: 'test',
            FORCE_COLOR: '0',
        },
    },
    resolve: {
        alias: {
            '@lightdash/common': path.resolve(
                __dirname,
                '../../../../common/src',
            ),
            '@lightdash/warehouses': path.resolve(
                __dirname,
                '../../../../warehouses/src',
            ),
        },
    },
});
