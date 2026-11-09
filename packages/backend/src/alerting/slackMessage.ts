// Slack messages for Contact Points (ENG-1799): the Grafana-shaped template
// data of a notification group, the rendered title and text, and the
// incoming-webhook payload. The title and text default to the ported
// Grafana templates (`slack.title`, `slack.message`), as in today's Grafana.
import {
    renderAlertTemplate,
    type AlertTemplateAlert,
    type AlertTemplateData,
} from '@lightdash/common';

export const DEFAULT_SLACK_TITLE_TEMPLATE = '{{ template "slack.title" . }}';
export const DEFAULT_SLACK_TEXT_TEMPLATE = '{{ template "slack.message" . }}';

/** Go's zero `time.Time`, which Grafana gives a firing alert's `EndsAt`. */
const GO_ZERO_TIME = '0001-01-01T00:00:00Z';

const FIRING_COLOR = '#D63232';
const RESOLVED_COLOR = '#36a64f';

export type SlackTemplateAlert = {
    status: 'firing' | 'resolved';
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: Date;
    endsAt?: Date;
    fingerprint: string;
    generatorURL: string;
};

/** The key/value pairs every map has in common. */
const commonEntries = (
    maps: Record<string, string>[],
): Record<string, string> => {
    if (maps.length === 0) return {};
    const [first, ...rest] = maps;
    return Object.fromEntries(
        Object.entries(first).filter(([key, value]) =>
            rest.every((map) => map[key] === value),
        ),
    );
};

/** The data (`.`) the Slack templates see, the same shape as Grafana's. */
export const buildAlertTemplateData = (args: {
    receiver: string;
    groupLabels: Record<string, string>;
    externalURL: string;
    alerts: SlackTemplateAlert[];
}): AlertTemplateData => {
    const alerts: AlertTemplateAlert[] = args.alerts.map((alert) => ({
        Status: alert.status,
        Labels: alert.labels,
        Annotations: alert.annotations,
        StartsAt: alert.startsAt.toISOString(),
        EndsAt: alert.endsAt ? alert.endsAt.toISOString() : GO_ZERO_TIME,
        Fingerprint: alert.fingerprint,
        GeneratorURL: alert.generatorURL,
        // Lightdash has no silences or rule dashboards (yet), so the ported
        // templates leave those links out.
        SilenceURL: '',
        DashboardURL: '',
        ValueString: '',
    }));
    return {
        Receiver: args.receiver,
        Status: alerts.some((alert) => alert.Status === 'firing')
            ? 'firing'
            : 'resolved',
        Alerts: alerts,
        GroupLabels: args.groupLabels,
        CommonLabels: commonEntries(alerts.map((alert) => alert.Labels)),
        CommonAnnotations: commonEntries(
            alerts.map((alert) => alert.Annotations),
        ),
        ExternalURL: args.externalURL,
    };
};

/**
 * Renders a Slack integration's title and text, defaulting to the ported
 * templates. Throws an AlertTemplateError (prefixed with which template)
 * when a template doesn't parse or execute.
 */
export const renderSlackMessage = (
    integration: { title?: string; text?: string },
    data: AlertTemplateData,
): { title: string; text: string } => {
    const render = (field: 'title' | 'text', fallback: string) => {
        try {
            return renderAlertTemplate(integration[field] ?? fallback, data);
        } catch (e) {
            if (e instanceof Error) {
                e.message = `Slack ${field} template: ${e.message}`;
            }
            throw e;
        }
    };
    return {
        title: render('title', DEFAULT_SLACK_TITLE_TEMPLATE),
        text: render('text', DEFAULT_SLACK_TEXT_TEMPLATE),
    };
};

/**
 * The Slack app (`chat.postMessage`) message text: the title in bold on the
 * first line (whitespace collapsed, since mrkdwn bold can't span lines),
 * then the text, in Slack mrkdwn. An empty part is left out.
 */
export const buildSlackAppText = (args: { title: string; text: string }) => {
    const title = args.title.replace(/\s+/g, ' ').trim();
    return [title === '' ? '' : `*${title}*`, args.text]
        .filter((part) => part.trim() !== '')
        .join('\n');
};

/** The incoming-webhook body: one attachment, as Grafana's Slack notifier. */
export const buildSlackWebhookPayload = (args: {
    title: string;
    text: string;
    status: 'firing' | 'resolved';
    at: Date;
}) => ({
    attachments: [
        {
            color: args.status === 'firing' ? FIRING_COLOR : RESOLVED_COLOR,
            title: args.title,
            text: args.text,
            fallback: args.title,
            footer: 'Lightdash',
            ts: Math.floor(args.at.getTime() / 1000),
        },
    ],
});
