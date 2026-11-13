// Plain object on purpose: this file is loaded by the backend's vitest
// binary from outside the backend package, where `vitest/config` does not
// resolve. Tests use the vitest globals.
import { fileURLToPath } from 'node:url';

export default {
    // keep vite's cache out of the protected folder
    cacheDir: fileURLToPath(
        new URL('../../../tmp/vitest-chart-registry', import.meta.url),
    ),
    test: {
        root: fileURLToPath(new URL('.', import.meta.url)),
        include: ['**/*.test.ts'],
        globals: true,
        environment: 'node',
        testTimeout: 60_000,
        hookTimeout: 120_000,
        pool: 'forks',
    },
};
