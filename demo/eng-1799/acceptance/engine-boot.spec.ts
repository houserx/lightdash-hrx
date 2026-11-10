// demo-engine-boot. PROTECTED.
import { expect, test } from '@playwright/test';
import { pgrepLines, readStack, STATE, withEngine } from './helpers/stack';

test('demo-engine-boot: the Federation Engine runs from this repo, configured under .state with every demo Telemetry Source and the Platform Database', async () => {
    const stack = readStack();
    const engine = stack.processes.find((p) => /engine/i.test(p.name));
    expect(engine, 'stack.json lists the engine process').toBeTruthy();

    await withEngine(stack, async (c) => {
        const v = (await c.query('select version() as v')).rows[0].v as string;
        expect(v).toMatch(/^PostgreSQL 16\.0 \(hrx-federation-engine /);
    });

    // /healthz answers (200 or 503) and names every source
    const res = await fetch(`${stack.engine.httpUrl}/healthz`);
    expect([200, 503]).toContain(res.status);
    const body = await res.text();
    for (const kind of ['prometheus', 'loki', 'tempo', 'cloudwatch', 'platform']) {
        expect(body.toLowerCase(), `healthz lists a ${kind} source`).toContain(kind);
    }

    // the engine's config lives in the state dir
    const line = pgrepLines('federation-engine/target/(debug|release)/engine').find((l) => l.startsWith(`${engine!.pid} `));
    expect(line, `the engine process (pid ${engine!.pid}) runs this repo's federation-engine binary`).toBeTruthy();
    expect(line).toContain(STATE);
});
