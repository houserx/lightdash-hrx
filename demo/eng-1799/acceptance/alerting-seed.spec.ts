// demo-alerting-seed. PROTECTED.
import { expect, test } from '@playwright/test';
import { ld, lightdashApi, NAMES, readStack, ruleByName } from './helpers/stack';

test('demo-alerting-seed: Alert Rules for the incident, an incident.io Contact Point on the fake receiver and a Notification Route tree are seeded', async ({ page }) => {
    const stack = readStack();
    const ctx = await lightdashApi(stack);
    const base = `/api/v2/projects/${stack.lightdash.projectUuid}/alerting`;

    const backlog = await ruleByName(ctx, stack.lightdash.projectUuid, NAMES.backlogRule);
    expect(backlog.query).toContain('hrx_fill_queue_backlog');
    expect(JSON.stringify(backlog.condition)).toContain(String(NAMES.backlogThreshold));
    expect(backlog.paused).toBe(false);
    expect(backlog.shadow).toBe(false);
    expect(String(backlog.description).trim().length).toBeGreaterThan(0);

    const errors = await ruleByName(ctx, stack.lightdash.projectUuid, NAMES.errorLogRule);
    expect(errors.query).toMatch(/logql/);
    expect(errors.query).toContain('level=error');
    expect(errors.paused).toBe(false);
    expect(errors.shadow).toBe(false);

    const cps = await ld<any[]>(ctx, 'GET', `${base}/contact-points`);
    const incident = cps.find((c) => JSON.stringify(c).includes('incident_io') && JSON.stringify(c).includes(stack.incidentIo.url));
    expect(incident, 'an incident_io Contact Point pointing at the fake receiver').toBeTruthy();
    expect(JSON.stringify(incident), 'no inline secret').not.toMatch(/test-secret-not-real|Bearer /);

    const tree = await ld<any>(ctx, 'GET', `${base}/notification-routes`);
    expect(tree, 'a Notification Route tree').toBeTruthy();
    const treeJson = JSON.stringify(tree);
    expect(treeJson.includes(incident.slug) || treeJson.includes(incident.uuid), 'the tree routes to the incident.io Contact Point').toBe(true);

    // the Alert Rules page lists both
    const login = await page.request.post(`${stack.lightdash.url}/api/v1/login`, { data: stack.demoUser });
    expect(login.ok()).toBe(true);
    await page.goto(`${stack.lightdash.url}/projects/${stack.lightdash.projectUuid}/alerting/rules`);
    await expect(page.getByText(NAMES.backlogRule).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(NAMES.errorLogRule).first()).toBeVisible();
});
