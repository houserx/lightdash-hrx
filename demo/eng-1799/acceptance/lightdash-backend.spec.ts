// demo-lightdash-backend. PROTECTED.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getJson, LOGDIR, poll, readStack } from './helpers/stack';

test('demo-lightdash-backend: the Lightdash backend runs migrated on its own Postgres, with the scheduler and alert worker on', async () => {
    const stack = readStack();
    expect(stack.lightdash.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const up = readFileSync(path.join(LOGDIR, 'up.log'), 'utf8');
    expect(up, 'up.sh prints the Lightdash URL').toContain(`Lightdash: ${stack.lightdash.url}`);

    const health = await getJson<any>(`${stack.lightdash.url}/api/v1/health`);
    expect(health.status).toBe('ok');
    expect(health.results?.healthy ?? true).toBe(true);

    // the alert worker completes evaluation cycles (CONTRACTS §4.3 heartbeat; alerting health goes "ok")
    const alerting = await poll(
        'GET /api/v1/alerting/health -> ok',
        async () => {
            const h = await getJson<any>(`${stack.lightdash.url}/api/v1/alerting/health`);
            const r = h.results ?? h;
            return r.status === 'ok' ? r : undefined;
        },
        { timeoutMs: 90_000, intervalMs: 3_000 },
    );
    expect(alerting.lagSeconds).toBeLessThanOrEqual(60);

    // there is a separate Lightdash process for the scheduler (or the backend runs it in-process: then it is listed once)
    expect(stack.processes.some((p) => /lightdash|backend/i.test(p.name))).toBe(true);
});
