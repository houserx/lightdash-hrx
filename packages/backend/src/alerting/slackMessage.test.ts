import { describe, expect, it } from 'vitest';
import {
    buildAlertTemplateData,
    buildSlackWebhookPayload,
    renderSlackMessage,
    type SlackTemplateAlert,
} from './slackMessage';

const alert = (
    instance: string,
    overrides: Partial<SlackTemplateAlert> = {},
): SlackTemplateAlert => ({
    status: 'firing',
    labels: { alertname: 'Disk', instance, team: 'infra' },
    annotations: {
        summary: 'Disk almost full',
        description: `Disk on ${instance} is above 90%`,
        runbook_url: 'https://runbooks.example.test/disk',
    },
    startsAt: new Date('2026-01-01T09:00:00Z'),
    fingerprint: `fp-${instance}`,
    generatorURL: `https://lightdash.example.test/rules/${instance}`,
    ...overrides,
});

const data = (alerts: SlackTemplateAlert[]) =>
    buildAlertTemplateData({
        receiver: 'slack-infra-alerts',
        groupLabels: { alertname: 'Disk' },
        externalURL: 'https://lightdash.example.test',
        alerts,
    });

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('buildAlertTemplateData', () => {
    it('builds the Grafana data shape with common labels and annotations', () => {
        const resolvedAt = new Date('2026-01-01T09:05:00Z');
        const d = data([
            alert('db-1'),
            alert('db-2', { status: 'resolved', endsAt: resolvedAt }),
        ]);
        expect(d.Status).toBe('firing');
        expect(d.Receiver).toBe('slack-infra-alerts');
        expect(d.CommonLabels).toEqual({ alertname: 'Disk', team: 'infra' });
        expect(d.CommonAnnotations).toEqual({
            summary: 'Disk almost full',
            runbook_url: 'https://runbooks.example.test/disk',
        });
        expect(d.Alerts[0]).toMatchObject({
            Status: 'firing',
            StartsAt: '2026-01-01T09:00:00.000Z',
            EndsAt: '0001-01-01T00:00:00Z',
            DashboardURL: '',
            SilenceURL: '',
        });
        expect(d.Alerts[1].EndsAt).toBe(resolvedAt.toISOString());
    });

    it('is resolved when every alert is resolved', () => {
        const endsAt = new Date('2026-01-01T09:05:00Z');
        expect(
            data([alert('db-1', { status: 'resolved', endsAt })]).Status,
        ).toBe('resolved');
    });
});

describe('renderSlackMessage', () => {
    it('defaults to the ported slack.title and slack.message', () => {
        const { title, text } = renderSlackMessage(
            {},
            data([alert('db-1'), alert('db-2')]),
        );
        expect(squash(title)).toBe('2 Disk almost full');
        expect(squash(text)).toBe(
            'Disk on db-1 is above 90% - <https://runbooks.example.test/disk|Runbook> ' +
                'Disk on db-2 is above 90% - <https://runbooks.example.test/disk|Runbook>',
        );
    });

    it('renders custom title and text templates', () => {
        const message = renderSlackMessage(
            {
                title: '{{ .Status }}: {{ len .Alerts }} alert(s)',
                text: '{{ range .Alerts }}<{{ .Labels.instance }}>{{ end }}',
            },
            data([alert('db-1'), alert('db-2')]),
        );
        expect(message).toEqual({
            title: 'firing: 2 alert(s)',
            text: '<db-1><db-2>',
        });
    });

    it('names the template that fails to render', () => {
        expect(() =>
            renderSlackMessage(
                { text: '{{ template "nope" . }}' },
                data([alert('db-1')]),
            ),
        ).toThrow(/^Slack text template: .*"nope"/);
    });
});

describe('buildSlackWebhookPayload', () => {
    it('posts one attachment coloured by status', () => {
        const at = new Date('2026-01-01T09:00:00Z');
        expect(
            buildSlackWebhookPayload({
                title: 'T',
                text: 'X',
                status: 'resolved',
                at,
            }),
        ).toEqual({
            attachments: [
                {
                    color: '#36a64f',
                    title: 'T',
                    text: 'X',
                    fallback: 'T',
                    footer: 'Lightdash',
                    ts: at.getTime() / 1000,
                },
            ],
        });
    });
});
