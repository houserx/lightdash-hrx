// demo-run-all-fails-cleanly. PROTECTED. No --stack.
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { DEMO, processesUsingState, sh } from './helpers/stack';

test('demo-run-all-fails-cleanly: run-all.sh exits non-zero when a step fails and leaves no process behind', () => {
    const started = Date.now();
    const r = sh('bash', [path.join(DEMO, 'run-all.sh')], { env: { DEMO_INCIDENT_AT: 'soon' }, timeoutMs: 300_000 });
    expect(r.status, 'run-all.sh fails').not.toBe(0);
    expect(r.status, 'it was not killed by the timeout').not.toBeNull();
    expect(Date.now() - started, 'it stops at the failing step').toBeLessThan(240_000);
    expect(`${r.stdout}${r.stderr}`).toMatch(/DEMO_INCIDENT_AT/);
    expect(processesUsingState()).toEqual([]);
    sh('bash', [path.join(DEMO, 'down.sh')]);
});
