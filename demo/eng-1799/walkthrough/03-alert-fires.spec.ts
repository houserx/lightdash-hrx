// Scene 3: the alert fires. The scene opens the Operations Project's Alert Rules list, waits on the scenario clock
// for the incident and reloads the list until the "Fill queue backlog high" rule turns Firing (the alert worker
// evaluates it every 30 s). It then opens the fake incident.io page, which refreshes itself every 5 s, until the
// firing notification for the rule shows with its rendered summary.
//
// It never restarts the scenario clock: restart it first with the incident a few seconds out (or already started),
// e.g.
//   curl -X POST <scenario>/scenario/restart -H 'content-type: application/json' \
//        -d '{"incidentAfterSeconds": 20, "recoveryAfterSeconds": 900}'
// When the incident is more than MAX_WAIT_MS away, the scene fails at once and says so.
//
// Key moment: the fake incident.io page with the firing notification of the backlog rule.
import type { Page } from '@playwright/test';
import { beat, expect, getScenario, signIn, test, waitForPhase, type WalkthroughStack } from './lib/scene';

const RULE = 'Fill queue backlog high';
const MAX_WAIT_MS = 120_000;
/** The rule is evaluated every 30 s; allow a few evaluations plus the time to deliver. */
const FIRING_TIMEOUT_MS = 120_000;

test.describe.configure({ timeout: 300_000 });

const ruleRow = (page: Page) => page.getByRole('row').filter({ has: page.getByRole('button', { name: RULE, exact: true }) });
const ruleState = (page: Page) => ruleRow(page).getByRole('cell').first();

type Received = { receivedAt: string; payload: { status: string; alerts: { status?: string; labels?: Record<string, string> }[] } };

/** Firing notifications for the rule the fake incident.io receiver has accepted (GET /api/received). */
async function firingNotifications(stack: WalkthroughStack): Promise<Received[]> {
    const res = await fetch(`${stack.incidentIo.url}/api/received`);
    if (!res.ok) throw new Error(`GET ${stack.incidentIo.url}/api/received: HTTP ${res.status}`);
    const { notifications } = (await res.json()) as { notifications: Received[] };
    return notifications.filter((n) =>
        n.payload.alerts.some((a) => a.labels?.alertname === RULE && (a.status ?? n.payload.status) === 'firing'),
    );
}

test('03-alert-fires: the backlog rule turns Firing in the Alert Rules list and incident.io shows the notification', async ({
    page,
    scene,
    stack,
}) => {
    const start = await getScenario(stack);
    expect(start.phase, 'the scene starts before the recovery (restart the scenario clock first)').not.toBe('recovered');

    await signIn(page, stack);
    await page.goto(`${stack.lightdash.url}/projects/${stack.lightdash.projectUuid}/alerting/rules`);
    await expect(page.getByRole('tab', { name: 'Alert Rules' }), 'the Alert Rules tab is open').toHaveAttribute('aria-selected', 'true');
    await expect(ruleRow(page), `the "${RULE}" rule is listed`).toBeVisible();
    await expect(ruleRow(page), 'the rule is uploaded as code').toContainText('Managed in git');
    await expect(ruleRow(page), 'the rule pages pharmacy ops').toContainText('team=pharmacy-ops');

    // Before the incident the rule is not firing (when the incident has not started yet).
    const before = await getScenario(stack);
    if (before.phase === 'baseline') {
        await expect(ruleState(page), 'baseline: the rule is not firing').not.toHaveText('Firing');
    } else {
        test.info().annotations.push({ type: 'baseline', description: `skipped: the scene started in the ${before.phase}` });
    }
    await beat(page);

    // Wait on the scenario clock (not a fixed sleep), then reload the list until the rule turns Firing.
    const incident = await waitForPhase(stack, 'incident', MAX_WAIT_MS);
    expect(new Date(incident.now).getTime(), 'the scenario clock is past the incident start').toBeGreaterThanOrEqual(
        new Date(incident.incidentAt).getTime(),
    );
    await expect
        .poll(
            async () => {
                await page.reload();
                await expect(ruleRow(page)).toBeVisible();
                await beat(page, 1_500);
                return (await ruleState(page).innerText()).trim();
            },
            { message: `the "${RULE}" rule turns Firing in the list`, timeout: FIRING_TIMEOUT_MS, intervals: [3_000] },
        )
        .toBe('Firing');
    await expect(ruleState(page), 'the rule is Firing').toHaveText('Firing');

    // Show only the firing rules: the backlog rule is among them.
    await page.getByRole('combobox', { name: 'State' }).click();
    await page.getByRole('option', { name: 'Firing', exact: true }).click();
    await expect(ruleRow(page), 'the State filter "Firing" keeps the rule').toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: /Normal|No data/ }), 'only firing rules are listed').toHaveCount(0);
    await page.mouse.move(960, 1_060);
    await beat(page, 2_500);

    // The Contact Point posts the notification to the fake incident.io receiver.
    await expect
        .poll(async () => (await firingNotifications(stack)).length, {
            message: `incident.io receives a firing notification for "${RULE}"`,
            timeout: 60_000,
            intervals: [1_000],
        })
        .toBeGreaterThan(0);

    await page.goto(stack.incidentIo.url);
    await expect(page.getByRole('heading', { name: /incident\.io \(fake\)/ })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: RULE }).first();
    await expect(row, 'the page lists the rule').toBeVisible({ timeout: 30_000 });
    await expect(row.locator('td.status'), 'the newest notification for the rule is firing').toHaveText(/firing/i);
    await expect(row, 'the summary annotation is rendered with the value').toContainText(/Fill queue backlog is \d[\d.]* \(threshold 100\)/);
    await expect(row, 'the rule labels travel with the alert').toContainText('team=pharmacy-ops');
    await expect(row.locator('td.status'), 'firing is shown in red').toHaveCSS('color', 'rgb(200, 30, 30)');
    expect((await getScenario(stack)).phase, 'still in the incident').toBe('incident');

    await beat(page, 1_500);
    await scene.keyMoment(page);
    await beat(page);
});
