import { describe, expect, it } from 'vitest';
import { type ActiveAlert } from './AlertNotificationModel';
import { alertKey, groupAlerts, isNotificationGroupDue } from './AlertNotifier';

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
});
