// demo-seed-project. PROTECTED.
import { expect, test } from '@playwright/test';
import { browserLogin, ld, lightdashApi, readStack } from './helpers/stack';

test('demo-seed-project: the demo user signs in to an Operations Project on the Federation Engine flavour with Platform Database grants', async ({ page }) => {
    const stack = readStack();
    expect(stack.demoUser.email).toMatch(/@example\.(com|org)$/);
    const ctx = await lightdashApi(stack);

    const project = await ld<any>(ctx, 'GET', `/api/v1/projects/${stack.lightdash.projectUuid}`);
    expect(project.name).toMatch(/Operations/);
    expect(project.warehouseConnection?.type).toBe('postgres');
    expect(project.warehouseConnection?.flavor).toBe('federation');
    expect(JSON.stringify(project.warehouseConnection), 'secrets are never returned').not.toMatch(/identitySigningSecret"\s*:\s*"[^"]/);

    const access = await ld<any>(ctx, 'GET', `/api/v2/projects/${stack.lightdash.projectUuid}/federation/access`);
    expect(access.isFederation).toBe(true);
    expect(access.attrs.platform_read).toBe(true);
    expect(access.attrs.platform_write).toBe(true);

    // and through the browser: the project home opens
    await browserLogin(page, stack);
    await page.goto(`${stack.lightdash.url}/projects/${stack.lightdash.projectUuid}/home`);
    await expect(page.getByText(project.name).first()).toBeVisible({ timeout: 60_000 });
});
