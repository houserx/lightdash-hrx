/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Contact Points list/editor, Notification Routes tree editor, the API
// client, and the app routes for the alerting pages.
import { screen, waitFor, within } from '@testing-library/react';
import nock from 'nock';
import { matchRoutes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { load, pick, renderUi, typeInto } from './support';

const contactPoints = [
    {
        uuid: 'cp-incident',
        projectUuid: 'p1',
        slug: 'incident-io',
        name: 'Grafana Alerts (incident.io)',
        managed: true,
        integrations: [
            {
                type: 'incident_io',
                url: 'https://incident.example.test/x',
                token: { secretRef: 'incident-io-grafana' },
            },
        ],
    },
    {
        uuid: 'cp-slack',
        projectUuid: 'p1',
        slug: 'slack-infra-alerts',
        name: 'slack-infra-alerts',
        managed: false,
        integrations: [
            {
                type: 'slack_webhook',
                url: { secretRef: 'slack-infra-alerts-webhook' },
            },
        ],
    },
];

describe('alert-ui-contact-points', () => {
    it('lists Contact Points and sends a test notification', async () => {
        const { ContactPointsList } = await load(
            '../../features/alerting/components/ContactPointsList',
        );
        const onSendTest = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                results: [{ type: 'slack_webhook', ok: true }],
            })
            .mockResolvedValueOnce({
                ok: false,
                results: [
                    {
                        type: 'slack_webhook',
                        ok: false,
                        error: 'HTTP 500 from webhook',
                    },
                ],
            });
        const { user } = renderUi(
            <ContactPointsList
                contactPoints={contactPoints as any}
                onSendTest={onSendTest}
                onOpen={vi.fn()}
            />,
        );
        const incident = screen.getByRole('row', {
            name: /Grafana Alerts \(incident\.io\)/,
        });
        expect(
            within(incident).getByText('Managed in git'),
        ).toBeInTheDocument();
        expect(within(incident).getByText(/incident\.io/i)).toBeInTheDocument();
        const slack = screen.getByRole('row', { name: /slack-infra-alerts/ });
        expect(within(slack).getByText(/slack/i)).toBeInTheDocument();
        await user.click(
            within(slack).getByRole('button', {
                name: 'Send test notification',
            }),
        );
        expect(onSendTest).toHaveBeenCalledWith('cp-slack');
        expect(
            await screen.findByText('Test notification sent'),
        ).toBeInTheDocument();
        await user.click(
            within(slack).getByRole('button', {
                name: 'Send test notification',
            }),
        );
        expect(
            await screen.findByText(/HTTP 500 from webhook/),
        ).toBeInTheDocument();
    });
    it('creates a Contact Point with a secret reference, never an inline secret', async () => {
        const { ContactPointEditor } = await load(
            '../../features/alerting/components/ContactPointEditor',
        );
        const onSubmit = vi.fn();
        const { user } = renderUi(<ContactPointEditor onSubmit={onSubmit} />);
        await typeInto(user, 'Name', 'Infra Slack');
        await pick(user, 'Integration type', 'Slack webhook');
        await typeInto(
            user,
            'Webhook URL secret reference',
            'slack-infra-alerts-webhook',
        );
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({
            name: 'Infra Slack',
            integrations: [
                {
                    type: 'slack_webhook',
                    url: { secretRef: 'slack-infra-alerts-webhook' },
                },
            ],
        });
        const { ContactPointEditor: Editor } = await load(
            '../../features/alerting/components/ContactPointEditor',
        );
        renderUi(
            <Editor
                contactPoint={contactPoints[0] as any}
                onSubmit={vi.fn()}
            />,
        );
        expect(screen.getAllByText('Managed in git').length).toBeGreaterThan(0);
    });
});

const tree = {
    contactPoint: 'slack-infra-alerts',
    groupBy: ['...'],
    groupWait: '5s',
    groupInterval: '2m',
    repeatInterval: '1h',
    managed: false,
    routes: [
        {
            matchers: [{ label: 'team', operator: '=', value: 'infra' }],
            contactPoint: 'incident-io',
            continue: true,
        },
    ],
};

describe('alert-ui-routes-editor', () => {
    it('shows the Notification Route tree and adds a route', async () => {
        const { NotificationRoutesEditor } = await load(
            '../../features/alerting/components/NotificationRoutesEditor',
        );
        const onSave = vi.fn();
        const { user } = renderUi(
            <NotificationRoutesEditor
                tree={tree as any}
                contactPoints={contactPoints as any}
                onSave={onSave}
            />,
        );
        expect(screen.getByText('Default route')).toBeInTheDocument();
        expect(screen.getByText('team = infra')).toBeInTheDocument();
        expect(
            screen.getAllByText(/slack-infra-alerts/).length,
        ).toBeGreaterThan(0);
        expect(
            screen.getAllByText(/Grafana Alerts \(incident\.io\)|incident-io/)
                .length,
        ).toBeGreaterThan(0);
        await user.click(screen.getByRole('button', { name: 'Add route' }));
        await typeInto(user, 'Label', 'team');
        await typeInto(user, 'Value', 'swat');
        await pick(user, 'Contact point', 'slack-infra-alerts');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const saved = onSave.mock.calls[0][0];
        expect(saved).toMatchObject({
            contactPoint: 'slack-infra-alerts',
            groupWait: '5s',
        });
        expect(saved.routes).toHaveLength(2);
        expect(saved.routes[0]).toMatchObject(tree.routes[0]);
        expect(saved.routes[1]).toMatchObject({
            matchers: [{ label: 'team', operator: '=', value: 'swat' }],
            contactPoint: 'slack-infra-alerts',
        });
    });
    it('is read-only for a Managed tree', async () => {
        const { NotificationRoutesEditor } = await load(
            '../../features/alerting/components/NotificationRoutesEditor',
        );
        renderUi(
            <NotificationRoutesEditor
                tree={{ ...tree, managed: true } as any}
                contactPoints={contactPoints as any}
                onSave={vi.fn()}
            />,
        );
        expect(screen.getByText('Managed in git')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add route' })).toBeNull();
        const save = screen.queryByRole('button', { name: 'Save' });
        if (save) expect(save).toBeDisabled();
    });
});

const HOST = 'http://test.lightdash';
const base = '/api/v2/projects/p1/alerting';

describe('alert-ui-api-client', () => {
    afterEach(() => nock.cleanAll());
    it('calls the alerting API routes', async () => {
        const api = await load('../../features/alerting/api');
        const ok = (results: unknown) => ({ status: 'ok', results });
        const scope = nock(HOST)
            .get(`${base}/rules`)
            .query({ state: 'firing', label: 'team=infra' })
            .reply(200, ok([{ uuid: 'r1' }]))
            .post(`${base}/rules`, (b) => b.name === 'Disk almost full')
            .reply(200, ok({ uuid: 'r1' }))
            .patch(`${base}/rules/r1`, { paused: true })
            .reply(200, ok({ uuid: 'r1', paused: true }))
            .post(`${base}/rules/preview`)
            .reply(200, ok({ error: null, series: [] }))
            .get(`${base}/rules/r1/history`)
            .reply(200, ok([]))
            .get(`${base}/notifications`)
            .query({ rule: 'r1' })
            .reply(200, ok([]))
            .post(`${base}/contact-points/cp1/test`)
            .reply(200, ok({ ok: true, results: [] }))
            .put(`${base}/notification-routes`, (b) => b.contactPoint === 'ops')
            .reply(200, ok({ contactPoint: 'ops' }));
        expect(
            await api.getAlertRules('p1', {
                state: 'firing',
                label: 'team=infra',
            }),
        ).toEqual([{ uuid: 'r1' }]);
        expect(
            await api.createAlertRule('p1', {
                name: 'Disk almost full',
            } as any),
        ).toEqual({ uuid: 'r1' });
        expect(
            await api.updateAlertRule('p1', 'r1', { paused: true } as any),
        ).toMatchObject({ paused: true });
        expect(await api.previewAlertRule('p1', { name: 'x' } as any)).toEqual({
            error: null,
            series: [],
        });
        expect(await api.getAlertRuleHistory('p1', 'r1')).toEqual([]);
        expect(await api.getAlertNotifications('p1', { rule: 'r1' })).toEqual(
            [],
        );
        expect(await api.testContactPoint('p1', 'cp1')).toEqual({
            ok: true,
            results: [],
        });
        expect(
            await api.saveNotificationRoutes('p1', {
                contactPoint: 'ops',
            } as any),
        ).toEqual({ contactPoint: 'ops' });
        expect(scope.isDone()).toBe(true);
    });
});

describe('alert-ui-pages', () => {
    it('serves the alerting pages from the app routes', async () => {
        const { APP_ROUTES } = await load('../../AppRoutes');
        const matched = (pathname: string) =>
            (matchRoutes(APP_ROUTES, pathname) ?? [])
                .map(({ route }) => route.path ?? '')
                .join(' ');
        for (const pathname of [
            '/projects/p1/alerting/rules',
            '/projects/p1/alerting/rules/r1',
            '/projects/p1/alerting/rules/new',
            '/projects/p1/alerting/contact-points',
            '/projects/p1/alerting/notification-routes',
        ]) {
            const m = matched(pathname);
            expect(m, pathname).toContain('alerting');
            expect(m.trim().endsWith('*'), pathname).toBe(false);
        }
    });
});
