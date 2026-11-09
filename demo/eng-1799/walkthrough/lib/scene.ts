// ENG-1799 demo: shared fixtures and steps for the recorded walkthrough scenes.
//
// `test` is Playwright's test with:
//   - `context`: a fresh 1920x1080 browser context recording a 1920x1080 video. When the test ends the context is
//     closed and the video is saved as out/scenes/<scene-id>/video.webm (also when the scene fails, for debugging).
//   - `scene`: the scene id (the spec's file name without .spec.ts), its output directory and `keyMoment(page)`,
//     which writes out/scenes/<scene-id>/key-moment.png.
//   - `stack`: demo/eng-1799/.state/stack.json, written by up.sh. Every URL in it is a 127.0.0.1 literal.
//
// A scene starts by removing its old output, so a scene that fails leaves no stale key-moment.png behind.
import { test as base, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export const DEMO_DIR = path.resolve(__dirname, '..', '..');
export const STACK_JSON = path.join(DEMO_DIR, '.state', 'stack.json');
export const SCENES_OUT = path.join(DEMO_DIR, 'out', 'scenes');
export const VIEWPORT = { width: 1920, height: 1080 } as const;

/** The parts of .state/stack.json the walkthrough uses. */
export type WalkthroughStack = {
    lightdash: { url: string; projectUuid: string };
    demoUser: { email: string; password: string };
    scenario: { url: string };
};

export function readStack(): WalkthroughStack {
    if (!existsSync(STACK_JSON)) {
        throw new Error(`${STACK_JSON} does not exist: start the stack first (bash demo/eng-1799/up.sh)`);
    }
    return JSON.parse(readFileSync(STACK_JSON, 'utf8')) as WalkthroughStack;
}

export type Scene = {
    id: string;
    dir: string;
    /** Save the scene's key-moment screenshot (the full 1920x1080 viewport). */
    keyMoment: (page: Page) => Promise<void>;
};

export const test = base.extend<{ scene: Scene; stack: WalkthroughStack }>({
    stack: async ({}, use) => {
        await use(readStack());
    },
    scene: async ({}, use, testInfo) => {
        const id = path.basename(testInfo.file, '.spec.ts');
        const dir = path.join(SCENES_OUT, id);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        await use({
            id,
            dir,
            keyMoment: async (page) => {
                await page.screenshot({ path: path.join(dir, 'key-moment.png') });
            },
        });
    },
    context: async ({ browser, scene }, use, testInfo) => {
        const context = await browser.newContext({
            viewport: VIEWPORT,
            recordVideo: { dir: testInfo.outputPath('video'), size: VIEWPORT },
        });
        await use(context);
        const pages = context.pages();
        await context.close();
        const video = pages[0]?.video();
        if (video) await video.saveAs(path.join(scene.dir, 'video.webm'));
    },
});

export { expect };

/** A short hold so a viewer can take in what just changed. Never used to wait for state. */
export const beat = (page: Page, ms = 1_200) => page.waitForTimeout(ms);

/** Sign in through the Lightdash login form as the demo user; resolves on the first page after login. */
export async function signIn(page: Page, stack: WalkthroughStack): Promise<void> {
    await page.goto(`${stack.lightdash.url}/login`);
    const email = page.getByPlaceholder('Your email address');
    await expect(email).toBeVisible();
    await email.pressSequentially(stack.demoUser.email, { delay: 25 });
    await page.getByRole('button', { name: 'Continue' }).click();
    const password = page.getByPlaceholder('Your password');
    await expect(password).toBeVisible();
    await password.fill(stack.demoUser.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** Open a dashboard of the Operations Project from its dashboards list, as a user would. */
export async function openDashboardFromList(page: Page, stack: WalkthroughStack, name: string): Promise<void> {
    await page.goto(`${stack.lightdash.url}/projects/${stack.lightdash.projectUuid}/dashboards`);
    const link = page.getByText(name, { exact: true }).first();
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/dashboards\/[^/]+\/view/);
}

/** A dashboard Tile (react-grid-layout grid item) by its title. */
export const tile = (page: Page, title: string) =>
    page.locator('.react-grid-item').filter({ has: page.getByText(title, { exact: true }) });

/** Errors a Tile or the page may show when a query fails. */
export const QUERY_ERROR_TEXT = /there was an error|error running query|unable to load|42501|42P01|audited query requires a description/i;
