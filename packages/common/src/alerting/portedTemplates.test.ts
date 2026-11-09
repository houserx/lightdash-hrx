import { describe, expect, it } from 'vitest';
import {
    PORTED_GRAFANA_TEMPLATE_SOURCES,
    PORTED_GRAFANA_TEMPLATES,
} from './portedTemplates';
import { renderAlertTemplate as render } from './templateEngine';

const alert = (
    Status: 'firing' | 'resolved',
    Labels: Record<string, string>,
    Annotations: Record<string, string>,
    extra: Record<string, string> = {},
) => ({
    Status,
    Labels,
    Annotations,
    SilenceURL: '',
    DashboardURL: '',
    ...extra,
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

const fn = (status: 'firing' | 'resolved', name: string, silence = '') =>
    alert(status, { FunctionName: name }, {}, { SilenceURL: silence });

const tmpl = (name: string, data: unknown) =>
    render(`{{ template "${name}" . }}`, data);

describe('ported Grafana message templates', () => {
    it('holds the three Grafana templates', () => {
        expect(Object.keys(PORTED_GRAFANA_TEMPLATE_SOURCES)).toEqual([
            'Slack Message Template',
            'Slack MS Message Template',
            'Slack Test Message Template',
        ]);
        Object.values(PORTED_GRAFANA_TEMPLATE_SOURCES).forEach((source) =>
            expect(PORTED_GRAFANA_TEMPLATES).toContain(source),
        );
    });

    it('renders slack.title and slack.message with Grafana whitespace', () => {
        const data = { Alerts: [disk('db-1'), disk('db-2')] };
        expect(tmpl('slack.title', data)).toBe(
            '\n    \n       2 Disk almost full\n    \n',
        );
        const block = (instance: string) =>
            `\n        Disk on ${instance} is 95% full` +
            '\n        - <https://lightdash.example.test/dashboards/d1|Dashboard> ' +
            '\n        - <https://runbooks.example.test/disk|Runbook>\n    ';
        expect(tmpl('slack.message', data)).toBe(
            `\n    ${block('db-1')}${block('db-2')}\n`,
        );
        expect(tmpl('slack.title', { Alerts: [fn('resolved', 'x')] })).toBe(
            '\n    \n',
        );
    });

    it('leaves out Dashboard and Runbook links that are not set', () => {
        const bare = alert('firing', {}, { description: 'd' });
        expect(tmpl('slack.message', { Alerts: [bare] })).toBe(
            '\n    \n        d\n        \n        \n    \n',
        );
    });

    it('renders test.slack.title and test.slack.message', () => {
        const data = { Alerts: [disk('db-1')] };
        expect(tmpl('test.slack.title', data)).toBe(
            '\n    \n       1 Disk almost full\n    \n',
        );
        expect(tmpl('test.slack.message', data)).toBe(
            '\n\n        Disk on db-1 is 95% full' +
                '\n         - <https://lightdash.example.test/dashboards/d1|Dashboard> ' +
                '\n         - <https://runbooks.example.test/disk|Runbook>\n    \n',
        );
    });

    it('renders slack.ms-message with firing and resolved microservices', () => {
        const fired =
            '\n  *Summary*: :fire: Microservice(s) have a high failure rate.' +
            '\n  *Microservices*:\n  ';
        const resolved =
            '\n  *Summary*: :white_check_mark: Microservice(s) resolved.' +
            '\n  *Microservices*:\n  ';
        const firing = [
            fn('firing', 'epa-submit', 'https://silence.example.test/1'),
            fn('firing', 'epa-poll'),
        ];
        const ok = [fn('resolved', 'epa-status')];
        const firingText =
            `\n  \n    ${fired}` +
            '   - epa-submit (<https://silence.example.test/1 | Silence>)\n  ' +
            '   - epa-poll \n  \n';
        const resolvedText = `${resolved}   - epa-status\n  \n`;
        expect(tmpl('slack.ms-message', { Alerts: [...firing, ...ok] })).toBe(
            `${firingText}\n\n${resolvedText}`,
        );
        expect(tmpl('slack.ms-message', { Alerts: firing })).toBe(
            `${firingText}\n`,
        );
        expect(tmpl('slack.ms-message', { Alerts: ok })).toBe(
            `\n  \n\n${resolvedText}`,
        );
    });

    it('lets options.templates and the template override a ported define', () => {
        const data = { Alerts: [disk('db-1')] };
        const custom = '{{ define "slack.title" }}custom{{ end }}';
        expect(tmpl('slack.title', data)).not.toBe('custom');
        expect(
            render('{{ template "slack.title" . }}', data, {
                templates: custom,
            }),
        ).toBe('custom');
        expect(render(`${custom}{{ template "slack.title" . }}`, data)).toBe(
            'custom',
        );
    });
});
