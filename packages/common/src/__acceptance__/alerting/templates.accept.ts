/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Message templates (Go text/template subset used by Grafana's notification
// templates) and the Alertmanager webhook v4 payload.
import { describe, expect, it } from 'vitest';

const common = async () => (await import('../../index')) as Record<string, any>;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const alert = (
    status: 'firing' | 'resolved',
    labels: Record<string, string>,
    annotations: Record<string, string>,
    extra: Record<string, string> = {},
) => ({
    Status: status,
    Labels: labels,
    Annotations: annotations,
    StartsAt: '2026-11-08T09:00:00Z',
    EndsAt:
        status === 'resolved' ? '2026-11-08T09:10:00Z' : '0001-01-01T00:00:00Z',
    Fingerprint: '0123456789abcdef',
    GeneratorURL: 'https://lightdash.example.test/alerting/rules/r1',
    SilenceURL: '',
    DashboardURL: '',
    ValueString: '',
    ...extra,
});

const data = (alerts: ReturnType<typeof alert>[]) => ({
    Receiver: 'slack-infra-alerts',
    Status: alerts.some((a) => a.Status === 'firing') ? 'firing' : 'resolved',
    Alerts: alerts,
    GroupLabels: {},
    CommonLabels: {},
    CommonAnnotations: {},
    ExternalURL: 'https://lightdash.example.test',
});

const disk = (instance: string) =>
    alert(
        'firing',
        { alertname: 'Disk almost full', instance },
        {
            summary: 'Disk almost full',
            description: `Disk on ${instance} is 95% full`,
            runbook_url: 'https://runbooks.example.test/disk',
        },
        { DashboardURL: 'https://lightdash.example.test/dashboards/d1' },
    );

describe('alert-template-engine', () => {
    it('renders fields, range, if/else, len, gt, eq and index', async () => {
        const { renderAlertTemplate: render } = await common();
        const d = data([disk('db-1'), disk('db-2')]);
        expect(
            render(
                '{{ range .Alerts.Firing }}{{ .Labels.instance }};{{ end }}',
                d,
            ),
        ).toBe('db-1;db-2;');
        expect(
            render(
                '{{ if gt (len .Alerts.Firing) 0 }}yes{{ else }}no{{ end }}',
                d,
            ),
        ).toBe('yes');
        expect(render('{{ len .Alerts.Resolved }}', d)).toBe('0');
        expect(render('{{ if eq .Status "firing" }}F{{ end }}', d)).toBe('F');
        expect(
            render('{{ (index .Alerts.Firing 1).Annotations.description }}', d),
        ).toBe('Disk on db-2 is 95% full');
        expect(
            render(
                '{{ range .Alerts }}{{ index .Labels "instance" }} {{ end }}',
                d,
            ),
        ).toBe('db-1 db-2 ');
    });
    it('supports define/template, trim markers and missing fields', async () => {
        const { renderAlertTemplate: render } = await common();
        const d = data([disk('db-1')]);
        const templates =
            '{{ define "inst" }}[{{ .Labels.instance }}]{{ end }}';
        expect(
            render('{{ range .Alerts }}{{ template "inst" . }}{{ end }}', d, {
                templates,
            }),
        ).toBe('[db-1]');
        expect(render('a  {{- " b " -}}  c', d)).toBe('a b c');
        expect(render('x{{ .Labels.nope }}y', d.Alerts[0])).toBe('xy');
        expect(() => render('{{ template "nope" . }}', d)).toThrow(/nope/);
        expect(() => render('{{ if }}', d)).toThrow();
    });
});

describe('alert-templates-ported', () => {
    it('ports slack.title and slack.message', async () => {
        const { renderAlertTemplate: render, PORTED_GRAFANA_TEMPLATES } =
            await common();
        expect(typeof PORTED_GRAFANA_TEMPLATES).toBe('string');
        const d = data([disk('db-1'), disk('db-2')]);
        expect(norm(render('{{ template "slack.title" . }}', d))).toBe(
            '2 Disk almost full',
        );
        const message = norm(render('{{ template "slack.message" . }}', d));
        expect(message).toContain('Disk on db-1 is 95% full');
        expect(message).toContain('Disk on db-2 is 95% full');
        expect(message).toContain(
            '- <https://lightdash.example.test/dashboards/d1|Dashboard>',
        );
        expect(message).toContain(
            '- <https://runbooks.example.test/disk|Runbook>',
        );
        const resolvedOnly = data([
            alert('resolved', { alertname: 'x' }, { summary: 'x' }),
        ]);
        expect(
            norm(render('{{ template "slack.title" . }}', resolvedOnly)),
        ).toBe('');
    });
    it('ports the test.slack templates', async () => {
        const { renderAlertTemplate: render } = await common();
        const d = data([disk('db-1')]);
        expect(norm(render('{{ template "test.slack.title" . }}', d))).toBe(
            '1 Disk almost full',
        );
        expect(
            norm(render('{{ template "test.slack.message" . }}', d)),
        ).toContain('Disk on db-1 is 95% full');
    });
    it('ports slack.ms-message', async () => {
        const { renderAlertTemplate: render } = await common();
        const fn = (
            status: 'firing' | 'resolved',
            name: string,
            silence = '',
        ) => alert(status, { FunctionName: name }, {}, { SilenceURL: silence });
        const d = data([
            fn('firing', 'epa-submit', 'https://silence.example.test/1'),
            fn('firing', 'epa-poll'),
            fn('resolved', 'epa-status'),
        ]);
        const text = norm(render('{{ template "slack.ms-message" . }}', d));
        expect(text).toContain(
            '*Summary*: :fire: Microservice(s) have a high failure rate.',
        );
        expect(text).toContain(
            '- epa-submit (<https://silence.example.test/1 | Silence>)',
        );
        expect(text).toContain('- epa-poll');
        expect(text).not.toContain('epa-poll (<');
        expect(text).toContain(
            '*Summary*: :white_check_mark: Microservice(s) resolved.',
        );
        expect(text.indexOf('epa-status')).toBeGreaterThan(
            text.indexOf('resolved.'),
        );
    });
});

describe('alert-alertmanager-payload', () => {
    it('builds an Alertmanager webhook v4 payload', async () => {
        const { buildAlertmanagerWebhookPayload } = await common();
        const payload = buildAlertmanagerWebhookPayload({
            receiver: 'incident-io',
            groupKey: '{}:{alertname="Disk almost full"}',
            groupLabels: { alertname: 'Disk almost full' },
            externalURL: 'https://lightdash.example.test',
            alerts: [
                {
                    status: 'firing',
                    labels: {
                        alertname: 'Disk almost full',
                        instance: 'db-1',
                        team: 'infra',
                    },
                    annotations: { summary: 'Disk almost full' },
                    startsAt: '2026-11-08T09:00:00.000Z',
                    endsAt: null,
                    fingerprint: 'aaaaaaaaaaaaaaaa',
                    generatorURL: 'https://lightdash.example.test/r/1',
                },
                {
                    status: 'resolved',
                    labels: {
                        alertname: 'Disk almost full',
                        instance: 'db-2',
                        team: 'infra',
                    },
                    annotations: { summary: 'Disk almost full' },
                    startsAt: '2026-11-08T08:00:00.000Z',
                    endsAt: '2026-11-08T09:05:00.000Z',
                    fingerprint: 'bbbbbbbbbbbbbbbb',
                    generatorURL: 'https://lightdash.example.test/r/1',
                },
            ],
        });
        expect(payload).toMatchObject({
            version: '4',
            receiver: 'incident-io',
            status: 'firing',
            groupKey: '{}:{alertname="Disk almost full"}',
            groupLabels: { alertname: 'Disk almost full' },
            commonLabels: { alertname: 'Disk almost full', team: 'infra' },
            commonAnnotations: { summary: 'Disk almost full' },
            externalURL: 'https://lightdash.example.test',
            truncatedAlerts: 0,
        });
        expect(payload.alerts).toHaveLength(2);
        expect(payload.alerts[0]).toMatchObject({
            status: 'firing',
            labels: { instance: 'db-1' },
            endsAt: '0001-01-01T00:00:00Z',
            fingerprint: 'aaaaaaaaaaaaaaaa',
            startsAt: '2026-11-08T09:00:00.000Z',
        });
        expect(payload.alerts[1]).toMatchObject({
            status: 'resolved',
            endsAt: '2026-11-08T09:05:00.000Z',
        });
        const resolved = buildAlertmanagerWebhookPayload({
            receiver: 'x',
            groupKey: 'k',
            groupLabels: {},
            externalURL: 'https://lightdash.example.test',
            alerts: [payload.alerts[1]].map((a: any) => ({ ...a })),
        });
        expect(resolved.status).toBe('resolved');
    });
});
