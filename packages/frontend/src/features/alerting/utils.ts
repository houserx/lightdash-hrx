import {
    type AlertCondition,
    type AlertInstanceState,
    type AlertStateHistoryEntry,
    type ContactPointIntegrationType,
    type ContactPointTestResult,
} from '@lightdash/common';

export const ALERT_STATE_LABELS: Record<AlertInstanceState, string> = {
    firing: 'Firing',
    pending: 'Pending',
    normal: 'Normal',
    resolved: 'Resolved',
    nodata: 'No data',
    error: 'Error',
};

/**
 * Whether `labels` match the Alert Rules list's Label filter: comma or space
 * separated terms, all of which must match. `key=value` matches that exact
 * label, `key=` any rule with the key, and a bare word any label key or value
 * containing it (case-insensitive).
 */
export const matchesLabelFilter = (
    labels: Record<string, string>,
    filter: string,
): boolean =>
    filter
        .split(/[\s,]+/)
        .filter(Boolean)
        .every((term) => {
            const eq = term.indexOf('=');
            if (eq === -1) {
                const needle = term.toLowerCase();
                return Object.entries(labels).some(
                    ([key, value]) =>
                        key.toLowerCase().includes(needle) ||
                        value.toLowerCase().includes(needle),
                );
            }
            const key = term.slice(0, eq);
            const value = term.slice(eq + 1);
            if (!(key in labels)) return false;
            return value === '' || labels[key] === value;
        });

const RANGE_OPERATOR_LABELS = {
    within_range: 'within',
    outside_range: 'outside',
} as const;

/** A rule's condition as one line, e.g. `last(value) > 90`. */
export const formatAlertCondition = (
    reducer: string,
    valueColumn: string,
    condition: AlertCondition,
): string => {
    const value = `${reducer}(${valueColumn})`;
    if ('min' in condition)
        return `${value} ${RANGE_OPERATOR_LABELS[condition.operator]} (${condition.min}, ${condition.max})`;
    return `${value} ${condition.operator} ${condition.threshold}`;
};

/** `key=value` pairs of a label set, in the order given. */
export const formatLabels = (labels: Record<string, string>): string[] =>
    Object.entries(labels).map(([key, value]) => `${key}=${value}`);

/**
 * The headline of a state history entry: `Normal → Firing` for a series
 * transition, `Skipped evaluation (overrun)` for a skipped slot.
 */
export const describeHistoryEntry = (entry: AlertStateHistoryEntry): string =>
    entry.type === 'transition'
        ? `${ALERT_STATE_LABELS[entry.previousState] ?? entry.previousState} → ${ALERT_STATE_LABELS[entry.state] ?? entry.state}`
        : `Skipped evaluation (${entry.reason})`;

/** A label set as editor text: one `key=value` per line. */
export const labelsToText = (labels: Record<string, string>): string =>
    formatLabels(labels).join('\n');

/**
 * Parses editor text of `key=value` lines into a label set. Blank lines are
 * ignored and keys and values are trimmed. Returns the first bad line as an
 * error instead: a line without `=` or with an empty key.
 */
export const parseLabelsText = (
    text: string,
):
    | { labels: Record<string, string>; error?: undefined }
    | { labels?: undefined; error: string } => {
    const labels: Record<string, string> = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '') continue;
        const eq = line.indexOf('=');
        const key = eq === -1 ? '' : line.slice(0, eq).trim();
        if (key === '') return { error: `Expected key=value, got "${line}"` };
        labels[key] = line.slice(eq + 1).trim();
    }
    return { labels };
};

/** How each Contact Point integration type is named in the UI. */
export const CONTACT_POINT_INTEGRATION_LABELS: Record<
    ContactPointIntegrationType,
    string
> = {
    slack_webhook: 'Slack webhook',
    slack_app: 'Slack app',
    incident_io: 'incident.io',
    email: 'Email',
    webhook: 'Webhook',
};

/**
 * A secret reference's name, as the contact_point schema allows it. Secrets
 * themselves (webhook URLs, tokens) never pass: they contain `:` or `/`.
 */
const SECRET_REF_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const isSecretRefName = (value: string): boolean =>
    SECRET_REF_NAME.test(value);

/**
 * The outcome of "Send test notification" in one line: null when every
 * integration succeeded, else each failure as `<type>: <error>`.
 */
export const describeContactPointTestFailure = (
    result: ContactPointTestResult,
): string | null => {
    if (result.ok) return null;
    const failures = result.results
        .filter((integration) => !integration.ok)
        .map(
            (integration) =>
                `${CONTACT_POINT_INTEGRATION_LABELS[integration.type] ?? integration.type}: ${integration.error ?? 'failed'}`,
        );
    return failures.length > 0
        ? failures.join('; ')
        : 'The test notification failed';
};
