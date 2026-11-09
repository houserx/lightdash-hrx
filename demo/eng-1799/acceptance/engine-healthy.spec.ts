// demo-engine-healthy. PROTECTED.
import { expect, test } from '@playwright/test';
import { poll, readStack } from './helpers/stack';

test('demo-engine-healthy: with the whole stack up the engine reports every source healthy', async () => {
    const stack = readStack();
    const body = await poll(
        'engine /healthz 200',
        async () => {
            const r = await fetch(`${stack.engine.httpUrl}/healthz`);
            return r.status === 200 ? r.text() : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 1_000 },
    );
    for (const kind of ['prometheus', 'loki', 'tempo', 'cloudwatch', 'platform']) expect(body.toLowerCase()).toContain(kind);
});
