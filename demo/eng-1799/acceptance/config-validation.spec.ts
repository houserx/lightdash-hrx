// demo-config-validation. PROTECTED. Runs without --stack.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { DEMO, processesUsingState, sh } from './helpers/stack';

const up = (env: Record<string, string>) => sh('bash', [path.join(DEMO, 'up.sh')], { env, timeoutMs: 120_000 });
const down = () => sh('bash', [path.join(DEMO, 'down.sh')], { timeoutMs: 120_000 });

test('demo-config-validation: up.sh refuses a bad scenario timeline, names the variable and starts nothing', async () => {
    try {
        expect(down().status).toBe(0);
        for (const env of [
            { DEMO_INCIDENT_AT: 'soon', DEMO_RECOVERY_AT: '300' },
            { DEMO_INCIDENT_AT: '90', DEMO_RECOVERY_AT: '-5' },
            { DEMO_INCIDENT_AT: '120', DEMO_RECOVERY_AT: '60' },
        ]) {
            const r = up(env);
            expect(r.status, `up.sh with ${JSON.stringify(env)} must fail`).not.toBe(0);
            expect(`${r.stdout}\n${r.stderr}`).toMatch(/DEMO_(INCIDENT|RECOVERY)_AT/);
            expect(processesUsingState(), 'a refused up.sh leaves no process behind').toEqual([]);
        }
    } finally {
        down();
    }
});
