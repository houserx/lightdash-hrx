/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

const backendRoot = path.resolve(__dirname, '../../..');

// Alerting acceptance tests. Run them through support/run.sh, which starts a
// throwaway Postgres and exports PGHOST/PGPORT for `createMigratedDatabase`.
export default defineConfig({
    root: backendRoot,
    test: {
        name: 'alerting-acceptance',
        include: ['src/__acceptance__/alerting/**/*.accept.ts'],
        environment: 'node',
        globals: true,
        setupFiles: [path.resolve(__dirname, 'support/setup.ts')],
        testTimeout: 60_000,
        hookTimeout: 600_000,
        fileParallelism: false,
        env: {
            TZ: 'UTC',
            LANG: 'en_US.UTF-8',
            NODE_ENV: 'test',
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(backendRoot, 'src'),
            '@lightdash/common/src': path.resolve(backendRoot, '../common/src'),
            '@lightdash/common': path.resolve(backendRoot, '../common/src'),
            '@lightdash/formula': path.resolve(backendRoot, '../formula/src'),
            '@lightdash/warehouses': path.resolve(
                backendRoot,
                '../warehouses/src',
            ),
        },
    },
});
