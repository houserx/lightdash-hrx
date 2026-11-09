/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
import * as path from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from '../../../vite.config';

const frontendRoot = path.resolve(__dirname, '../../..');

// Alerting acceptance tests for the frontend: the app's own vite/vitest
// config (jsdom, src/testing/vitest.setup.ts), limited to this folder.
// Components render inside <MantineProvider env="test" forceColorScheme="light">
// only (no renderWithProviders). Run through ./run.sh, one file at a time.
export default mergeConfig(
    viteConfig,
    defineConfig({
        root: frontendRoot,
        test: {
            include: ['src/__acceptance__/alerting/**/*.accept.{ts,tsx}'],
            testTimeout: 30_000,
        },
    }),
);
