/**
 * Vitest config used by every acceptance check (`--config tests/acceptance/vitest.config.ts`), so the
 * checks run the same way whatever the package's own vitest config says. PROTECTED: do not edit.
 * Consequence for src/: use relative imports only (no tsconfig path aliases).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    test: {
        include: ['tests/acceptance/**/*.test.ts'],
        environment: 'node',
        passWithNoTests: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
        allowOnly: false,
        globals: false,
    },
});
