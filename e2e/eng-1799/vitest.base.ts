// Base vitest config for the ENG-1799 e2e checks, merged by the protected
// acceptance/vitest.config.ts. It only adds module resolution so the checks can import Lightdash
// source by path: the same aliases as packages/backend/vitest.config.ts. Order matters:
// `@lightdash/common/src` must come before `@lightdash/common`.
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

const packages = path.resolve(__dirname, '../../packages');

export default defineConfig({
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
