// Base vitest config for the ENG-1799 e2e checks, merged by the protected
// acceptance/vitest.config.ts. It adds module resolution so the checks can import Lightdash
// source by path: the same aliases as packages/backend/vitest.config.ts. Order matters:
// `@lightdash/common/src` must come before `@lightdash/common`. It also runs setupEnv.ts, which
// gives the backend config the placeholder env that parseConfig() needs at import.
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

const packages = path.resolve(__dirname, '../../packages');

export default defineConfig({
    test: {
        setupFiles: [path.join(__dirname, 'setupEnv.ts')],
    },
    resolve: {
        alias: {
            '@': path.join(packages, 'backend/src'),
            '@lightdash/common/src': path.join(packages, 'common/src'),
            '@lightdash/common': path.join(packages, 'common/src'),
            '@lightdash/formula': path.join(packages, 'formula/src'),
            '@lightdash/warehouses': path.join(packages, 'warehouses/src'),
        },
    },
});
