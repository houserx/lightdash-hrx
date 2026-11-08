import { defineConfig } from 'vitest/config';

// Unit tests only (src/**/*.test.ts). Acceptance checks use tests/acceptance/vitest.config.ts.
export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        environment: 'node',
        passWithNoTests: false,
    },
});
