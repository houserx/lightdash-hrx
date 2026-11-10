import addFormats from 'ajv-formats';
/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// As-code JSON schemas, the Shadow Run comparison, and the permission scopes.
import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const common = async () => (await import('../../index')) as Record<string, any>;
const schemaDir = path.resolve(__dirname, '../../schemas/json');

export const ruleDoc = {
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
        runbook_url: 'https://runbooks.example.test/rds-storage',
    },
    query: "SELECT timestamp, value, labels FROM promql('rds_free_storage_pct', '${ld.parameters.__from}', '${ld.parameters.__to}', '${ld.parameters.__interval}')",
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

export const contactPointDoc = {
    version: 1,
    type: 'contact_point',
    slug: 'incident-io',
    name: 'Grafana Alerts (incident.io)',
    integrations: [
        {
            type: 'incident_io',
            url: 'https://incident.example.test/v2/alert_events/grafana/x',
            token: { secretRef: 'incident-io-grafana' },
        },
        {
            type: 'slack_webhook',
            url: { secretRef: 'slack-infra-alerts-webhook' },
            title: '{{ template "slack.title" . }}',
            text: '{{ template "slack.message" . }}',
            disableResolveMessage: false,
        },
        { type: 'slack_app', channel: '#infra-alerts' },
        { type: 'email', addresses: ['oncall@example.test'] },
        {
            type: 'webhook',
            url: 'https://hooks.example.test/alerts',
            authorization: { secretRef: 'generic-webhook-token' },
        },
    ],
};

export const routesDoc = {
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
            routes: [
                {
                    matchers: [
                        { label: 'severity', operator: '=~', value: '1|2' },
                    ],
                    contactPoint: 'incident-io',
                },
            ],
        },
    ],
};

const compile = (file: string) => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    return ajv.compile(
        JSON.parse(readFileSync(path.join(schemaDir, file), 'utf8')),
    );
};

describe('alert-as-code-schemas', () => {
    it('ships JSON schemas that accept well-formed documents', () => {
        expect(compile('alert-rule-as-code-1.0.json')(ruleDoc)).toBe(true);
        expect(compile('contact-point-as-code-1.0.json')(contactPointDoc)).toBe(
            true,
        );
        expect(compile('notification-routes-as-code-1.0.json')(routesDoc)).toBe(
            true,
        );
    });
    it('rejects bad documents and inline secrets', () => {
        const rule = compile('alert-rule-as-code-1.0.json');
        const { description: _d, ...noDescription } = ruleDoc;
        expect(rule(noDescription)).toBe(false);
        expect(rule({ ...ruleDoc, description: '' })).toBe(false);
        expect(rule({ ...ruleDoc, reducer: 'median' })).toBe(false);
        expect(rule({ ...ruleDoc, noDataState: 'ok' })).toBe(false);
        const cp = compile('contact-point-as-code-1.0.json');
        expect(
            cp({
                ...contactPointDoc,
                integrations: [
                    {
                        type: 'slack_webhook',
                        url: 'https://hooks.slack.com/services/T0/B0/test-secret-not-real',
                    },
                ],
            }),
        ).toBe(false);
        expect(
            cp({
                ...contactPointDoc,
                integrations: [
                    {
                        type: 'incident_io',
                        url: 'https://x.test',
                        token: 'test-secret-not-real',
                    },
                ],
            }),
        ).toBe(false);
        const routes = compile('notification-routes-as-code-1.0.json');
        expect(
            routes({
                ...routesDoc,
                routes: [
                    {
                        matchers: [
                            { label: 'team', operator: '~', value: 'x' },
                        ],
                    },
                ],
            }),
        ).toBe(false);
    });
    it('validates any alerting document by its type', async () => {
        const { validateAlertingAsCode } = await common();
        expect(validateAlertingAsCode(ruleDoc)).toEqual({
            valid: true,
            errors: [],
        });
        expect(validateAlertingAsCode(contactPointDoc).valid).toBe(true);
        expect(validateAlertingAsCode(routesDoc).valid).toBe(true);
        const bad = validateAlertingAsCode({
            ...ruleDoc,
            description: undefined,
        });
        expect(bad.valid).toBe(false);
        expect(bad.errors.join('\n')).toMatch(/description/);
        const secret = validateAlertingAsCode({
            ...contactPointDoc,
            integrations: [
                {
                    type: 'slack_webhook',
                    url: 'https://hooks.slack.com/services/T0/B0/test-secret-not-real',
                },
            ],
        });
        expect(secret.valid).toBe(false);
        expect(secret.errors.join('\n')).toMatch(/secretRef/);
        expect(
            validateAlertingAsCode({ version: 1, type: 'chart' }).valid,
        ).toBe(false);
    });
});

const t = (iso: string) => Date.parse(iso);
const line = (ruleTitle: string, previous: string, current: string) => ({
    schemaVersion: 1,
    previous,
    current,
    ruleTitle,
    ruleUID: `uid-${ruleTitle.length}`,
    labels: { alertname: ruleTitle },
});
export const grafanaHistory = {
    schema: {
        fields: [
            { name: 'time', type: 'time' },
            { name: 'line', type: 'other' },
            { name: 'labels', type: 'other' },
        ],
    },
    data: {
        values: [
            [
                t('2026-11-08T09:00:00Z'),
                t('2026-11-08T09:20:00Z'),
                t('2026-11-08T09:30:00Z'),
                t('2026-11-08T10:00:00Z'),
                t('2026-11-07T10:00:00Z'),
            ],
            [
                line('pg_cron job failed', 'Normal', 'Alerting'),
                line('pg_cron job failed', 'Alerting', 'Normal'),
                line('ALB Unhealthy Hosts', 'Normal', 'Alerting'),
                line('Security group changed', 'Normal', 'Alerting'),
                line('Old rule', 'Normal', 'Alerting'),
            ],
            [{}, {}, {}, {}, {}],
        ],
    },
};

describe('alert-shadow-compare', () => {
    it('matches shadow firings with Grafana history and classifies differences', async () => {
        const { compareShadowRun } = await common();
        const report = compareShadowRun({
            since: '2026-11-08T00:00:00Z',
            shadow: [
                {
                    ruleName: 'pg_cron job failed',
                    labels: {},
                    status: 'firing',
                    at: '2026-11-08T09:03:00Z',
                },
                {
                    ruleName: 'pg_cron job failed',
                    labels: {},
                    status: 'resolved',
                    at: '2026-11-08T09:21:00Z',
                },
                {
                    ruleName: 'Support queue stuck',
                    labels: {},
                    status: 'firing',
                    at: '2026-11-08T11:00:00Z',
                },
                {
                    ruleName: 'Disk almost full',
                    labels: {},
                    status: 'firing',
                    at: '2026-11-08T12:00:00Z',
                },
            ],
            grafanaHistory,
            expectedDifferences: [
                {
                    ruleName: 'Security group changed',
                    kind: 'missing_in_lightdash',
                    reason: 'slack-sec receives nothing today',
                },
                {
                    ruleName: 'Support queue stuck',
                    kind: 'extra_in_lightdash',
                    reason: 'team=Support now routed',
                },
            ],
        });
        expect(report.matched).toEqual([
            expect.objectContaining({ ruleName: 'pg_cron job failed' }),
        ]);
        const missing = Object.fromEntries(
            report.missingInLightdash.map((f: any) => [f.ruleName, f]),
        );
        expect(Object.keys(missing).sort()).toEqual([
            'ALB Unhealthy Hosts',
            'Security group changed',
        ]);
        expect(missing['ALB Unhealthy Hosts'].expected).toBe(false);
        expect(missing['Security group changed']).toMatchObject({
            expected: true,
            reason: 'slack-sec receives nothing today',
        });
        const extra = Object.fromEntries(
            report.extraInLightdash.map((f: any) => [f.ruleName, f]),
        );
        expect(Object.keys(extra).sort()).toEqual([
            'Disk almost full',
            'Support queue stuck',
        ]);
        expect(extra['Support queue stuck'].expected).toBe(true);
        expect(report.unexpectedCount).toBe(2);
    });
    it('respects the matching tolerance', async () => {
        const { compareShadowRun } = await common();
        const report = compareShadowRun({
            since: '2026-11-08T00:00:00Z',
            shadow: [
                {
                    ruleName: 'ALB Unhealthy Hosts',
                    labels: {},
                    status: 'firing',
                    at: '2026-11-08T09:50:00Z',
                },
            ],
            grafanaHistory,
            expectedDifferences: [],
            toleranceMs: 60_000,
        });
        expect(report.matched).toEqual([]);
        expect(report.extraInLightdash.map((f: any) => f.ruleName)).toEqual([
            'ALB Unhealthy Hosts',
        ]);
    });
});

describe('alert-permissions-scopes', () => {
    const projectUuid = 'p-0000-alerting';
    const organizationUuid = 'o-0000-alerting';
    const abilityFor = async (role: string) => {
        const { defineUserAbility } = await common();
        return defineUserAbility(
            {
                role: 'member',
                organizationUuid,
                userUuid: `u-${role}`,
                roleUuid: undefined,
            },
            [{ projectUuid, role, userUuid: `u-${role}` }],
        );
    };
    const can = async (role: string, action: string, subjectName: string) => {
        const { subject } = await import('@casl/ability');
        const ability = await abilityFor(role);
        return ability.can(
            action,
            subject(subjectName, { organizationUuid, projectUuid }),
        );
    };
    it('adds view and manage scopes for the three alerting subjects', async () => {
        const { getScopes, getAllScopesForRole } = await common();
        const names = getScopes().map((s: any) => s.name);
        for (const n of [
            'view:AlertRule',
            'manage:AlertRule',
            'view:ContactPoint',
            'manage:ContactPoint',
            'view:NotificationRoute',
            'manage:NotificationRoute',
        ])
            expect(names).toContain(n);
        expect(getAllScopesForRole('viewer')).toEqual(
            expect.arrayContaining([
                'view:AlertRule',
                'view:ContactPoint',
                'view:NotificationRoute',
            ]),
        );
        expect(getAllScopesForRole('viewer')).not.toContain('manage:AlertRule');
        expect(getAllScopesForRole('editor')).toContain('manage:AlertRule');
        expect(getAllScopesForRole('editor')).not.toContain(
            'manage:ContactPoint',
        );
        expect(getAllScopesForRole('developer')).toEqual(
            expect.arrayContaining([
                'manage:AlertRule',
                'manage:ContactPoint',
                'manage:NotificationRoute',
            ]),
        );
    });
    it('grants abilities by project role', async () => {
        for (const s of ['AlertRule', 'ContactPoint', 'NotificationRoute']) {
            expect(await can('viewer', 'view', s)).toBe(true);
            expect(await can('viewer', 'manage', s)).toBe(false);
            expect(await can('developer', 'manage', s)).toBe(true);
            expect(await can('admin', 'manage', s)).toBe(true);
        }
        expect(await can('editor', 'manage', 'AlertRule')).toBe(true);
        expect(await can('editor', 'manage', 'ContactPoint')).toBe(false);
        expect(await can('editor', 'manage', 'NotificationRoute')).toBe(false);
        expect(await can('editor', 'view', 'ContactPoint')).toBe(true);
    });
});
