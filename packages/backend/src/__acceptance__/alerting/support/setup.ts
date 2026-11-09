/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
import { vi } from 'vitest';

// Same config mock as the unit suite (setupVitest.ts), but global fetch is
// left real: these tests talk HTTP to mock servers on 127.0.0.1:0.
vi.mock('../../../config/lightdashConfig', async () => {
    const { lightdashConfigMock } =
        await import('../../../config/lightdashConfig.mock');
    return { lightdashConfig: lightdashConfigMock };
});
