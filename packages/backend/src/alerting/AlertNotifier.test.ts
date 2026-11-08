import { type NotificationRoute } from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import { type ActiveAlert, type ResolvedAlert } from './AlertNotificationModel';
import {
    alertKey,
    alertStatus,
    groupAlerts,
    isNotificationGroupDue,
    NotificationSendError,
    sendWithRetry,
} from './AlertNotifier';

const T0 = new Date('2026-11-08T09:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const alert = (
    instance: string,
    labels: Record<string, string> = {},
    startsAt: Date = T0,
): ActiveAlert => ({
    projectUuid: 'project',
    ruleUuid: 'rule',
    fingerprint: `fp-${instance}`,
    labels: { alertname: 'Disk almost full', instance, ...labels },
    annotations: {},
    startsAt,
});

const resolved = (instance: string, endsAt: Date): ResolvedAlert => ({
    ...alert(instance),
    endsAt,
});

const route = {
    id: 'root',
    path: [],
    contactPoint: 'ops',
    groupBy: ['alertname'],
    groupWait: '30s',
    groupInterval: '1m',
    repeatInterval: '1h',
};

describe('isNotificationGroupDue', () => {
    it('waits group_wait from the earliest alert of a new group', () => {
        const group = {
            route,
            alerts: [alert('db-2', {}, at(10)), alert('db-1')],
        };
        expect(isNotificationGroupDue(group, undefined, at(29))).toBe(false);
        expect(isNotificationGroupDue(group, undefined, at(30))).toBe(true);
    });

    it('waits group_interval for changes and repeat_interval otherwise', () => {
        const sent = {
            lastSentAt: at(30),
            sentAlerts: { [alertKey(alert('db-1'))]: 'firing' as const },
        };
        const unchanged = { route, alerts: [alert('db-1')] };
        const changed = { route, alerts: [alert('db-1'), alert('db-2')] };
        expect(isNotificationGroupDue(unchanged, sent, at(31))).toBe(false);
        expect(isNotificationGroupDue(unchanged, sent, at(3629))).toBe(false);
        expect(isNotificationGroupDue(unchanged, sent, at(3630))).toBe(true);
        expect(isNotificationGroupDue(changed, sent, at(89))).toBe(false);
        expect(isNotificationGroupDue(changed, sent, at(90))).toBe(true);
    });

    it('counts a resolved alert as a change', () => {
        const sent = {
            lastSentAt: at(30),
            sentAlerts: { [alertKey(alert('db-1'))]: 'firing' as const },
        };
        const group = { route, alerts: [resolved('db-1', at(60))] };
        expect(isNotificationGroupDue(group, sent, at(89))).toBe(false);
        expect(isNotificationGroupDue(group, sent, at(90))).toBe(true);
    });

    it('never sends an empty group', () => {
        expect(
            isNotificationGroupDue({ route, alerts: [] }, undefined, at(60)),
        ).toBe(false);
    });
});

describe('groupAlerts', () => {
    it('groups alerts per route and contact point', () => {
        const groups = groupAlerts(
            'project',
            {
                contactPoint: 'default',
                groupBy: ['alertname'],
                routes: [
                    {
                        matchers: [
                            { label: 'team', operator: '=', value: 'infra' },
                        ],
                        contactPoint: 'infra',
                        continue: true,
                    },
                    {
                        matchers: [
                            { label: 'team', operator: '=', value: 'infra' },
                        ],
                        contactPoint: 'pager',
                    },
                ],
            },
            [
                alert('db-1', { team: 'infra' }),
                alert('db-2', { team: 'infra' }),
                alert('web-1', { team: 'web' }),
            ],
        );
        expect(
            groups.map((group) => [
                group.contactPointSlug,
                group.groupKey,
                group.alerts.map((a) => a.labels.instance),
            ]),
        ).toEqual([
            [
                'infra',
                'root.0:{alertname="Disk almost full"}',
                ['db-1', 'db-2'],
            ],
            [
                'pager',
                'root.1:{alertname="Disk almost full"}',
                ['db-1', 'db-2'],
            ],
            ['default', 'root:{alertname="Disk almost full"}', ['web-1']],
        ]);
    });

    it('splits alerts on one route into a group per group_by value', () => {
        const groups = groupAlerts(
            'project',
            { contactPoint: 'ops', groupBy: ['alertname'] },
            [
                alert('db-1'),
                alert('db-1', { alertname: 'CPU high' }),
                alert('db-2'),
            ],
        );
        expect(
            groups.map((group) => [
                group.groupKey,
                group.alerts.map((a) => a.labels.instance),
            ]),
        ).toEqual([
            ['root:{alertname="Disk almost full"}', ['db-1', 'db-2']],
            ['root:{alertname="CPU high"}', ['db-1']],
        ]);
    });

    it('adds a resolved alert only to groups that sent it as firing', () => {
        const all = [
            { label: 'alertname', operator: '=~' as const, value: '.+' },
        ];
        const tree: NotificationRoute = {
            contactPoint: 'ops',
            groupBy: ['alertname'],
            routes: [
                { matchers: all, contactPoint: 'ops', continue: true },
                { matchers: all, contactPoint: 'pager' },
            ],
        };
        const groups = groupAlerts(
            'project',
            tree,
            [resolved('db-1', at(60)), alert('db-2')],
            (id) =>
                id.includes('"ops"')
                    ? { [alertKey(alert('db-1'))]: 'firing' }
                    : undefined,
        );
        expect(
            groups.map((group) => [
                group.contactPointSlug,
                group.alerts.map(alertStatus),
            ]),
        ).toEqual([
            ['ops', ['resolved', 'firing']],
            ['pager', ['firing']],
        ]);
    });
});

describe('sendWithRetry', () => {
    const policy = { maxAttempts: 3, initialDelayMs: 5 };
    const run = async (outcomes: (Error | null)[]) => {
        const delays: number[] = [];
        let calls = 0;
        const result = await sendWithRetry(
            async () => {
                const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
                calls += 1;
                if (outcome) throw outcome;
            },
            policy,
            async (ms) => {
                delays.push(ms);
            },
        );
        return { ...result, calls, delays };
    };
    const http = (status: number) =>
        new NotificationSendError(`HTTP ${status}`, status >= 500);

    it('succeeds on the first attempt without waiting', async () => {
        expect(await run([null])).toEqual({
            attempts: 1,
            error: null,
            calls: 1,
            delays: [],
        });
    });

    it('retries retryable failures with exponential backoff', async () => {
        expect(await run([http(500), http(503), null])).toEqual({
            attempts: 3,
            error: null,
            calls: 3,
            delays: [5, 10],
        });
    });

    it('gives up after maxAttempts with the last error', async () => {
        expect(await run([http(500), http(502)])).toEqual({
            attempts: 3,
            error: 'HTTP 502',
            calls: 3,
            delays: [5, 10],
        });
    });

    it('treats unknown errors (network) as retryable', async () => {
        const result = await run([new TypeError('fetch failed'), null]);
        expect(result).toMatchObject({ attempts: 2, error: null });
    });

    it('does not retry a non-retryable failure', async () => {
        expect(await run([http(400), null])).toEqual({
            attempts: 1,
            error: 'HTTP 400',
            calls: 1,
            delays: [],
        });
    });

    it('always makes at least one attempt', async () => {
        const result = await sendWithRetry(
            async () => {
                throw http(500);
            },
            { maxAttempts: 0, initialDelayMs: 5 },
            async () => {},
        );
        expect(result).toEqual({ attempts: 1, error: 'HTTP 500' });
    });
});
