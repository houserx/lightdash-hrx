// demo-fake-incident-io. PROTECTED.
import { expect, test } from '@playwright/test';
import { incidentNotifications, readStack } from './helpers/stack';

const payload = (status: 'firing' | 'resolved') => ({
    version: '4',
    status,
    receiver: 'incident-io',
    groupKey: '{}:{alertname="Acceptance probe"}',
    groupLabels: { alertname: 'Acceptance probe' },
    commonLabels: { alertname: 'Acceptance probe', team: 'demo' },
    commonAnnotations: { summary: 'synthetic probe' },
    externalURL: 'http://127.0.0.1/',
    alerts: [
        {
            status,
            labels: { alertname: 'Acceptance probe', team: 'demo' },
            annotations: { summary: 'synthetic probe' },
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            endsAt: status === 'resolved' ? new Date().toISOString() : '0001-01-01T00:00:00Z',
            fingerprint: '0123456789abcdef',
        },
    ],
});

test('demo-fake-incident-io: the receiver records Alertmanager v4 webhooks and lists them on a small HTML page', async ({ page }) => {
    const stack = readStack();
    for (const status of ['firing', 'resolved'] as const) {
        const r = await fetch(`${stack.incidentIo.url}/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret-not-real' },
            body: JSON.stringify(payload(status)),
        });
        expect(r.status).toBeLessThan(300);
    }
    const got = (await incidentNotifications(stack)).filter((n) => n.payload?.groupLabels?.alertname === 'Acceptance probe');
    expect(got.map((n) => n.payload.status)).toEqual(['firing', 'resolved']);
    for (const n of got) expect(Number.isNaN(new Date(n.receivedAt).getTime())).toBe(false);

    await page.goto(stack.incidentIo.url);
    await expect(page).toHaveTitle(/incident\.io/i);
    const rows = page.getByRole('row').filter({ hasText: 'Acceptance probe' });
    await expect(rows.filter({ hasText: /firing/i })).toHaveCount(1);
    await expect(rows.filter({ hasText: /resolved/i })).toHaveCount(1);
});
