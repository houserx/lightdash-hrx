/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Notification Route semantics, mirroring Grafana's documented notification
// policy behaviour (matchers, nested policies, continue, inheritance, default
// policy, grouping). Pure functions exported from @lightdash/common.
import { describe, expect, it } from 'vitest';

const common = async () => (await import('../../index')) as Record<string, any>;

const m = (label: string, operator: string, value: string) => ({
    label,
    operator,
    value,
});

describe('alert-routing-matchers', () => {
    it('supports =, !=, =~ and !~ with anchored regexes', async () => {
        const { matchAlertLabelMatchers: match } = await common();
        const labels = { team: 'frontend', severity: 'critical' };
        expect(match(labels, [m('team', '=', 'frontend')])).toBe(true);
        expect(match(labels, [m('team', '!=', 'frontend')])).toBe(false);
        expect(match(labels, [m('team', '=~', 'front.*')])).toBe(true);
        expect(match(labels, [m('team', '=~', 'front')])).toBe(false);
        expect(match(labels, [m('team', '!~', 'back.*')])).toBe(true);
        expect(match(labels, [m('severity', '=~', 'critical|high')])).toBe(
            true,
        );
        // every matcher must hold
        expect(
            match(labels, [
                m('team', '=', 'frontend'),
                m('severity', '=', 'low'),
            ]),
        ).toBe(false);
        expect(match(labels, [])).toBe(true);
    });
    it('treats a missing label as the empty string', async () => {
        const { matchAlertLabelMatchers: match } = await common();
        expect(match({}, [m('team', '=', '')])).toBe(true);
        expect(match({}, [m('team', '!=', 'infra')])).toBe(true);
        expect(match({}, [m('team', '=~', '.*')])).toBe(true);
        expect(match({}, [m('team', '=~', '.+')])).toBe(false);
        expect(match({}, [m('team', '=', 'infra')])).toBe(false);
    });
});

// The HouseRx tree today (infra grafana_notification_policy.tf), with the
// known routing bugs fixed (ADR 0003): team=Support and team=engineering
// without a channel get explicit routes.
const houserxTree = {
    contactPoint: 'slack-infra-alerts',
    groupBy: ['...'],
    groupWait: '5s',
    groupInterval: '2m',
    repeatInterval: '1h',
    routes: [
        {
            matchers: [m('team', '=', 'test')],
            contactPoint: 'test-alerts',
            continue: true,
            repeatInterval: '1d',
        },
        {
            matchers: [
                m('team', '=', 'engineering'),
                m('channel', '=', '#alerts'),
            ],
            contactPoint: 'slack-alerts',
            continue: true,
            groupInterval: '1m',
            repeatInterval: '1m',
        },
        {
            matchers: [m('team', '=', 'infra')],
            contactPoint: 'incident-io',
            continue: true,
            repeatInterval: '1d',
        },
        {
            matchers: [m('team', '=', 'swat')],
            contactPoint: 'slack-alerts-swat',
            continue: true,
            repeatInterval: '1d',
        },
        {
            matchers: [m('system', '=', 'platform-environment-sweep')],
            contactPoint: 'slack-infra-alerts',
            repeatInterval: '1d',
        },
    ],
};

const nestedTree = {
    contactPoint: 'default-slack',
    routes: [
        {
            matchers: [m('team', '=', 'database')],
            contactPoint: 'db-slack',
            groupWait: '45s',
            routes: [
                {
                    matchers: [m('severity', '=', 'critical')],
                    contactPoint: 'db-pager',
                },
            ],
        },
        {
            matchers: [m('team', '=~', 'front.*')],
            contactPoint: 'frontend',
            continue: true,
        },
        {
            matchers: [m('env', '=', 'prod')],
            contactPoint: 'audit-log',
        },
        {
            matchers: [m('env', '=', 'prod')],
            contactPoint: 'never-reached',
        },
    ],
};

describe('alert-routing-tree', () => {
    it('picks the deepest matching route and inherits settings', async () => {
        const { routeAlert } = await common();
        const routes = routeAlert(nestedTree, {
            team: 'database',
            severity: 'critical',
        });
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({
            contactPoint: 'db-pager',
            groupWait: '45s',
            groupInterval: '5m',
            repeatInterval: '4h',
        });
        // a matching parent with no matching child is used itself
        const parent = routeAlert(nestedTree, {
            team: 'database',
            severity: 'low',
        });
        expect(parent.map((r: any) => r.contactPoint)).toEqual(['db-slack']);
    });
    it('stops at the first match unless continue is set', async () => {
        const { routeAlert } = await common();
        const routes = routeAlert(nestedTree, {
            team: 'frontend',
            env: 'prod',
        });
        expect(routes.map((r: any) => r.contactPoint)).toEqual([
            'frontend',
            'audit-log',
        ]);
        expect(new Set(routes.map((r: any) => r.id)).size).toBe(2);
    });
    it('falls back to the default route with Grafana default timers', async () => {
        const { routeAlert } = await common();
        const routes = routeAlert(nestedTree, { team: 'payments' });
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({
            contactPoint: 'default-slack',
            groupWait: '30s',
            groupInterval: '5m',
            repeatInterval: '4h',
        });
    });
    it('routes the HouseRx tree like Grafana does', async () => {
        const { routeAlert } = await common();
        const cps = (labels: Record<string, string>) =>
            routeAlert(houserxTree, labels).map((r: any) => r.contactPoint);
        expect(cps({ team: 'infra' })).toEqual(['incident-io']);
        expect(cps({ team: 'engineering', channel: '#alerts' })).toEqual([
            'slack-alerts',
        ]);
        expect(cps({ team: 'engineering' })).toEqual(['slack-infra-alerts']);
        expect(cps({ team: 'Support' })).toEqual(['slack-infra-alerts']);
        expect(cps({ system: 'platform-environment-sweep' })).toEqual([
            'slack-infra-alerts',
        ]);
        const infra = routeAlert(houserxTree, { team: 'infra' })[0];
        expect(infra).toMatchObject({
            groupBy: ['...'],
            groupWait: '5s',
            groupInterval: '2m',
            repeatInterval: '1d',
        });
    });
});

describe('alert-routing-grouping', () => {
    it('groups by group_by labels per route', async () => {
        const { routeAlert, alertGroupKey } = await common();
        const tree = { contactPoint: 'ops', groupBy: ['alertname'] };
        const a = { alertname: 'Disk almost full', instance: 'db-1' };
        const b = { alertname: 'Disk almost full', instance: 'db-2' };
        const c = { alertname: 'CPU high', instance: 'db-1' };
        const [route] = routeAlert(tree, a);
        expect(alertGroupKey(route, a)).toBe(alertGroupKey(route, b));
        expect(alertGroupKey(route, a)).not.toBe(alertGroupKey(route, c));
    });
    it("treats '...' as every label and [] as a single group", async () => {
        const { routeAlert, alertGroupKey } = await common();
        const a = { alertname: 'Disk almost full', instance: 'db-1' };
        const b = { alertname: 'Disk almost full', instance: 'db-2' };
        const all = routeAlert({ contactPoint: 'ops', groupBy: ['...'] }, a)[0];
        expect(alertGroupKey(all, a)).not.toBe(alertGroupKey(all, b));
        const none = routeAlert({ contactPoint: 'ops', groupBy: [] }, a)[0];
        expect(alertGroupKey(none, a)).toBe(
            alertGroupKey(none, { alertname: 'CPU high' }),
        );
    });
    it('keeps groups separate per route', async () => {
        const { routeAlert, alertGroupKey } = await common();
        const labels = { team: 'frontend', env: 'prod', alertname: 'x' };
        const routes = routeAlert(nestedTree, labels);
        expect(routes).toHaveLength(2);
        expect(alertGroupKey(routes[0], labels)).not.toBe(
            alertGroupKey(routes[1], labels),
        );
    });
});
