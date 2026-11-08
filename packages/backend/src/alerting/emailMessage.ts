// Email messages for Contact Points (ENG-1799). There are no ported Grafana
// email templates and the email integration has no title or text fields, so
// the subject and body are built here, in the shape of Grafana's default
// email: the subject is `[STATUS:count] <rule names> (<other group label
// values>)`, and the body lists each alert with its summary, description,
// labels, runbook and a link to the rule.
import { type AlertTemplateAlert } from '@lightdash/common';

export type EmailMessage = {
    subject: string;
    text: string;
    html: string;
};

const escapeHtml = (value: string) =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const sortedPairs = (labels: Record<string, string>) =>
    Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));

/** `[FIRING:2, RESOLVED:1]`, `[FIRING:1]` or `[RESOLVED]`, as Grafana. */
const statusTag = (alerts: AlertTemplateAlert[]) => {
    const firing = alerts.filter((a) => a.Status === 'firing').length;
    const resolved = alerts.length - firing;
    if (firing === 0) return '[RESOLVED]';
    return resolved > 0
        ? `[FIRING:${firing}, RESOLVED:${resolved}]`
        : `[FIRING:${firing}]`;
};

export const buildEmailMessage = (args: {
    alerts: AlertTemplateAlert[];
    groupLabels: Record<string, string>;
}): EmailMessage => {
    const { alerts } = args;
    const ruleNames = [
        ...new Set(
            alerts
                .map((alert) => alert.Labels.alertname)
                .filter((name): name is string => !!name),
        ),
    ];
    const otherGroupValues = sortedPairs(args.groupLabels)
        .filter(([key]) => key !== 'alertname')
        .map(([, value]) => value);
    const subject = [
        statusTag(alerts),
        ruleNames.join(', '),
        otherGroupValues.length > 0 ? `(${otherGroupValues.join(' ')})` : '',
    ]
        .filter((part) => part !== '')
        .join(' ')
        // Header values can't contain line breaks.
        .replace(/[\r\n]+/g, ' ');

    const sections = (['firing', 'resolved'] as const)
        .map((status) => ({
            status,
            alerts: alerts.filter((alert) => alert.Status === status),
        }))
        .filter((section) => section.alerts.length > 0);

    const alertLines = (alert: AlertTemplateAlert) => {
        const {
            summary,
            description,
            runbook_url: runbook,
        } = alert.Annotations;
        return [
            summary ? `Summary: ${summary}` : '',
            description ? `Description: ${description}` : '',
            `Labels: ${sortedPairs(alert.Labels)
                .map(([key, value]) => `${key}=${value}`)
                .join(', ')}`,
            runbook ? `Runbook: ${runbook}` : '',
            alert.GeneratorURL ? `Rule: ${alert.GeneratorURL}` : '',
        ].filter((line) => line !== '');
    };

    const text = sections
        .map(
            (section) =>
                `${section.status === 'firing' ? 'Firing' : 'Resolved'} (${
                    section.alerts.length
                })\n\n${section.alerts
                    .map((alert) => alertLines(alert).join('\n'))
                    .join('\n\n')}`,
        )
        .join('\n\n');

    const html = sections
        .map(
            (section) =>
                `<h2>${
                    section.status === 'firing' ? 'Firing' : 'Resolved'
                } (${section.alerts.length})</h2>${section.alerts
                    .map(
                        (alert) =>
                            `<p>${alertLines(alert)
                                .map(escapeHtml)
                                .join('<br>')}</p>`,
                    )
                    .join('')}`,
        )
        .join('');

    return { subject, text, html };
};
