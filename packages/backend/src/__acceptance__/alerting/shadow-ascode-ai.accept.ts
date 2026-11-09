/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Shadow Run, as-code upload/download, Managed resources, and the read-only
// API for AI (alert state and history).
import { describe, expect, it } from 'vitest';
import {
    disk,
    minutes,
    T0,
    withHarness,
    type Harness,
} from './support/harness';

const at = (m: number) => new Date(T0.getTime() + minutes(m));

const fire = async (
    h: Harness,
    ruleUuid: string,
    m: number,
    values: Record<string, number> = { 'db-1': 95 },
) => {
    h.clock.set(at(m));
    h.warehouse.rows(disk(values));
    await h.evaluate(ruleUuid, at(m));
    await h.module.notifier.flush();
};

describe('alert-shadow-no-notify', () => {
    it('records would-have-notified entries for shadow rules and sends nothing', () =>
        withHarness(async (h) => {
            await h.createContactPoint({
                name: 'incident-io',
                slug: 'incident-io',
                integrations: [
                    {
                        type: 'incident_io',
                        url: `${h.outbound.url}/incident`,
                        token: { secretRef: 'incident-io-grafana' },
                    },
                ],
            });
            await h.createContactPoint({
                name: 'mail',
                slug: 'mail',
                integrations: [
                    { type: 'email', addresses: ['oncall@example.test'] },
                ],
            });
            await h.createContactPoint({
                name: 'app',
                slug: 'app',
                integrations: [{ type: 'slack_app', channel: '#infra-alerts' }],
            });
            await h.saveRoutes({
                contactPoint: 'incident-io',
                groupWait: '0s',
                groupInterval: '1m',
                routes: [
                    {
                        matchers: [],
                        contactPoint: 'incident-io',
                        continue: true,
                    },
                    { matchers: [], contactPoint: 'mail', continue: true },
                    { matchers: [], contactPoint: 'app' },
                ],
            });
            const rule = await h.createRule({ shadow: true });
            await fire(h, rule.uuid, 0);
            await fire(h, rule.uuid, 2, { 'db-1': 10 });
            expect(h.outbound.requests).toHaveLength(0);
            expect(h.emails).toHaveLength(0);
            expect(h.slackPosts).toHaveLength(0);
            const log = await h.ok(
                h.api('viewer').get(`/notifications?rule=${rule.uuid}`),
            );
            expect(log.every((e: any) => e.status === 'shadow')).toBe(true);
            const statuses = log.map((e: any) => e.alertStatus);
            expect(statuses.filter((s: string) => s === 'firing')).toHaveLength(
                3,
            );
            expect(
                statuses.filter((s: string) => s === 'resolved'),
            ).toHaveLength(3);
            expect((await h.getRule(rule.uuid)).instances[0].state).toBe(
                'resolved',
            );

            await fire(h, rule.uuid, 3, { 'db-1': 10 });
            await h.ok(
                h.api('editor').patch(`/rules/${rule.uuid}`, { shadow: false }),
            );
            await fire(h, rule.uuid, 5);
            expect(h.outbound.to('/incident')).toHaveLength(1);
            expect(h.emails).toHaveLength(1);
            expect(h.slackPosts).toHaveLength(1);
        }));
});

const frame = (events: [string, string, string][]) => ({
    schema: {
        fields: [
            { name: 'time', type: 'time' },
            { name: 'line', type: 'other' },
            { name: 'labels', type: 'other' },
        ],
    },
    data: {
        values: [
            events.map(([iso]) => Date.parse(iso)),
            events.map(([, title, current]) => ({
                schemaVersion: 1,
                previous: current === 'Alerting' ? 'Normal' : 'Alerting',
                current,
                ruleTitle: title,
                ruleUID: title.replace(/\W+/g, '-'),
                labels: { alertname: title },
            })),
            events.map(() => ({})),
        ],
    },
});

describe('alert-shadow-report', () => {
    it("compares the project's shadow notifications with an imported Grafana history", () =>
        withHarness(async (h) => {
            await h.webhookContactPoint('ops');
            await h.routeAllTo('ops', { groupWait: '0s' });
            const pg = await h.createRule({
                name: 'pg_cron job failed',
                shadow: true,
            });
            const alb = await h.createRule({
                name: 'ALB Unhealthy Hosts',
                shadow: true,
            });
            await fire(h, pg.uuid, 0);
            await fire(h, alb.uuid, 0);
            expect(h.outbound.requests).toHaveLength(0);
            const report = await h.ok(
                h.api('viewer').post('/shadow-report', {
                    since: '2026-11-08T00:00:00Z',
                    grafanaHistory: frame([
                        [
                            '2026-11-08T09:01:00Z',
                            'pg_cron job failed',
                            'Alerting',
                        ],
                        [
                            '2026-11-08T09:30:00Z',
                            'Security group changed',
                            'Alerting',
                        ],
                    ]),
                    expectedDifferences: [
                        {
                            ruleName: 'Security group changed',
                            kind: 'missing_in_lightdash',
                            reason: 'slack-sec receives nothing today',
                        },
                    ],
                }),
            );
            expect(report.matched.map((m: any) => m.ruleName)).toEqual([
                'pg_cron job failed',
            ]);
            expect(report.extraInLightdash).toEqual([
                expect.objectContaining({
                    ruleName: 'ALB Unhealthy Hosts',
                    expected: false,
                }),
            ]);
            expect(report.missingInLightdash).toEqual([
                expect.objectContaining({
                    ruleName: 'Security group changed',
                    expected: true,
                    reason: 'slack-sec receives nothing today',
                }),
            ]);
            expect(report.unexpectedCount).toBe(1);
            const malformed = await h.api('viewer').post('/shadow-report', {
                since: '2026-11-08T00:00:00Z',
                grafanaHistory: { foo: 1 },
                expectedDifferences: [],
            });
            expect(malformed.status).toBe(400);
            expect(
                (
                    await h.api('outsider').post('/shadow-report', {
                        since: '2026-11-08T00:00:00Z',
                        grafanaHistory: frame([]),
                        expectedDifferences: [],
                    })
                ).status,
            ).toBe(403);
        }));
});

const contactPointDocs = (h: Harness) => [
    {
        version: 1,
        type: 'contact_point',
        slug: 'incident-io',
        name: 'Grafana Alerts (incident.io)',
        integrations: [
            {
                type: 'incident_io',
                url: `${h.outbound.url}/incident`,
                token: { secretRef: 'incident-io-grafana' },
            },
        ],
    },
    {
        version: 1,
        type: 'contact_point',
        slug: 'slack-infra-alerts',
        name: 'slack-infra-alerts',
        integrations: [
            {
                type: 'slack_webhook',
                url: { secretRef: 'slack-infra-alerts-webhook' },
                title: '{{ template "slack.title" . }}',
                text: '{{ template "slack.message" . }}',
            },
        ],
    },
];
const routesDoc = {
    version: 1,
    type: 'notification_routes',
    contactPoint: 'slack-infra-alerts',
    groupBy: ['...'],
    groupWait: '5s',
    groupInterval: '2m',
    repeatInterval: '1h',
    routes: [
        {
            matchers: [{ label: 'team', operator: '=', value: 'infra' }],
            contactPoint: 'incident-io',
            continue: true,
            repeatInterval: '1d',
        },
    ],
};
const ruleDoc = {
    version: 1,
    type: 'alert_rule',
    slug: 'rds-free-storage-low',
    name: 'RDS free storage low',
    description: 'Pages when an RDS instance has less than 10% free storage',
    spaceSlug: 'platform',
    labels: { team: 'infra', severity: '2' },
    annotations: {
        summary: 'RDS free storage low',
        description: 'Free storage is below 10%',
        runbook_url: 'https://runbooks.example.test/rds',
    },
    query: 'SELECT instance, value FROM rds_free_storage',
    valueColumn: 'value',
    reducer: 'last',
    condition: { operator: '<', threshold: 10 },
    for: '5m',
    keepFiringFor: '0s',
    interval: '1m',
    timeRange: '10m',
    noDataState: 'nodata',
    errorState: 'error',
    paused: false,
    shadow: true,
};
const upload = (
    h: Harness,
    documents: unknown[],
    actor: 'developer' | 'editor' | 'admin' = 'developer',
) => h.api(actor).post('/as-code', { documents });

describe('alert-as-code-upload', () => {
    it('upserts alerting documents by slug and makes them Managed', () =>
        withHarness(async (h) => {
            await h.ok(upload(h, [...contactPointDocs(h), routesDoc, ruleDoc]));
            const cps = await h.ok(h.api('viewer').get('/contact-points'));
            expect(cps.map((c: any) => [c.slug, c.managed]).sort()).toEqual([
                ['incident-io', true],
                ['slack-infra-alerts', true],
            ]);
            expect(
                await h.ok(h.api('viewer').get('/notification-routes')),
            ).toMatchObject({ ...routesDoc, managed: true });
            const [rule] = await h.ok(h.api('viewer').get('/rules'));
            expect(rule).toMatchObject({
                slug: 'rds-free-storage-low',
                managed: true,
                shadow: true,
                spaceUuid: h.spaces.platform.uuid,
                condition: { operator: '<', threshold: 10 },
                version: 1,
            });
            await h.ok(
                upload(h, [
                    { ...ruleDoc, condition: { operator: '<', threshold: 5 } },
                ]),
            );
            const [again] = await h.ok(h.api('viewer').get('/rules'));
            expect(again).toMatchObject({
                uuid: rule.uuid,
                version: 2,
                condition: { operator: '<', threshold: 5 },
            });

            const inline = await upload(h, [
                {
                    ...contactPointDocs(h)[1],
                    slug: 'leaky',
                    integrations: [
                        {
                            type: 'slack_webhook',
                            url: 'https://hooks.slack.com/services/T0/B0/test-secret-not-real',
                        },
                    ],
                },
            ]);
            expect(inline.status).toBe(400);
            expect(JSON.stringify(inline.body)).toMatch(/secretRef/);
            expect(
                await h.ok(h.api('viewer').get('/contact-points')),
            ).toHaveLength(2);
            const badRule = await upload(h, [
                { ...ruleDoc, slug: 'no-description', description: '' },
            ]);
            expect(badRule.status).toBe(400);
            const unknownSpace = await upload(h, [
                { ...ruleDoc, slug: 'nowhere', spaceSlug: 'no-such-space' },
            ]);
            expect(unknownSpace.status).toBe(400);
            expect(
                (await upload(h, [contactPointDocs(h)[0]], 'editor')).status,
            ).toBe(403);
        }));
});

describe('alert-as-code-download', () => {
    it('downloads every alerting resource as documents that round-trip', () =>
        withHarness(async (h) => {
            const { validateAlertingAsCode } =
                (await import('@lightdash/common')) as any;
            await h.ok(upload(h, [...contactPointDocs(h), routesDoc, ruleDoc]));
            await h.createRule({ name: 'UI rule' });
            const { documents } = await h.ok(h.api('viewer').get('/as-code'));
            const ofType = (t: string) =>
                documents.filter((d: any) => d.type === t);
            expect(ofType('contact_point')).toHaveLength(2);
            expect(ofType('notification_routes')).toHaveLength(1);
            expect(ofType('alert_rule')).toHaveLength(2);
            for (const d of documents)
                expect(validateAlertingAsCode(d)).toEqual({
                    valid: true,
                    errors: [],
                });
            expect(
                ofType('alert_rule').find((d: any) => d.slug === ruleDoc.slug),
            ).toEqual(ruleDoc);
            expect(ofType('notification_routes')[0]).toEqual(routesDoc);
            expect(
                ofType('contact_point').find(
                    (d: any) => d.slug === 'incident-io',
                ),
            ).toEqual(contactPointDocs(h)[0]);
            expect(JSON.stringify(documents)).not.toContain(
                'test-secret-not-real',
            );
            await h.ok(upload(h, documents));
            expect(await h.ok(h.api('viewer').get('/rules'))).toHaveLength(2);
            expect((await h.api('outsider').get('/as-code')).status).toBe(403);
        }));
});

describe('alert-managed-readonly', () => {
    it('refuses API edits to Managed resources, even for admins', () =>
        withHarness(async (h) => {
            await h.ok(upload(h, [...contactPointDocs(h), routesDoc, ruleDoc]));
            const [rule] = await h.ok(h.api('viewer').get('/rules'));
            const cp = (await h.ok(h.api('viewer').get('/contact-points')))[0];
            const refused = async (
                p: Promise<{ status: number; body: any }>,
            ) => {
                const r = await p;
                expect(r.status).toBe(403);
                expect(JSON.stringify(r.body)).toMatch(/managed/i);
            };
            await refused(
                h.api('admin').patch(`/rules/${rule.uuid}`, { paused: true }),
            );
            await refused(h.api('admin').delete(`/rules/${rule.uuid}`));
            await refused(
                h
                    .api('admin')
                    .patch(`/contact-points/${cp.uuid}`, { name: 'renamed' }),
            );
            await refused(h.api('admin').delete(`/contact-points/${cp.uuid}`));
            await refused(
                h.api('admin').put('/notification-routes', {
                    contactPoint: 'incident-io',
                }),
            );
            expect(
                (await h.ok(h.api('viewer').get(`/rules/${rule.uuid}`))).paused,
            ).toBe(false);
            await h.ok(upload(h, [{ ...ruleDoc, paused: true }]));
            expect(
                (await h.ok(h.api('viewer').get(`/rules/${rule.uuid}`))).paused,
            ).toBe(true);
            const ui = await h.createRule({ name: 'UI rule' });
            await h.ok(
                h.api('editor').patch(`/rules/${ui.uuid}`, { paused: true }),
            );
        }));
});

describe('alert-ai-state-api', () => {
    it('lists firing and pending instances with labels, annotations and since', () =>
        withHarness(async (h) => {
            const firing = await h.createRule({ name: 'Disk almost full' });
            const pending = await h.createRule({
                name: 'Disk filling',
                for: '5m',
            });
            const quiet = await h.createRule({ name: 'Quiet' });
            await fire(h, firing.uuid, 0);
            await fire(h, pending.uuid, 0, { 'db-2': 95 });
            await fire(h, quiet.uuid, 0, { 'db-3': 10 });
            const res = await h
                .api('viewer')
                .get(`/api/v2/projects/${h.projectUuid}/alerting/state`);
            expect(res.status).toBe(200);
            const { instances } = res.body.results;
            expect(instances).toHaveLength(2);
            const byRule = Object.fromEntries(
                instances.map((i: any) => [i.ruleUuid, i]),
            );
            expect(byRule[firing.uuid]).toMatchObject({
                ruleName: 'Disk almost full',
                state: 'firing',
                value: 95,
                labels: {
                    alertname: 'Disk almost full',
                    instance: 'db-1',
                    team: 'infra',
                },
                annotations: {
                    summary: 'Disk almost full',
                    runbook_url: 'https://runbooks.example.test/disk',
                },
            });
            expect(new Date(byRule[firing.uuid].since).toISOString()).toBe(
                T0.toISOString(),
            );
            expect(byRule[pending.uuid]).toMatchObject({
                state: 'pending',
                labels: { instance: 'db-2' },
            });
            expect(byRule[quiet.uuid]).toBeUndefined();
            expect((await h.api('outsider').get('/state')).status).toBe(403);
            expect((await h.api(null).get('/state')).status).toBe(401);
        }));
});

describe('alert-ai-history-api', () => {
    it('returns state history filtered by rule and time, newest first', () =>
        withHarness(async (h) => {
            const rule = await h.createRule();
            const other = await h.createRule({ name: 'Other' });
            for (const [m, v] of [
                [0, 95],
                [10, 10],
                [11, 10],
                [15, 95],
                [20, 10],
            ] as const)
                await fire(h, rule.uuid, m, { 'db-1': v });
            await fire(h, other.uuid, 16);
            const since = encodeURIComponent('2026-11-08T09:12:00Z');
            const history = await h.ok(
                h
                    .api('viewer')
                    .get(
                        `/api/v2/projects/${h.projectUuid}/alerting/history?rule=${rule.uuid}&since=${since}`,
                    ),
            );
            const transitions = history.filter(
                (e: any) => e.type === 'transition',
            );
            expect(
                transitions.map((e: any) => [
                    e.previousState,
                    e.state,
                    new Date(e.at).toISOString(),
                ]),
            ).toEqual([
                ['firing', 'resolved', at(20).toISOString()],
                ['normal', 'firing', at(15).toISOString()],
            ]);
            expect(transitions[0]).toMatchObject({
                ruleUuid: rule.uuid,
                ruleName: 'Disk almost full',
                labels: { instance: 'db-1' },
            });
            const all = await h.ok(
                h.api('viewer').get(`/history?since=${since}`),
            );
            expect(new Set(all.map((e: any) => e.ruleUuid))).toEqual(
                new Set([rule.uuid, other.uuid]),
            );
            expect((await h.api('outsider').get('/history')).status).toBe(403);
        }));
});
