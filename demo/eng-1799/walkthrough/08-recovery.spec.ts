// Scene 8: recovery. The scene opens the Operations Project's Alert Rules list, waits on the scenario clock for the
// recovery and reloads the list until the "Fill queue backlog high" rule is back to Normal (the alert worker
// evaluates it every 30 s and the backlog is under 100 within a minute of the recovery). It opens the rule to show
// the Firing → Normal transition in its state history, then opens the fake incident.io page, which refreshes itself
// every 5 s, until the resolve notification for the rule shows.
//
// It never restarts the scenario clock: restart it first with the recovery a few seconds out, e.g.
//   curl -X POST <scenario>/scenario/restart -H 'content-type: application/json' \
//        -d '{"incidentAfterSeconds": -120, "recoveryAfterSeconds": 35}'
// It also copes with a recovery that is already over, as when it runs last in the whole walkthrough: then the rule
// is already Normal and the resolve notification already received, and the scene shows both. A resolve counts only
// when it was received after this timeline's recovery (and after the clock's last restart), so a notification from
// an earlier timeline never passes. When the recovery is more than MAX_WAIT_MS away, the scene fails at once.
//
// Key moment: the fake incident.io page with the resolve notification of the backlog rule.
import type { Page } from '@playwright/test';
import { beat, expect, getScenario, signIn, test, waitForPhase, type Scenario, type WalkthroughStack } from './lib/scene';

const RULE = 'Fill queue backlog high';
const THRESHOLD = 100;
const MAX_WAIT_MS = 120_000;
/** After the recovery: the backlog drops under 100 within a minute, plus a 30 s evaluation and the delivery. */
const RESOLVE_TIMEOUT_MS = 150_000;
const NOT_FIRING = /^(Normal|Resolved)$/;

test.describe.configure({ timeout: 300_000 });

const ruleRow = (page: Page) => page.getByRole('row').filter({ has: page.getByRole('button', { name: RULE, exact: true }) });
const ruleState = (page: Page) => ruleRow(page).getByRole('cell').first();

type Received = { receivedAt: string; payload: { status: string; alerts: { status?: string; labels?: Record<string, string> }[] } };

/** Resolve notifications for the rule received after this timeline's recovery and the clock's last restart. */
async function resolvedNotifications(stack: WalkthroughStack, scenario: Scenario): Promise<Received[]> {
    const res = await fetch(`${stack.incidentIo.url}/api/received`);
    if (!res.ok) throw new Error(`GET ${stack.incidentIo.url}/api/received: HTTP ${res.status}`);
    const { notifications } = (await res.json()) as { notifications: Received[] };
    const after = Math.max(new Date(scenario.recoveryAt).getTime(), new Date(scenario.startedAt).getTime());
    return notifications.filter(
        (n) =>
            new Date(n.receivedAt).getTime() >= after &&
            n.payload.alerts.some((a) => a.labels?.alertname === RULE && (a.status ?? n.payload.status) === 'resolved'),
    );
}

test('08-recovery: the backlog rule resolves in the Alert Rules list and incident.io shows the resolve notification', async ({
    page,
    scene,
    stack,
}) => {
    const start = await getScenario(stack);
    const toRecoveryMs = new Date(start.recoveryAt).getTime() - new Date(start.now).getTime();
    expect(
        toRecoveryMs,
        `the recovery is at most ${MAX_WAIT_MS / 1000} s away (restart the scenario clock with the recovery closer)`,
    ).toBeLessThanOrEqual(MAX_WAIT_MS);
    expect(start.phase, 'the scene starts in the incident or after it (not in the baseline)').not.toBe('baseline');
    const alreadyResolved = (await resolvedNotifications(stack, start)).length > 0;
    test.info().annotations.push({
        type: 'start',
        description: `phase ${start.phase}, recovery ${Math.round(toRecoveryMs / 1000)} s away, resolve ${alreadyResolved ? 'already' : 'not yet'} received`,
    });

    await signIn(page, stack);
    await page.goto(`${stack.lightdash.url}/projects/${stack.lightdash.projectUuid}/alerting/rules`);
    await expect(page.getByRole('tab', { name: 'Alert Rules' }), 'the Alert Rules tab is open').toHaveAttribute('aria-selected', 'true');
    await expect(ruleRow(page), `the "${RULE}" rule is listed`).toBeVisible();
    await expect(ruleRow(page), 'the rule is uploaded as code').toContainText('Managed in git');
    await expect(ruleRow(page), 'the rule pages pharmacy ops').toContainText('team=pharmacy-ops');

    // In the incident, first show the rule Firing: reload the list (it does not poll) until it is, or until the
    // recovery is over and the rule already left Firing (the alert worker evaluates every 30 s).
    if (start.phase === 'incident' && !alreadyResolved) {
        let state = '';
        await expect
            .poll(
                async () => {
                    await page.reload();
                    await expect(ruleRow(page)).toBeVisible();
                    await beat(page, 1_500);
                    state = (await ruleState(page).innerText()).trim();
                    return state === 'Firing' || ((await getScenario(stack)).phase === 'recovered' && NOT_FIRING.test(state));
                },
                {
                    message: `the "${RULE}" rule shows Firing in the incident`,
                    timeout: Math.max(toRecoveryMs, 0) + RESOLVE_TIMEOUT_MS,
                    intervals: [3_000],
                },
            )
            .toBe(true);
        test.info().annotations.push({ type: 'firing', description: state === 'Firing' ? 'shown' : `not seen (state ${state})` });
    }
    await beat(page, 2_000);

    // Wait on the scenario clock (not a fixed sleep) for the recovery; returns at once when it is already over.
    const recovered = await waitForPhase(stack, 'recovered', MAX_WAIT_MS);
    expect(new Date(recovered.now).getTime(), 'the scenario clock is past the recovery').toBeGreaterThanOrEqual(
        new Date(recovered.recoveryAt).getTime(),
    );

    // Reload the list (it does not poll) until the rule is no longer firing.
    await expect
        .poll(
            async () => {
                await page.reload();
                await expect(ruleRow(page)).toBeVisible();
                await beat(page, 1_500);
                return (await ruleState(page).innerText()).trim();
            },
            { message: `the "${RULE}" rule is back to Normal in the list`, timeout: RESOLVE_TIMEOUT_MS, intervals: [3_000] },
        )
        .toMatch(NOT_FIRING);
    await expect(ruleState(page), 'the rule is no longer Firing').not.toHaveText('Firing');
    await page.mouse.move(960, 1_060);
    await beat(page, 2_000);

    // The rule's own page: the newest state change is the way back from Firing.
    await ruleRow(page).getByRole('button', { name: RULE, exact: true }).click();
    await expect(page.getByRole('heading', { name: RULE, level: 2 }), 'the rule page is open').toBeVisible();
    await expect(page.getByText('State history', { exact: true }), 'the rule page shows its state history').toBeVisible();
    const lastChange = page.getByText(/^Firing → (Normal|Resolved)$/).first();
    await expect(lastChange, 'the state history shows the rule leaving Firing').toBeVisible();
    await lastChange.scrollIntoViewIfNeeded();
    await beat(page, 2_500);

    // The Contact Point posts the resolve notification to the fake incident.io receiver.
    await expect
        .poll(async () => (await resolvedNotifications(stack, recovered)).length, {
            message: `incident.io receives a resolve notification for "${RULE}" after the recovery`,
            timeout: 60_000,
            intervals: [1_000],
        })
        .toBeGreaterThan(0);

    await page.goto(stack.incidentIo.url);
    await expect(page.getByRole('heading', { name: /incident\.io \(fake\)/ })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: RULE }).first();
    await expect(row, 'the page lists the rule').toBeVisible({ timeout: 30_000 });
    await expect(row.locator('td.status'), 'the newest notification for the rule is the resolve').toHaveText(/resolved/i);
    await expect(row.locator('td.status'), 'resolved is shown in green').toHaveCSS('color', 'rgb(14, 124, 58)');
    await expect(row, 'the rule labels travel with the resolve').toContainText('team=pharmacy-ops');
    const summary = (await row.locator('td').nth(3).innerText()).trim();
    const value = Number(summary.match(/^Fill queue backlog is (-?[\d.]+) \(threshold 100\)$/)?.[1] ?? NaN);
    expect(summary, 'the summary annotation is rendered with the value').toMatch(/^Fill queue backlog is -?[\d.]+ \(threshold 100\)$/);
    expect(value, 'the backlog is back at or under the threshold').toBeLessThanOrEqual(THRESHOLD);
    await expect(row.locator('td').nth(5), 'the resolve carries the time the alert ended').toHaveText(/\d{4}-\d{2}-\d{2}T/);
    await expect(
        page.getByRole('row').filter({ hasText: RULE }).filter({ has: page.locator('td.status.firing') }).first(),
        'the earlier firing notification is listed below it',
    ).toBeVisible();
    expect((await getScenario(stack)).phase, 'the scenario is recovered').toBe('recovered');

    await beat(page, 1_500);
    await scene.keyMoment(page);
    await beat(page);
});
