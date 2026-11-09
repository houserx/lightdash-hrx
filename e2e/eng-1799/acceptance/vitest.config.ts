// Protected vitest config for the ENG-1799 e2e acceptance checks. It runs one file at a time
// (acceptance/run.sh) with generous timeouts and no parallelism.
//
// `../vitest.base.ts` is NOT protected: the integration line writes it (feature
// int-harness-engine). It must default-export a vitest config with whatever module resolution
// the tests need to import Lightdash source (e.g. the aliases in packages/backend/vitest.config.ts:
// `@lightdash/common` -> packages/common/src, `@lightdash/warehouses` -> packages/warehouses/src,
// `@lightdash/formula` -> packages/formula/src, `@` -> packages/backend/src) and any setup the
// backend modules need. It must not change what this file sets below.
import * as path from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vitest.base';

const root = path.resolve(__dirname, '..');

export default mergeConfig(
    base,
    defineConfig({
        root,
        test: {
            include: ['acceptance/**/*.test.ts'],
            passWithNoTests: false,
            environment: 'node',
            globals: true,
            testTimeout: 150_000,
            hookTimeout: 170_000,
            teardownTimeout: 60_000,
            fileParallelism: false,
            maxWorkers: 1,
            pool: 'forks',
            retry: 0,
            bail: 0,
            env: {
                TZ: 'UTC',
                NODE_ENV: 'test',
            },
        },
    }),
);
