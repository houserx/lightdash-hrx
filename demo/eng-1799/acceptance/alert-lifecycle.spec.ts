// demo-alert-fires and demo-alert-resolves. PROTECTED. Real waits on the scenario clock.
// Checks: run.sh --stack alert-lifecycle.spec.ts --grep "demo-alert-fires:" | --grep "demo-alert-resolves:"
import { expect, test } from '@playwright/test';
import {
    incidentNotifications,
    lightdashApi,
    NAMES,
    notificationsFor,
    poll,
    readStack,
    restartScenario,
    ruleByName,
} from './helpers/stack';

test.describe.configure({ timeout: 300_000 });

test('demo-alert-fires: when the incident starts, both Alert Rules fire and incident.io receives the firing notification', async () => {
    const stack = readStack();
    const ctx = await lightdashApi(stack);
    const before = await ruleByName(ctx, stack.lightdash.projectUuid, NAMES.backlogRule);
    expect(before.state).not.toBe('firing');

    await restartScenario(stack, 5, 900);
    await poll(
        `${NAMES.backlogRule} firing`,
        async () => (await ruleByName(ctx, stack.lightdash.projectUuid, NAMES.backlogRule)).state === 'firing',
        { timeoutMs: 150_000, intervalMs: 3_000 },
    );
    await poll(
        `incident.io got a firing notification for ${NAMES.backlogRule}`,
        async () => notificationsFor(await incidentNotifications(stack), NAMES.backlogRule, 'firing').length > 0,
        { timeoutMs: 60_000, intervalMs: 2_000 },
    );
    await poll(
        `${NAMES.errorLogRule} firing`,
        async () => (await ruleByName(ctx, stack.lightdash.projectUuid, NAMES.errorLogRule)).state === 'firing',
        { timeoutMs: 90_000, intervalMs: 3_000 },
    );
    const n = notificationsFor(await incidentNotifications(stack), NAMES.backlogRule, 'firing')[0];
    const alert = n.payload.alerts.find((a: any) => a.labels.alertname === NAMES.backlogRule);
    expect(alert.fingerprint).toBeTruthy();
    expect(Number.isNaN(new Date(alert.startsAt).getTime())).toBe(false);
    expect(JSON.stringify(alert.annotations)).toMatch(/\d/); // annotations render the value
});

test('demo-alert-resolves: at recovery the backlog Alert Rule resolves and incident.io receives the resolve notification', async () => {
    const stack = readStack();
    const ctx = await lightdashApi(stack);
    await restartScenario(stack, -120, 35); // incident already in progress, recovery in 35 s
    await poll(
        `${NAMES.backlogRule} firing`,
        async () => (await ruleByName(ctx, stack.lightdash.projectUuid, NAMES.backlogRule)).state === 'firing',
        { timeoutMs: 90_000, intervalMs: 2_000 },
    );
    await poll(
        `${NAMES.backlogRule} no longer firing`,
        async () => ['resolved', 'normal'].includes((await ruleByName(ctx, stack.lightdash.projectUuid, NAMES.backlogRule)).state),
        { timeoutMs: 150_000, intervalMs: 3_000 },
    );
    const resolved = await poll(
        `incident.io got a resolved notification for ${NAMES.backlogRule}`,
        async () => {
            const r = notificationsFor(await incidentNotifications(stack), NAMES.backlogRule, 'resolved');
            return r.length > 0 ? r : undefined;
        },
        { timeoutMs: 90_000, intervalMs: 2_000 },
    );
    const alert = resolved[0].payload.alerts.find((a: any) => a.labels.alertname === NAMES.backlogRule);
    expect(new Date(alert.endsAt).getTime()).toBeGreaterThan(new Date(alert.startsAt).getTime());
});
