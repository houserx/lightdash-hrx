/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Scheduler, worker concurrency, overruns, worker wiring, heartbeat and health.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    disk,
    minutes,
    MockHttp,
    T0,
    waitFor,
    withHarness,
} from './support/harness';

const at = (m: number, s = 0) => new Date(T0.getTime() + minutes(m) + s * 1000);

describe('alert-scheduler-due', () => {
    it('enqueues one alertRuleEvaluate job per due rule per interval slot', () =>
        withHarness(async (h) => {
            const everyMinute = await h.createRule({ name: 'every minute' });
            const everyFive = await h.createRule({
                name: 'every five',
                interval: '5m',
            });
            await h.createRule({ name: 'paused', paused: true });
            const due = async (when: Date) => {
                h.clock.set(when);
                const { enqueued } = await h.module.scheduler.tick();
                return enqueued.map((e: any) => e.ruleUuid).sort();
            };
            expect(await due(at(0))).toEqual(
                [everyMinute.uuid, everyFive.uuid].sort(),
            );
            const job = h.jobLog.find(
                (j) => j.payload.ruleUuid === everyMinute.uuid,
            );
            expect(job).toMatchObject({
                taskName: 'alertRuleEvaluate',
                payload: {
                    ruleUuid: everyMinute.uuid,
                    scheduledAt: at(0).toISOString(),
                },
            });
            expect(job!.jobKey).toContain(everyMinute.uuid);
            expect(await due(at(0, 30))).toEqual([]);
            expect(await due(at(1))).toEqual([everyMinute.uuid]);
            expect(await due(at(2, 15))).toEqual([everyMinute.uuid]);
            expect(await due(at(5))).toEqual(
                [everyMinute.uuid, everyFive.uuid].sort(),
            );

            h.clock.set(at(6));
            const other = h.createModule();
            const results = await Promise.all([
                h.module.scheduler.tick(),
                other.scheduler.tick(),
            ]);
            const slot = h.jobLog.filter(
                (j) =>
                    j.taskName === 'alertRuleEvaluate' &&
                    j.payload.scheduledAt === at(6).toISOString(),
            );
            expect(slot.length).toBeGreaterThan(0);
            expect(new Set(slot.map((j) => j.jobKey)).size).toBe(1);
            expect(
                results
                    .flatMap((r: any) => r.enqueued)
                    .every((e: any) => e.ruleUuid === everyMinute.uuid),
            ).toBe(true);
            await other.close?.();
        }));
});

describe('alert-eval-concurrency', () => {
    it('evaluates a rule once per tick across workers', () =>
        withHarness(async (h) => {
            const rule = await h.createRule();
            h.warehouse.respond(async () => {
                await new Promise((r) => {
                    setTimeout(r, 300);
                });
                return disk({ 'db-1': 95 });
            });
            const workerB = h.createModule();
            const outcomes = await Promise.all([
                h.module.evaluator.evaluateRule(rule.uuid, { scheduledAt: T0 }),
                workerB.evaluator.evaluateRule(rule.uuid, { scheduledAt: T0 }),
            ]);
            expect(outcomes.map((o: any) => o.status).sort()).toEqual([
                'evaluated',
                'skipped',
            ]);
            expect(h.warehouse.calls).toHaveLength(1);
            expect(
                (
                    await workerB.evaluator.evaluateRule(rule.uuid, {
                        scheduledAt: T0,
                    })
                ).status,
            ).toBe('skipped');
            expect(h.warehouse.calls).toHaveLength(1);
            h.clock.set(at(1));
            expect(
                (
                    await workerB.evaluator.evaluateRule(rule.uuid, {
                        scheduledAt: at(1),
                    })
                ).status,
            ).toBe('evaluated');
            expect(h.warehouse.calls).toHaveLength(2);
            const firing = (await h.getRule(rule.uuid)).instances.filter(
                (i: any) => i.state === 'firing',
            );
            expect(firing).toHaveLength(1);
            await workerB.close?.();
        }));
});

describe('alert-eval-overrun', () => {
    it('skips a tick while the previous evaluation is still running, and records the skip', () =>
        withHarness(async (h) => {
            const rule = await h.createRule();
            let release!: () => void;
            const gate = new Promise<void>((r) => {
                release = r;
            });
            h.warehouse.respond(async () => {
                if (h.warehouse.calls.length === 1) await gate;
                return disk({ 'db-1': 95 });
            });
            const first = h.module.evaluator.evaluateRule(rule.uuid, {
                scheduledAt: T0,
            });
            await waitFor(() => h.warehouse.calls.length === 1);
            h.clock.set(at(1));
            const other = h.createModule();
            const skipped = await other.evaluator.evaluateRule(rule.uuid, {
                scheduledAt: at(1),
            });
            expect(skipped).toMatchObject({
                status: 'skipped',
                reason: 'overrun',
            });
            expect(h.warehouse.calls).toHaveLength(1);
            release();
            expect((await first).status).toBe('evaluated');
            const history = await h.ok(
                h.api('viewer').get(`/rules/${rule.uuid}/history`),
            );
            const skip = history.find(
                (e: any) => e.type === 'evaluation_skipped',
            );
            expect(skip).toMatchObject({
                ruleUuid: rule.uuid,
                reason: 'overrun',
            });
            expect(new Date(skip.at).toISOString()).toBe(at(1).toISOString());
            h.clock.set(at(2));
            expect(
                (
                    await other.evaluator.evaluateRule(rule.uuid, {
                        scheduledAt: at(2),
                    })
                ).status,
            ).toBe('evaluated');
            await other.close?.();
        }));
});

const backendSrc = path.resolve(__dirname, '../..');
const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory())
            return [
                'node_modules',
                '__acceptance__',
                'alerting',
                'generated',
                'ee',
            ].includes(name)
                ? []
                : sourceFiles(full);
        return /\.ts$/.test(name) && !/\.(test|spec|mock)\.ts$/.test(name)
            ? [full]
            : [];
    });

describe('alert-worker-wiring', () => {
    it('runs the alerting tasks in the scheduler worker and mounts the API', () =>
        withHarness(async (h) => {
            const rule = await h.createRule();
            h.warehouse.rows(disk({ 'db-1': 95 }));
            await h.module.taskHandlers.alertRuleEvaluate({
                ruleUuid: rule.uuid,
                scheduledAt: T0.toISOString(),
            });
            expect(
                (await h.instance(rule.uuid, { instance: 'db-1' })).state,
            ).toBe('firing');

            h.clock.set(at(1));
            await h.module.taskHandlers.alertingTick({});
            expect(
                h.jobLog.some(
                    (j) =>
                        j.taskName === 'alertRuleEvaluate' &&
                        j.payload.scheduledAt === at(1).toISOString(),
                ),
            ).toBe(true);
            const next = h.jobLog.filter((j) => j.taskName === 'alertingTick');
            expect(next.at(-1)).toMatchObject({ jobKey: 'alerting-tick' });
            expect(new Date(next.at(-1)!.runAt!).toISOString()).toBe(
                at(1, 15).toISOString(),
            );

            const { SchedulerWorker } =
                await import('../../scheduler/SchedulerWorker');
            const { lightdashConfigMock } =
                await import('../../config/lightdashConfig.mock');
            class Probe extends (SchedulerWorker as any) {
                tasks() {
                    return (this as any).getFullTaskList();
                }
            }
            const worker = new Probe({
                lightdashConfig: lightdashConfigMock,
                alertingModule: h.module,
            } as any);
            const tasks = worker.tasks();
            expect(typeof tasks.alertingTick).toBe('function');
            expect(typeof tasks.alertRuleEvaluate).toBe('function');
            h.clock.set(at(2));
            const calls = h.warehouse.calls.length;
            await tasks.alertRuleEvaluate(
                {
                    ruleUuid: rule.uuid,
                    scheduledAt: at(2).toISOString(),
                    organizationUuid: h.organizationUuid,
                    projectUuid: h.projectUuid,
                },
                {} as any,
            );
            expect(h.warehouse.calls.length).toBe(calls + 1);

            const sources = sourceFiles(backendSrc).map((f) =>
                readFileSync(f, 'utf8'),
            );
            expect(
                sources.some((s) => s.includes('createAlertingModule(')),
            ).toBe(true);
            expect(
                sources.some((s) => s.includes('createAlertingRouter(')),
            ).toBe(true);
        }));
});

describe('alert-cycle-heartbeat', () => {
    it('records a heartbeat and POSTs the heartbeat URL after each cycle, even when it fails', async () => {
        const beat = await new MockHttp().start();
        try {
            await withHarness(
                async (h) => {
                    h.warehouse.rows(disk({ 'db-1': 10 }));
                    await h.createRule();
                    await h.module.scheduler.tick();
                    expect(
                        beat.requests.map((r) => [r.method, r.path]),
                    ).toEqual([['POST', '/heartbeat']]);
                    const [{ count }] = await h
                        .db('alert_evaluator_heartbeats')
                        .count('* as count');
                    expect(Number(count)).toBeGreaterThanOrEqual(1);
                    beat.statuses(500);
                    h.clock.set(at(1));
                    await expect(
                        h.module.scheduler.tick(),
                    ).resolves.toBeDefined();
                    expect(beat.requests.length).toBeGreaterThanOrEqual(2);
                    const [{ count: after }] = await h
                        .db('alert_evaluator_heartbeats')
                        .count('* as count');
                    expect(Number(after)).toBeGreaterThan(Number(count));
                },
                { heartbeat: { url: `${beat.url}/heartbeat`, method: 'POST' } },
            );
            const before = beat.requests.length;
            await withHarness(async (h) => {
                await h.module.scheduler.tick();
            });
            expect(beat.requests.length).toBe(before);
        } finally {
            await beat.stop();
        }
    });
    it('supports GET heartbeats', async () => {
        const beat = await new MockHttp().start();
        try {
            await withHarness(
                async (h) => {
                    await h.module.scheduler.tick();
                    expect(
                        beat.requests.map((r) => [r.method, r.path]),
                    ).toEqual([['GET', '/ping?source=lightdash']]);
                },
                {
                    heartbeat: {
                        url: `${beat.url}/ping?source=lightdash`,
                        method: 'GET',
                    },
                },
            );
        } finally {
            await beat.stop();
        }
    });
});

describe('alert-health', () => {
    it('reports evaluator lag at /api/v1/alerting/health', () =>
        withHarness(async (h) => {
            const health = async () =>
                await h.ok(h.api(null).get('/api/v1/alerting/health'));
            expect(await health()).toMatchObject({
                status: 'never_run',
                lastCycleAt: null,
            });
            await h.module.scheduler.tick();
            h.clock.set(at(0, 20));
            expect(await health()).toMatchObject({
                status: 'ok',
                lagSeconds: 20,
                lastCycleAt: T0.toISOString(),
            });
            h.clock.set(at(5));
            expect(await health()).toMatchObject({
                status: 'stale',
                lagSeconds: 300,
            });
        }));
});
