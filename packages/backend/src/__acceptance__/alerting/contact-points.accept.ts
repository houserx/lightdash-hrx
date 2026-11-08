/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Contact Points and the Notification Route tree over the HTTP API.
import { describe, expect, it } from 'vitest';
import { withHarness } from './support/harness';

const slackAndEmail = {
    name: 'Infra Slack',
    integrations: [
        {
            type: 'slack_webhook',
            url: { secretRef: 'slack-infra-alerts-webhook' },
        },
        { type: 'email', addresses: ['oncall@example.test'] },
    ],
};

describe('alert-contact-points-crud', () => {
    it('manages Contact Points whose secrets are only references', () =>
        withHarness(async (h) => {
            const cp = await h.ok(
                h.api('developer').post('/contact-points', slackAndEmail),
            );
            expect(cp).toMatchObject({
                projectUuid: h.projectUuid,
                slug: 'infra-slack',
                name: 'Infra Slack',
                managed: false,
                integrations: [
                    {
                        type: 'slack_webhook',
                        url: { secretRef: 'slack-infra-alerts-webhook' },
                    },
                    { type: 'email', addresses: ['oncall@example.test'] },
                ],
            });
            const listed = await h.api('developer').get('/contact-points');
            expect(listed.body.results.map((c: any) => c.slug)).toEqual([
                'infra-slack',
            ]);
            expect(JSON.stringify(listed.body)).not.toContain(
                h.secrets['slack-infra-alerts-webhook'],
            );

            const everyType = await h.ok(
                h.api('developer').post('/contact-points', {
                    name: 'Every type',
                    integrations: [
                        {
                            type: 'slack_webhook',
                            url: { secretRef: 'slack-infra-alerts-webhook' },
                            title: '{{ template "slack.title" . }}',
                            text: '{{ template "slack.message" . }}',
                            disableResolveMessage: true,
                        },
                        { type: 'slack_app', channel: '#infra-alerts' },
                        {
                            type: 'incident_io',
                            url: 'https://incident.example.test/v2/alert_events/x',
                            token: { secretRef: 'incident-io-grafana' },
                        },
                        {
                            type: 'email',
                            addresses: ['a@example.test', 'b@example.test'],
                        },
                        {
                            type: 'webhook',
                            url: 'https://hooks.example.test/x',
                            authorization: {
                                secretRef: 'generic-webhook-token',
                            },
                        },
                    ],
                }),
            );
            expect(everyType.integrations).toHaveLength(5);

            const inline = await h.api('developer').post('/contact-points', {
                name: 'Inline',
                integrations: [
                    {
                        type: 'slack_webhook',
                        url: 'https://hooks.slack.com/services/T0/B0/test-secret-not-real',
                    },
                ],
            });
            expect(inline.status).toBe(400);
            expect(JSON.stringify(inline.body)).toMatch(/secretRef/);
            const inlineToken = await h
                .api('developer')
                .post('/contact-points', {
                    name: 'Inline token',
                    integrations: [
                        {
                            type: 'incident_io',
                            url: 'https://incident.example.test/x',
                            token: 'test-secret-not-real',
                        },
                    ],
                });
            expect(inlineToken.status).toBe(400);
            expect(
                (
                    await h.api('developer').post('/contact-points', {
                        name: 'x',
                        integrations: [{ type: 'pagerduty' }],
                    })
                ).status,
            ).toBe(400);
            expect(
                (
                    await h.api('developer').post('/contact-points', {
                        name: 'x',
                        integrations: [],
                    })
                ).status,
            ).toBe(400);
            expect(
                (
                    await h.api('developer').post('/contact-points', {
                        name: 'x',
                        integrations: [
                            { type: 'email', addresses: ['not-an-email'] },
                        ],
                    })
                ).status,
            ).toBe(400);

            const renamed = await h.ok(
                h.api('developer').patch(`/contact-points/${cp.uuid}`, {
                    name: 'Infra Slack (EU)',
                }),
            );
            expect(renamed).toMatchObject({
                uuid: cp.uuid,
                name: 'Infra Slack (EU)',
            });
            expect(
                (
                    await h.ok(
                        h.api('developer').get(`/contact-points/${cp.uuid}`),
                    )
                ).name,
            ).toBe('Infra Slack (EU)');
            expect(
                (await h.api('developer').delete(`/contact-points/${cp.uuid}`))
                    .status,
            ).toBe(200);
            expect(
                (await h.api('developer').get(`/contact-points/${cp.uuid}`))
                    .status,
            ).toBe(404);
        }));
});

const webhook = (slug: string) => ({
    name: slug,
    slug,
    integrations: [
        { type: 'webhook', url: `https://hooks.example.test/${slug}` },
    ],
});

const tree = {
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
                    groupWait: '1s',
                },
            ],
        },
        {
            matchers: [{ label: 'team', operator: '!=', value: 'infra' }],
            contactPoint: 'slack-infra-alerts',
        },
    ],
};

describe('alert-notification-routes-crud', () => {
    it('saves and reads one Notification Route tree per project, validated against Contact Points', () =>
        withHarness(async (h) => {
            expect(
                await h.ok(h.api('developer').get('/notification-routes')),
            ).toBeNull();
            await h.ok(
                h
                    .api('developer')
                    .post('/contact-points', webhook('slack-infra-alerts')),
            );
            const incident = await h.ok(
                h
                    .api('developer')
                    .post('/contact-points', webhook('incident-io')),
            );
            const saved = await h.ok(
                h.api('developer').put('/notification-routes', tree),
            );
            expect(saved).toMatchObject({ ...tree, managed: false });
            expect(
                await h.ok(h.api('viewer').get('/notification-routes')),
            ).toMatchObject(tree);

            const unknown = await h
                .api('developer')
                .put('/notification-routes', { ...tree, contactPoint: 'nope' });
            expect(unknown.status).toBe(400);
            expect(JSON.stringify(unknown.body)).toMatch(/nope/);
            const nestedUnknown = await h
                .api('developer')
                .put('/notification-routes', {
                    contactPoint: 'incident-io',
                    routes: [
                        {
                            matchers: [],
                            routes: [{ matchers: [], contactPoint: 'ghost' }],
                        },
                    ],
                });
            expect(nestedUnknown.status).toBe(400);
            const badOperator = await h
                .api('developer')
                .put('/notification-routes', {
                    contactPoint: 'incident-io',
                    routes: [
                        {
                            matchers: [
                                { label: 'team', operator: '~', value: 'x' },
                            ],
                        },
                    ],
                });
            expect(badOperator.status).toBe(400);
            const badRegex = await h
                .api('developer')
                .put('/notification-routes', {
                    contactPoint: 'incident-io',
                    routes: [
                        {
                            matchers: [
                                { label: 'team', operator: '=~', value: '(' },
                            ],
                        },
                    ],
                });
            expect(badRegex.status).toBe(400);
            const badTimer = await h
                .api('developer')
                .put('/notification-routes', { ...tree, groupWait: 'later' });
            expect(badTimer.status).toBe(400);
            expect(
                await h.ok(h.api('viewer').get('/notification-routes')),
            ).toMatchObject(tree);

            const inUse = await h
                .api('developer')
                .delete(`/contact-points/${incident.uuid}`);
            expect([400, 409]).toContain(inUse.status);
            expect(
                (
                    await h
                        .api('developer')
                        .get(`/contact-points/${incident.uuid}`)
                ).status,
            ).toBe(200);
        }));
});

describe('alert-contact-points-routes-permissions', () => {
    it('lets viewers and editors read, and only developers and admins change', () =>
        withHarness(async (h) => {
            const cp = await h.ok(
                h.api('developer').post('/contact-points', webhook('ops')),
            );
            await h.ok(
                h
                    .api('developer')
                    .put('/notification-routes', { contactPoint: 'ops' }),
            );
            for (const reader of ['viewer', 'editor'] as const) {
                expect(
                    (await h.api(reader).get('/contact-points')).status,
                ).toBe(200);
                expect(
                    (await h.api(reader).get(`/contact-points/${cp.uuid}`))
                        .status,
                ).toBe(200);
                expect(
                    (await h.api(reader).get('/notification-routes')).status,
                ).toBe(200);
                expect(
                    (
                        await h
                            .api(reader)
                            .post('/contact-points', webhook(`by-${reader}`))
                    ).status,
                ).toBe(403);
                expect(
                    (
                        await h
                            .api(reader)
                            .patch(`/contact-points/${cp.uuid}`, { name: 'x' })
                    ).status,
                ).toBe(403);
                expect(
                    (await h.api(reader).delete(`/contact-points/${cp.uuid}`))
                        .status,
                ).toBe(403);
                expect(
                    (
                        await h.api(reader).put('/notification-routes', {
                            contactPoint: 'ops',
                            groupWait: '1s',
                        })
                    ).status,
                ).toBe(403);
            }
            await h.ok(
                h
                    .api('developer')
                    .patch(`/contact-points/${cp.uuid}`, { name: 'Ops pager' }),
            );
            await h.ok(
                h.api('admin').put('/notification-routes', {
                    contactPoint: 'ops',
                    groupWait: '10s',
                }),
            );
            expect(
                (await h.api('outsider').get('/contact-points')).status,
            ).toBe(403);
            expect(
                (await h.api('outsider').get('/notification-routes')).status,
            ).toBe(403);
            expect((await h.api(null).get('/contact-points')).status).toBe(401);
        }));
});
