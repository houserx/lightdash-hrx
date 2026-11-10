// demo-stack-lifecycle. PROTECTED. Runs WITHOUT run.sh --stack: it drives up.sh and down.sh itself.
import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEMO, pidAlive, portOpen, processesUsingState, readStack, sh, STACK_JSON, STATE, stackPorts } from './helpers/stack';

const up = () => sh('bash', [path.join(DEMO, 'up.sh')], { timeoutMs: 400_000 });
const down = () => sh('bash', [path.join(DEMO, 'down.sh')], { timeoutMs: 120_000 });

test.describe.configure({ timeout: 900_000 });

test('demo-stack-lifecycle: up.sh starts everything and is idempotent; down.sh stops all of it and is idempotent', async () => {
    try {
        expect(down().status, 'down.sh with nothing running exits 0').toBe(0);

        const first = up();
        expect(first.status, `up.sh:\n${first.stdout.slice(-3000)}\n${first.stderr.slice(-3000)}`).toBe(0);
        expect(existsSync(STACK_JSON)).toBe(true);
        const stack = readStack();
        expect(stack.processes.length, 'stack.json lists the processes it started').toBeGreaterThan(0);
        for (const p of stack.processes) expect(pidAlive(p.pid), `${p.name} (pid ${p.pid}) is running`).toBe(true);
        const ports = stackPorts(stack);
        expect(ports.length).toBeGreaterThan(0);
        for (const port of ports) expect(await portOpen(port), `port ${port} answers`).toBe(true);
        // no fixed well-known ports
        for (const fixed of [5432, 5433, 8080, 8088, 3000, 9090, 3100, 3200]) expect(ports).not.toContain(fixed);
        // up.sh prints the Lightdash URL
        expect(first.stdout).toContain(`Lightdash: ${stack.lightdash.url}`);

        // a second up.sh keeps the running stack
        const second = up();
        expect(second.status, `second up.sh:\n${second.stderr.slice(-2000)}`).toBe(0);
        const again = readStack();
        expect(again.processes.map((p) => p.pid).sort()).toEqual(stack.processes.map((p) => p.pid).sort());
        expect(again.lightdash.url).toBe(stack.lightdash.url);
        expect(second.stdout).toContain(`Lightdash: ${stack.lightdash.url}`);

        const d1 = down();
        expect(d1.status, `down.sh:\n${d1.stderr.slice(-2000)}`).toBe(0);
        await new Promise((r) => setTimeout(r, 1_000));
        for (const p of stack.processes) expect(pidAlive(p.pid), `${p.name} (pid ${p.pid}) stopped`).toBe(false);
        for (const port of ports) expect(await portOpen(port), `port ${port} closed`).toBe(false);
        expect(processesUsingState(), `no process still uses ${STATE}`).toEqual([]);

        expect(down().status, 'second down.sh exits 0').toBe(0);
    } finally {
        down();
    }
});
