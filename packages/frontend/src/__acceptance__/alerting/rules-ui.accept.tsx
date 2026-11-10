/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Alert Rules UI: list with filters, rule detail, test rule, editor, Managed.
// Components are presentational: data in props, actions as callbacks.
// Module: packages/frontend/src/features/alerting/components/*.
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { field, load, pick, renderUi, typeInto } from './support';

const spaces = [
    { uuid: 'space-platform', name: 'Platform' },
    { uuid: 'space-rds', name: 'RDS' },
];

const rule = (o: Record<string, unknown>) => ({
    uuid: 'r-disk',
    projectUuid: 'p1',
    spaceUuid: 'space-platform',
    slug: 'disk-almost-full',
    name: 'Disk almost full',
    description: 'Disk usage on a database host is above 90%',
    labels: { team: 'infra' },
    annotations: { summary: 'Disk almost full' },
    query: 'SELECT instance, value FROM disk_usage',
    valueColumn: 'value',
    reducer: 'last',
    condition: { operator: '>', threshold: 90 },
    for: '0s',
    keepFiringFor: '0s',
    interval: '1m',
    timeRange: '10m',
    noDataState: 'nodata',
    errorState: 'error',
    paused: false,
    shadow: false,
    managed: false,
    version: 1,
    state: 'normal',
    createdAt: '2026-11-08T08:00:00Z',
    updatedAt: '2026-11-08T08:00:00Z',
    ...o,
});

const rules = [
    rule({
        uuid: 'r-disk',
        name: 'Disk almost full',
        state: 'firing',
        labels: { team: 'infra' },
        spaceUuid: 'space-platform',
    }),
    rule({
        uuid: 'r-rds',
        name: 'RDS free storage low',
        state: 'pending',
        labels: { team: 'db' },
        spaceUuid: 'space-rds',
        managed: true,
    }),
    rule({
        uuid: 'r-cpu',
        name: 'CPU high',
        state: 'normal',
        labels: { team: 'infra' },
        spaceUuid: null,
    }),
];

const rowNames = () =>
    screen
        .queryAllByRole('row')
        .map((row) => row.textContent ?? '')
        .filter((t) =>
            /Disk almost full|RDS free storage low|CPU high/.test(t),
        );

describe('alert-ui-rules-list', () => {
    it('shows state badges, labels, folders and Managed, and filters', async () => {
        const { AlertRulesList } = await load(
            '../../features/alerting/components/AlertRulesList',
        );
        const onOpenRule = vi.fn();
        const { user } = renderUi(
            <AlertRulesList
                rules={rules as any}
                spaces={spaces}
                onOpenRule={onOpenRule}
            />,
        );
        const disk = screen.getByRole('row', { name: /Disk almost full/ });
        expect(within(disk).getByText('Firing')).toBeInTheDocument();
        expect(within(disk).getByText('team=infra')).toBeInTheDocument();
        expect(within(disk).getByText('Platform')).toBeInTheDocument();
        const rds = screen.getByRole('row', { name: /RDS free storage low/ });
        expect(within(rds).getByText('Pending')).toBeInTheDocument();
        expect(within(rds).getByText('Managed in git')).toBeInTheDocument();
        expect(
            within(screen.getByRole('row', { name: /CPU high/ })).getByText(
                'Normal',
            ),
        ).toBeInTheDocument();
        expect(rowNames()).toHaveLength(3);

        await pick(user, 'State', 'Firing');
        await waitFor(() => expect(rowNames()).toHaveLength(1));
        expect(rowNames()[0]).toContain('Disk almost full');
        await pick(user, 'State', 'All');
        await waitFor(() => expect(rowNames()).toHaveLength(3));

        await typeInto(user, 'Label', 'team=infra');
        await waitFor(() => expect(rowNames()).toHaveLength(2));
        await typeInto(user, 'Label', '');
        await pick(user, 'Folder', 'RDS');
        await waitFor(() => expect(rowNames()).toHaveLength(1));
        expect(rowNames()[0]).toContain('RDS free storage low');

        await user.click(screen.getByText('RDS free storage low'));
        expect(onOpenRule).toHaveBeenCalledWith('r-rds');
    });
});

const history = [
    {
        type: 'transition',
        ruleUuid: 'r-disk',
        fingerprint: 'aaaaaaaaaaaaaaaa',
        labels: { instance: 'db-1' },
        previousState: 'normal',
        state: 'firing',
        value: 95,
        at: '2026-11-08T09:00:00Z',
    },
    {
        type: 'evaluation_skipped',
        ruleUuid: 'r-disk',
        reason: 'overrun',
        at: '2026-11-08T09:01:00Z',
    },
];
const notifications = [
    {
        uuid: 'n1',
        ruleUuids: ['r-disk'],
        contactPointUuid: 'cp1',
        contactPointName: 'incident-io',
        integrationType: 'incident_io',
        status: 'sent',
        alertStatus: 'firing',
        attempts: 1,
        error: null,
        sentAt: '2026-11-08T09:00:30Z',
    },
    {
        uuid: 'n2',
        ruleUuids: ['r-disk'],
        contactPointUuid: 'cp2',
        contactPointName: 'slack-infra-alerts',
        integrationType: 'slack_webhook',
        status: 'failed',
        alertStatus: 'firing',
        attempts: 3,
        error: 'HTTP 500',
        sentAt: '2026-11-08T09:00:31Z',
    },
];

describe('alert-ui-rule-detail', () => {
    it('shows the query, the state history timeline and the notifications sent', async () => {
        const { AlertRuleDetail } = await load(
            '../../features/alerting/components/AlertRuleDetail',
        );
        renderUi(
            <AlertRuleDetail
                rule={
                    {
                        ...rule({ state: 'firing' }),
                        instances: [
                            {
                                fingerprint: 'aaaaaaaaaaaaaaaa',
                                labels: { instance: 'db-1' },
                                state: 'firing',
                                value: 95,
                                since: '2026-11-08T09:00:00Z',
                            },
                        ],
                    } as any
                }
                history={history as any}
                notifications={notifications as any}
                onTestRule={vi.fn()}
            />,
        );
        expect(
            screen.getByRole('heading', { name: /Disk almost full/ }),
        ).toBeInTheDocument();
        expect(
            screen.getByText('SELECT instance, value FROM disk_usage'),
        ).toBeInTheDocument();
        expect(screen.getAllByText('Firing').length).toBeGreaterThan(0);
        expect(screen.getByText(/Normal\s*→\s*Firing/)).toBeInTheDocument();
        expect(screen.getByText(/Skipped.*overrun/i)).toBeInTheDocument();
        const sent = screen.getByRole('row', { name: /incident-io/ });
        expect(within(sent).getByText(/sent/i)).toBeInTheDocument();
        const failed = screen.getByRole('row', { name: /slack-infra-alerts/ });
        expect(within(failed).getByText(/failed/i)).toBeInTheDocument();
        expect(within(failed).getByText(/HTTP 500/)).toBeInTheDocument();
    });
});

describe('alert-ui-rule-test', () => {
    it('runs "Test rule" and shows per-series results and the would-be state', async () => {
        const { AlertRuleDetail } = await load(
            '../../features/alerting/components/AlertRuleDetail',
        );
        const onTestRule = vi.fn(async () => ({
            error: null,
            series: [
                {
                    labels: { instance: 'db-1' },
                    fingerprint: 'a',
                    value: 95,
                    conditionMet: true,
                    state: 'firing',
                },
                {
                    labels: { instance: 'db-2' },
                    fingerprint: 'b',
                    value: 40,
                    conditionMet: false,
                    state: 'normal',
                },
            ],
        }));
        const { user } = renderUi(
            <AlertRuleDetail
                rule={{ ...rule({}), instances: [] } as any}
                history={[]}
                notifications={[]}
                onTestRule={onTestRule}
            />,
        );
        await user.click(screen.getByRole('button', { name: 'Test rule' }));
        expect(onTestRule).toHaveBeenCalledTimes(1);
        const db1 = await screen.findByRole('row', { name: /instance=db-1/ });
        expect(within(db1).getByText('95')).toBeInTheDocument();
        expect(within(db1).getByText('Firing')).toBeInTheDocument();
        const db2 = screen.getByRole('row', { name: /instance=db-2/ });
        expect(within(db2).getByText('Normal')).toBeInTheDocument();

        onTestRule.mockResolvedValueOnce({
            error: 'relation "disk_usage" does not exist',
            series: [],
        } as any);
        await user.click(screen.getByRole('button', { name: 'Test rule' }));
        expect(
            await screen.findByText(/relation "disk_usage" does not exist/),
        ).toBeInTheDocument();
    });
});

describe('alert-ui-rule-editor', () => {
    it('creates a rule with documented defaults and requires a description', async () => {
        const { AlertRuleEditor } = await load(
            '../../features/alerting/components/AlertRuleEditor',
        );
        const onSubmit = vi.fn();
        const { user } = renderUi(
            <AlertRuleEditor spaces={spaces} onSubmit={onSubmit} />,
        );
        await typeInto(user, 'Name', 'Queue depth high');
        await typeInto(
            user,
            'Query',
            'SELECT queue, value FROM ops_marts.queue_depth',
        );
        await typeInto(user, 'Threshold', '80');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(
            await screen.findByText('Description is required'),
        ).toBeInTheDocument();
        expect(onSubmit).not.toHaveBeenCalled();
        await typeInto(user, 'Description', 'Fills queue is backing up');
        await pick(user, 'Folder', 'Platform');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({
            name: 'Queue depth high',
            description: 'Fills queue is backing up',
            query: 'SELECT queue, value FROM ops_marts.queue_depth',
            reducer: 'last',
            condition: { operator: '>', threshold: 80 },
            interval: '1m',
            for: '0s',
            noDataState: 'nodata',
            errorState: 'error',
            spaceUuid: 'space-platform',
        });
    });
    it('edits an existing rule', async () => {
        const { AlertRuleEditor } = await load(
            '../../features/alerting/components/AlertRuleEditor',
        );
        const onSubmit = vi.fn();
        const { user } = renderUi(
            <AlertRuleEditor
                rule={rule({}) as any}
                spaces={spaces}
                onSubmit={onSubmit}
            />,
        );
        expect(field('Name').value).toBe('Disk almost full');
        expect(field('Threshold').value).toBe('90');
        await typeInto(user, 'Threshold', '95');
        await pick(user, 'Reducer', /mean/i);
        await typeInto(user, 'For', '5m');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({
            name: 'Disk almost full',
            condition: { operator: '>', threshold: 95 },
            reducer: 'mean',
            for: '5m',
        });
    });
});

describe('alert-ui-managed-readonly', () => {
    it('shows Managed in git and disables the editor for managed rules', async () => {
        const { AlertRuleEditor } = await load(
            '../../features/alerting/components/AlertRuleEditor',
        );
        const onSubmit = vi.fn();
        renderUi(
            <AlertRuleEditor
                rule={rule({ managed: true }) as any}
                spaces={spaces}
                onSubmit={onSubmit}
            />,
        );
        expect(screen.getByText('Managed in git')).toBeInTheDocument();
        for (const label of ['Name', 'Description', 'Query', 'Threshold'])
            expect(field(label)).toBeDisabled();
        const save = screen.queryByRole('button', { name: 'Save' });
        if (save) expect(save).toBeDisabled();
        const { AlertRuleDetail } = await load(
            '../../features/alerting/components/AlertRuleDetail',
        );
        renderUi(
            <AlertRuleDetail
                rule={
                    {
                        ...rule({ managed: true, name: 'Managed rule' }),
                        instances: [],
                    } as any
                }
                history={[]}
                notifications={[]}
                onTestRule={vi.fn()}
                onEdit={vi.fn()}
            />,
        );
        expect(screen.getAllByText('Managed in git').length).toBeGreaterThan(1);
        expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    });
});
