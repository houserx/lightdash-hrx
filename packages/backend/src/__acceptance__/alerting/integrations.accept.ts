/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Contact Point integrations: Slack webhook, Slack app, incident.io, email,
// and "send test notification".
import { describe, expect, it } from 'vitest';
import {
    disk,
    minutes,
    T0,
    withHarness,
    type Harness,
} from './support/harness';

const at = (m: number) => new Date(T0.getTime() + minutes(m));
const norm = (s: string) => s.replace(/\\n/g, ' ').replace(/\s+/g, ' ');

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

const routeTo = (h: Harness, contactPoint: string, routes: unknown[] = []) =>
    h.saveRoutes({
        contactPoint,
        groupBy: ['alertname'],
        groupWait: '0s',
        groupInterval: '1m',
        repeatInterval: '1h',
        routes,
    });

describe('alert-contact-slack-webhook', () => {
    it('posts the ported Slack templates by default, and custom templates when set', () =>
        withHarness(async (h) => {
            h.secrets['custom-slack'] = `${h.outbound.url}/slack/custom`;
            await h.createContactPoint({
                name: 'slack-infra-alerts',
                slug: 'slack-infra-alerts',
                integrations: [
                    {
                        type: 'slack_webhook',
                        url: { secretRef: 'slack-infra-alerts-webhook' },
                    },
                ],
            });
            await h.createContactPoint({
                name: 'custom',
                slug: 'custom',
                integrations: [
                    {
                        type: 'slack_webhook',
                        url: { secretRef: 'custom-slack' },
                        title: '{{ .Status }}: {{ len .Alerts }} alert(s)',
                        text: '{{ range .Alerts }}<{{ .Labels.instance }}>{{ end }}',
                    },
                ],
            });
            await routeTo(h, 'slack-infra-alerts', [
                {
                    matchers: [],
                    contactPoint: 'slack-infra-alerts',
                    continue: true,
                },
                { matchers: [], contactPoint: 'custom' },
            ]);
            const rule = await h.createRule();
            await fire(h, rule.uuid, 0);
            const [infra] = h.outbound.to('/slack/infra');
            expect(infra).toBeDefined();
            const body = norm(infra.body);
            expect(body).toContain('1 Disk almost full');
            expect(body).toContain('A database disk is above 90%');
            expect(body).toContain(
                '<https://runbooks.example.test/disk|Runbook>',
            );
            expect(body).not.toContain('{{');
            const [custom] = h.outbound.to('/slack/custom');
            expect(norm(custom.body)).toContain('firing: 1 alert(s)');
            expect(norm(custom.body)).toContain('<db-1>');
        }));
    it('logs a failure naming a missing secret', () =>
        withHarness(async (h) => {
            await h.createContactPoint({
                name: 'broken',
                slug: 'broken',
                integrations: [
                    {
                        type: 'slack_webhook',
                        url: { secretRef: 'missing-secret' },
                    },
                ],
            });
            await routeTo(h, 'broken');
            const rule = await h.createRule();
            await fire(h, rule.uuid, 0);
            const [entry] = await h.ok(
                h.api('viewer').get(`/notifications?rule=${rule.uuid}`),
            );
            expect(entry).toMatchObject({
                status: 'failed',
                integrationType: 'slack_webhook',
            });
            expect(entry.error).toContain('missing-secret');
        }));
});

describe('alert-contact-slack-app', () => {
    it("posts through the organization's Lightdash Slack app", () =>
        withHarness(async (h) => {
            await h.createContactPoint({
                name: 'infra-app',
                slug: 'infra-app',
                integrations: [{ type: 'slack_app', channel: '#infra-alerts' }],
            });
            await routeTo(h, 'infra-app');
            const rule = await h.createRule();
            await fire(h, rule.uuid, 0);
            expect(h.slackPosts).toHaveLength(1);
            expect(h.slackPosts[0]).toMatchObject({
                organizationUuid: h.organizationUuid,
                channel: '#infra-alerts',
            });
            expect(norm(h.slackPosts[0].text)).toContain('1 Disk almost full');
            h.slackApp.installed = false;
            const other = await h.createRule({
                name: 'CPU high',
                annotations: { summary: 'CPU high' },
            });
            await fire(h, other.uuid, 1);
            const [entry] = await h.ok(
                h.api('viewer').get(`/notifications?rule=${other.uuid}`),
            );
            expect(entry).toMatchObject({
                status: 'failed',
                integrationType: 'slack_app',
            });
            expect(entry.error).toMatch(/not installed/i);
        }));
});

describe('alert-contact-incident-io', () => {
    it('sends Alertmanager v4 payloads with a bearer token from a secret', () =>
        withHarness(async (h) => {
            await h.createContactPoint({
                name: 'Grafana Alerts (incident.io)',
                slug: 'incident-io',
                integrations: [
                    {
                        type: 'incident_io',
                        url: `${h.outbound.url}/incident`,
                        token: { secretRef: 'incident-io-grafana' },
                    },
                ],
            });
            await routeTo(h, 'incident-io');
            const rule = await h.createRule();
            await fire(h, rule.uuid, 0);
            await fire(h, rule.uuid, 2, { 'db-1': 10 });
            const sent = h.outbound.to('/incident');
            expect(sent).toHaveLength(2);
            for (const r of sent) {
                expect(r.method).toBe('POST');
                expect(r.headers.authorization).toBe(
                    'Bearer test-secret-not-real',
                );
                expect(r.headers['content-type']).toContain('application/json');
                expect(r.json.version).toBe('4');
            }
            expect(sent[0].json.status).toBe('firing');
            expect(sent[1].json.status).toBe('resolved');
            expect(sent[0].json.alerts[0].fingerprint).toBe(
                sent[1].json.alerts[0].fingerprint,
            );
            expect(sent[1].json.alerts[0].endsAt).not.toBe(
                '0001-01-01T00:00:00Z',
            );
        }));
});

describe('alert-contact-email', () => {
    it("sends through Lightdash's email client", () =>
        withHarness(async (h) => {
            await h.createContactPoint({
                name: 'oncall-email',
                slug: 'oncall-email',
                integrations: [
                    {
                        type: 'email',
                        addresses: ['oncall@example.test', 'dba@example.test'],
                    },
                ],
            });
            await routeTo(h, 'oncall-email');
            const rule = await h.createRule();
            await fire(h, rule.uuid, 0);
            expect(h.emails).toHaveLength(1);
            expect([...h.emails[0].to].sort()).toEqual([
                'dba@example.test',
                'oncall@example.test',
            ]);
            expect(h.emails[0].subject).toContain('Disk almost full');
            expect(
                `${h.emails[0].text ?? ''} ${h.emails[0].html ?? ''}`,
            ).toContain('A database disk is above 90%');
            const [entry] = await h.ok(
                h.api('viewer').get(`/notifications?rule=${rule.uuid}`),
            );
            expect(entry).toMatchObject({
                status: 'sent',
                integrationType: 'email',
            });
        }));
});

describe('alert-contact-test-notification', () => {
    it('sends a synthetic TestAlert through every integration and reports the outcome', () =>
        withHarness(async (h) => {
            const cp = await h.createContactPoint({
                name: 'both',
                slug: 'both',
                integrations: [
                    { type: 'webhook', url: `${h.outbound.url}/hooks/test` },
                    {
                        type: 'slack_webhook',
                        url: { secretRef: 'slack-infra-alerts-webhook' },
                    },
                ],
            });
            const result = await h.ok(
                h.api('developer').post(`/contact-points/${cp.uuid}/test`),
            );
            expect(result.ok).toBe(true);
            expect(result.results).toEqual([
                expect.objectContaining({ type: 'webhook', ok: true }),
                expect.objectContaining({ type: 'slack_webhook', ok: true }),
            ]);
            const [hook] = h.outbound.to('/hooks/test');
            expect(hook.json.alerts[0].labels.alertname).toBe('TestAlert');
            expect(h.outbound.to('/slack/infra')).toHaveLength(1);

            const broken = await h.createContactPoint({
                name: 'broken',
                slug: 'broken',
                integrations: [
                    { type: 'webhook', url: `${h.outbound.url}/hooks/broken` },
                ],
            });
            h.outbound.handler = (r) => ({
                status: r.path.startsWith('/hooks/broken') ? 500 : 200,
            });
            const failed = await h.ok(
                h.api('developer').post(`/contact-points/${broken.uuid}/test`),
            );
            expect(failed.ok).toBe(false);
            expect(failed.results[0]).toMatchObject({
                type: 'webhook',
                ok: false,
            });
            expect(failed.results[0].error).toMatch(/500/);
            expect(
                (await h.api('viewer').post(`/contact-points/${cp.uuid}/test`))
                    .status,
            ).toBe(403);
            expect(
                (await h.api('editor').post(`/contact-points/${cp.uuid}/test`))
                    .status,
            ).toBe(403);
        }));
});
