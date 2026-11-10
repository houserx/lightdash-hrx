// demo-lightdash-frontend. PROTECTED.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, readStack } from './helpers/stack';

test('demo-lightdash-frontend: the Lightdash UI is served at the printed URL and shows the sign-in page', async ({ page }) => {
    const stack = readStack();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(stack.lightdash.url);
    // /login once the seed has created the demo user; /register on a fresh instance without one
    await expect(page).toHaveURL(/\/(login|register)/, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: /sign in|continue|sign up|create/i }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel(/email/i).first()).toBeVisible();
    expect(errors, 'no uncaught page errors').toEqual([]);

    // docs record whether the UI is a production build served by the backend or the dev server, and why
    const doc = readFileSync(path.join(ROOT, 'docs', 'eng-1799', 'demo.md'), 'utf8');
    expect(doc).toMatch(/production build|dev server/i);
});
