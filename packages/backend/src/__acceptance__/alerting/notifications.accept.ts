/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Notification dispatch: group_wait, grouping, group_interval, repeat_interval,
// resolve messages, the route tree, the send log and retries.
import { describe, expect, it } from 'vitest';
import {
    disk,
    minutes,
    T0,
    withHarness,
    type Harness,
} from './support/harness';

const at = (m: number, s = 0) => new Date(T0.getTime() + minutes(m) + s * 1000);

/** Sets the clock, evaluates every given rule with `values`, then flushes. */
const tick = async (
    h: Harness,
    when: Date,
    rules: { uuid: string; values?: Record<string, number> }[] = [],
) => {
    h.clock.set(when);
    for (const rule of rules) {
        if (rule.values) {
            h.warehouse.rows(disk(rule.values));
            await h.evaluate(rule.uuid, when);
        }
    }
    await h.module.notifier.flush();
};

const posts = (h: Harness, slug: string) =>
    h.outbound.to(`/hooks/${slug}`).map((r) => r.json);

describe('alert-notify-firing', () => {
    it('sends a firing series after group_wait as an Alertmanager v4 payload', () =>
        withHarness(async (h) => {
            await h.webhookContactPoint('ops');
            await h.routeAllTo('ops', { groupWait: '30s' });
            const rule = await h.createRule();
            await tick(h, at(0), [{ uuid: rule.uuid, values: { 'db-1': 95 } }]);
            expect(posts(h, 'ops')).toHaveLength(0);
            await tick(h, at(0, 29));
            expect(posts(h, 'ops')).toHaveLength(0);
            await tick(h, at(0, 30));
            const sent = posts(h, 'ops');
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({
                version: '4',
                status: 'firing',
                alerts: [
                    {
                        status: 'firing',
                        labels: {
                            alertname: 'Disk almost full',
                            instance: 'db-1',
                            team: 'infra',
                        },
                        annotations: {
                            summary: 'Disk almost full',
                            runbook_url: 'https://runbooks.example.test/disk',
                        },
                        startsAt: expect.stringMatching(
                            /^2026-11-08T09:00:00(\.000)?Z$/,
                        ),
                        endsAt: '0001-01-01T00:00:00Z',
                    },
                ],
            });
            expect(sent[0].alerts[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
            expect(sent[0].alerts[0].generatorURL).toContain(rule.uuid);
            await tick(h, at(0, 31));
            await tick(h, at(0, 45));
            expect(posts(h, 'ops')).toHaveLength(1);
        }));
});

describe('alert-notify-grouping', () => {
    it('groups by group_by, holds later alerts for group_interval and does not re-send unchanged groups', () =>
        withHarness(async (h) => {
            await h.webhookContactPoint('ops');
            await h.routeAllTo('ops', {
                groupBy: ['alertname'],
                groupWait: '30s',
                groupInterval: '1m',
                repeatInterval: '1h',
            });
            const diskRule = await h.createRule();
            const cpu = await h.createRule({
                name: 'CPU high',
                annotations: { summary: 'CPU high' },
            });
            await tick(h, at(0), [
                { uuid: diskRule.uuid, values: { 'db-1': 95 } },
            ]);
            await tick(h, at(0, 30));
            expect(posts(h, 'ops')).toHaveLength(1);
            await tick(h, at(1, 10), [
                { uuid: diskRule.uuid, values: { 'db-1': 95, 'db-2': 97 } },
            ]);
            expect(posts(h, 'ops')).toHaveLength(1);
            await tick(h, at(1, 30));
            const second = posts(h, 'ops')[1];
            expect(
                second.alerts.map((a: any) => a.labels.instance).sort(),
            ).toEqual(['db-1', 'db-2']);
            expect(second.groupLabels).toEqual({
                alertname: 'Disk almost full',
            });
            await tick(h, at(2), [
                { uuid: diskRule.uuid, values: { 'db-1': 95, 'db-2': 97 } },
            ]);
            await tick(h, at(2, 10));
            expect(posts(h, 'ops')).toHaveLength(2);
            await tick(h, at(2, 20), [
                { uuid: cpu.uuid, values: { 'db-1': 99 } },
            ]);
            await tick(h, at(2, 50));
            const third = posts(h, 'ops')[2];
            expect(third.alerts.map((a: any) => a.labels.alertname)).toEqual([
                'CPU high',
            ]);
            expect(posts(h, 'ops')).toHaveLength(3);
        }));
});

describe('alert-notify-repeat', () => {
    it('re-sends a still-firing group after repeat_interval and not before', () =>
        withHarness(async (h) => {
            await h.webhookContactPoint('ops');
            await h.routeAllTo('ops', {
                groupWait: '30s',
                groupInterval: '1m',
                repeatInterval: '10m',
            });
            const rule = await h.createRule();
            for (let m = 0; m <= 10; m += 1) {
                await tick(h, at(m), [
                    { uuid: rule.uuid, values: { 'db-1': 95 } },
                ]);
                if (m < 10) await tick(h, at(m, 30));
            }
            expect(posts(h, 'ops')).toHaveLength(1);
            await tick(h, at(10, 30));
            expect(posts(h, 'ops')).toHaveLength(2);
            expect(posts(h, 'ops')[1].status).toBe('firing');
        }));
});

describe('alert-notify-resolve', () => {
    it('sends resolved notifications with endsAt unless the integration disables them', () =>
        withHarness(async (h) => {
            await h.webhookContactPoint('a');
            await h.webhookContactPoint('b', { disableResolveMessage: true });
            const infra = [{ label: 'team', operator: '=', value: 'infra' }];
            await h.saveRoutes({
                contactPoint: 'a',
                groupBy: ['alertname'],
                groupWait: '0s',
                groupInterval: '1m',
                repeatInterval: '1h',
                routes: [
                    { matchers: infra, contactPoint: 'a', continue: true },
                    { matchers: infra, contactPoint: 'b' },
                ],
            });
            const rule = await h.createRule();
            await tick(h, at(0), [{ uuid: rule.uuid, values: { 'db-1': 95 } }]);
            expect(posts(h, 'a')).toHaveLength(1);
            expect(posts(h, 'b')).toHaveLength(1);
            await tick(h, at(2), [{ uuid: rule.uuid, values: { 'db-1': 10 } }]);
            await tick(h, at(3));
            const resolved = posts(h, 'a')[1];
            expect(resolved).toMatchObject({ status: 'resolved' });
            expect(resolved.alerts[0]).toMatchObject({
                status: 'resolved',
                labels: { instance: 'db-1' },
            });
            expect(resolved.alerts[0].endsAt).toMatch(
                /^2026-11-08T09:02:00(\.000)?Z$/,
            );
            expect(posts(h, 'b')).toHaveLength(1);
            await tick(h, at(4), [{ uuid: rule.uuid, values: { 'db-1': 10 } }]);
            await tick(h, at(8));
            expect(posts(h, 'a')).toHaveLength(2);
        }));
});

describe('alert-notify-routing', () => {
    it('follows the Notification Route tree, including continue and the default route', () =>
        withHarness(async (h) => {
            for (const slug of ['default-cp', 'infra-cp', 'critical-cp'])
                await h.webhookContactPoint(slug);
            await h.saveRoutes({
                contactPoint: 'default-cp',
                groupBy: ['...'],
                groupWait: '0s',
                routes: [
                    {
                        matchers: [
                            { label: 'team', operator: '=', value: 'infra' },
                        ],
                        contactPoint: 'infra-cp',
                        continue: true,
                    },
                    {
                        matchers: [
                            {
                                label: 'severity',
                                operator: '=~',
                                value: 'critical|high',
                            },
                        ],
                        contactPoint: 'critical-cp',
                    },
                ],
            });
            const critical = await h.createRule({
                name: 'Critical infra',
                labels: { team: 'infra', severity: 'critical' },
            });
            await tick(h, at(0), [
                { uuid: critical.uuid, values: { 'db-1': 95 } },
            ]);
            expect(posts(h, 'infra-cp')).toHaveLength(1);
            expect(posts(h, 'critical-cp')).toHaveLength(1);
            expect(posts(h, 'default-cp')).toHaveLength(0);
            const support = await h.createRule({
                name: 'Support queue',
                labels: { team: 'Support' },
            });
            await tick(h, at(1), [
                { uuid: support.uuid, values: { 'db-1': 95 } },
            ]);
            expect(posts(h, 'default-cp')).toHaveLength(1);
            expect(posts(h, 'default-cp')[0].alerts[0].labels.alertname).toBe(
                'Support queue',
            );
            expect(posts(h, 'infra-cp')).toHaveLength(1);
        }));
});

describe('alert-notifications-log', () => {
    it('logs every notification and lists them per rule and Contact Point', () =>
        withHarness(async (h) => {
            const cp = await h.webhookContactPoint('ops');
            await h.routeAllTo('ops', { groupWait: '0s', groupInterval: '1m' });
            const rule = await h.createRule();
            await tick(h, at(0), [{ uuid: rule.uuid, values: { 'db-1': 95 } }]);
            await tick(h, at(2), [{ uuid: rule.uuid, values: { 'db-1': 10 } }]);
            await tick(h, at(3));
            const log = await h.ok(
                h.api('viewer').get(`/notifications?rule=${rule.uuid}`),
            );
            expect(log.map((e: any) => e.alertStatus)).toEqual([
                'resolved',
                'firing',
            ]);
            expect(log[1]).toMatchObject({
                status: 'sent',
                attempts: 1,
                contactPointUuid: cp.uuid,
                integrationType: 'webhook',
                ruleUuids: [rule.uuid],
                error: null,
            });
            expect(typeof log[1].sentAt).toBe('string');
            expect(
                await h.ok(
                    h
                        .api('viewer')
                        .get(`/notifications?contactPoint=${cp.uuid}`),
                ),
            ).toHaveLength(2);
            expect(
                await h.ok(
                    h
                        .api('viewer')
                        .get(
                            `/notifications?rule=${'00000000-0000-4000-8000-000000000000'}`,
                        ),
                ),
            ).toEqual([]);
            const detail = await h.ok(
                h.api('viewer').get(`/rules/${rule.uuid}/notifications`),
            );
            expect(detail).toHaveLength(2);
            expect((await h.api('outsider').get('/notifications')).status).toBe(
                403,
            );
        }));
});

describe('alert-contact-retries', () => {
    const scenario = (codes: number[]) =>
        withHarness(
            async (h) => {
                await h.webhookContactPoint('ops');
                await h.routeAllTo('ops', { groupWait: '0s' });
                h.outbound.statuses(...codes);
                const rule = await h.createRule();
                await tick(h, at(0), [
                    { uuid: rule.uuid, values: { 'db-1': 95 } },
                ]);
                const [entry] = await h.ok(
                    h.api('viewer').get(`/notifications?rule=${rule.uuid}`),
                );
                return { entry, requests: posts(h, 'ops').length };
            },
            { retry: { maxAttempts: 3, initialDelayMs: 5 } },
        );
    it('retries 5xx with backoff and records the outcome and attempts', async () => {
        const recovered = await scenario([500, 503, 200]);
        expect(recovered.requests).toBe(3);
        expect(recovered.entry).toMatchObject({ status: 'sent', attempts: 3 });
        const failed = await scenario([500]);
        expect(failed.requests).toBe(3);
        expect(failed.entry).toMatchObject({ status: 'failed', attempts: 3 });
        expect(failed.entry.error).toMatch(/500/);
    });
    it('does not retry 4xx', async () => {
        const rejected = await scenario([400]);
        expect(rejected.requests).toBe(1);
        expect(rejected.entry).toMatchObject({ status: 'failed', attempts: 1 });
    });
});
