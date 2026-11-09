// demo-scenario-clock. PROTECTED.
// Check: DEMO_INCIDENT_AT=100 DEMO_RECOVERY_AT=400 bash demo/eng-1799/acceptance/run.sh --stack scenario-clock.spec.ts
import { expect, test } from '@playwright/test';
import { getScenario, readStack, restartScenario } from './helpers/stack';

const ms = (s: string) => new Date(s).getTime();

test('demo-scenario-clock: the scenario clock takes its offsets from the environment, restarts on request and moves in real time', async () => {
    const stack = readStack();

    const initial = await getScenario(stack);
    expect(Math.round((ms(initial.incidentAt) - ms(initial.startedAt)) / 1000)).toBe(Number(process.env.DEMO_INCIDENT_AT ?? 90));
    expect(Math.round((ms(initial.recoveryAt) - ms(initial.startedAt)) / 1000)).toBe(Number(process.env.DEMO_RECOVERY_AT ?? 300));
    expect(Math.abs(ms(initial.now) - Date.now())).toBeLessThan(5_000);
    expect(initial.phase).toBe('baseline');

    const r = await restartScenario(stack, 3, 7);
    expect(Math.abs(ms(r.startedAt) - Date.now())).toBeLessThan(5_000);
    expect(Math.round((ms(r.incidentAt) - ms(r.startedAt)) / 1000)).toBe(3);
    expect(Math.round((ms(r.recoveryAt) - ms(r.startedAt)) / 1000)).toBe(7);
    expect(r.phase).toBe('baseline');

    await new Promise((res) => setTimeout(res, 4_000));
    expect((await getScenario(stack)).phase).toBe('incident');
    await new Promise((res) => setTimeout(res, 4_500));
    expect((await getScenario(stack)).phase).toBe('recovered');

    // negative offsets shift the timeline into the past
    const past = await restartScenario(stack, -120, -30);
    expect(past.phase).toBe('recovered');
    expect(ms(past.incidentAt)).toBeLessThan(Date.now() - 100_000);
    const during = await restartScenario(stack, -60, 600);
    expect(during.phase).toBe('incident');
});
