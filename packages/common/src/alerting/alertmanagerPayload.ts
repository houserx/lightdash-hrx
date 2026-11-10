// Alertmanager webhook v4 payload (ENG-1799). incident.io and generic
// webhook contact points receive notifications in this shape, the same JSON
// Alertmanager's webhook receiver sends:
// - `status` is `firing` when any alert in the group fires, else `resolved`;
// - `commonLabels` / `commonAnnotations` hold the pairs every alert shares;
// - a firing alert's `endsAt` is Go's zero time, `0001-01-01T00:00:00Z`;
// - `truncatedAlerts` counts alerts left out by `maxAlerts` (0 = no limit).

/** Go's zero `time.Time` as Alertmanager serialises it. */
export const ALERTMANAGER_ZERO_TIME = '0001-01-01T00:00:00Z';

export type AlertmanagerAlertStatus = 'firing' | 'resolved';

export type AlertmanagerWebhookAlert = {
    status: AlertmanagerAlertStatus;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    endsAt: string;
    generatorURL: string;
    fingerprint: string;
};

export type AlertmanagerWebhookPayload = {
    version: '4';
    groupKey: string;
    truncatedAlerts: number;
    status: AlertmanagerAlertStatus;
    receiver: string;
    groupLabels: Record<string, string>;
    commonLabels: Record<string, string>;
    commonAnnotations: Record<string, string>;
    externalURL: string;
    alerts: AlertmanagerWebhookAlert[];
};

type PairInput = Record<string, string | null | undefined>;

export type AlertmanagerPayloadAlertInput = {
    status: AlertmanagerAlertStatus;
    labels: PairInput;
    annotations?: PairInput;
    startsAt: string;
    /** Ignored for firing alerts; missing means the zero time. */
    endsAt?: string | null;
    generatorURL?: string | null;
    fingerprint: string;
};

export type AlertmanagerPayloadInput = {
    receiver: string;
    groupKey: string;
    groupLabels: PairInput;
    externalURL: string;
    alerts: AlertmanagerPayloadAlertInput[];
    /** Send at most this many alerts; 0 or missing sends them all. */
    maxAlerts?: number;
};

/** Drops null, undefined and empty values, as Alertmanager has no such labels. */
const cleanPairs = (pairs: PairInput | undefined): Record<string, string> =>
    Object.entries(pairs ?? {}).reduce<Record<string, string>>(
        (acc, [name, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                acc[name] = value;
            }
            return acc;
        },
        {},
    );

/** The name/value pairs present, with the same value, in every set. */
const commonPairs = (
    sets: Record<string, string>[],
): Record<string, string> => {
    if (sets.length === 0) return {};
    const [first, ...rest] = sets;
    return Object.entries(first).reduce<Record<string, string>>(
        (acc, [name, value]) => {
            if (rest.every((set) => set[name] === value)) {
                acc[name] = value;
            }
            return acc;
        },
        {},
    );
};

const toWebhookAlert = (
    alert: AlertmanagerPayloadAlertInput,
): AlertmanagerWebhookAlert => ({
    status: alert.status,
    labels: cleanPairs(alert.labels),
    annotations: cleanPairs(alert.annotations),
    startsAt: alert.startsAt,
    endsAt:
        alert.status === 'firing' || !alert.endsAt
            ? ALERTMANAGER_ZERO_TIME
            : alert.endsAt,
    generatorURL: alert.generatorURL ?? '',
    fingerprint: alert.fingerprint,
});

/**
 * Builds the Alertmanager webhook v4 body for one notification group.
 * Common labels and annotations, and the group status, are computed over
 * every alert in the group, including any cut by `maxAlerts`.
 */
export const buildAlertmanagerWebhookPayload = (
    input: AlertmanagerPayloadInput,
): AlertmanagerWebhookPayload => {
    const alerts = input.alerts.map(toWebhookAlert);
    const limit =
        input.maxAlerts && input.maxAlerts > 0
            ? Math.floor(input.maxAlerts)
            : alerts.length;
    const sent = alerts.slice(0, limit);
    return {
        version: '4',
        groupKey: input.groupKey,
        truncatedAlerts: alerts.length - sent.length,
        status: alerts.some((a) => a.status === 'firing')
            ? 'firing'
            : 'resolved',
        receiver: input.receiver,
        groupLabels: cleanPairs(input.groupLabels),
        commonLabels: commonPairs(alerts.map((a) => a.labels)),
        commonAnnotations: commonPairs(alerts.map((a) => a.annotations)),
        externalURL: input.externalURL,
        alerts: sent,
    };
};
