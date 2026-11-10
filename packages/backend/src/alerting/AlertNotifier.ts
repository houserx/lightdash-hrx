// The notifier: Alertmanager dispatcher semantics over the database, driven
// by `flush()` and the injected clock (CONTRACTS 4.3, PROGRESS "Evaluation
// semantics"). Each flush routes every notifying series through its
// project's Notification Route tree, groups them per route and Contact
// Point, and sends each group that is due:
// - a new group once `now ≥ earliest startsAt + groupWait`;
// - a group with alerts not yet sent as firing once `now ≥ last send +
//   groupInterval`;
// - an unchanged group once `now ≥ last send + repeatInterval`.
// A series that was sent as firing and has stopped notifying stays in its
// group as a resolved alert (with `endsAt`) until the group's next send,
// which counts as a change. Integrations with `disableResolveMessage` leave
// resolved alerts out, and send nothing when only resolved alerts are left.
// The send is claimed in `alert_notification_groups` before anything leaves
// the process, so concurrent or repeated flushes never send a group twice.
// Shadow rules' alerts are grouped and timed the same way, in groups of their
// own, but each due send is only recorded in the send log as `shadow` (with
// the payload that would have gone out); nothing is sent.
import {
    alertGroupKey,
    alertGroupLabels,
    alertLabelsFingerprint,
    buildAlertmanagerWebhookPayload,
    getErrorMessage,
    parsePrometheusDuration,
    routeAlert,
    type ContactPointIntegration,
    type ContactPointTestResult,
    type NotificationRoute,
    type ResolvedNotificationRoute,
} from '@lightdash/common';
import Logger from '../logging/logger';
import {
    type ActiveAlert,
    type AlertNotificationModel,
    type NotificationContactPoint,
    type NotificationGroupState,
    type NotificationLogEntry,
    type ResolvedAlert,
} from './AlertNotificationModel';
import { buildEmailMessage, type EmailMessage } from './emailMessage';
import {
    buildAlertTemplateData,
    buildSlackAppText,
    buildSlackWebhookPayload,
    renderSlackMessage,
} from './slackMessage';

const WEBHOOK_TIMEOUT_MS = 10_000;

type NotificationRouteTreeSource = {
    find(projectUuid: string): Promise<NotificationRoute | undefined>;
};

type AlertNotifierDeps = {
    alertNotificationModel: AlertNotificationModel;
    notificationRouteModel: NotificationRouteTreeSource;
    secrets: { resolve(name: string): Promise<string | undefined> };
    slackApp: SlackAppClient;
    email: AlertEmailClient;
    clock: { now(): Date };
    retry: NotificationRetryPolicy;
    siteUrl: string;
};

/**
 * The organization's installed Lightdash Slack app. `postMessage` throws when
 * the app isn't installed for the organization.
 */
export type SlackAppClient = {
    postMessage(args: {
        organizationUuid: string;
        channel: string;
        text: string;
        blocks?: unknown[];
    }): Promise<void>;
};

/** Lightdash's email client: one message to every address in `to`. */
export type AlertEmailClient = {
    sendEmail(message: {
        to: string[];
        subject: string;
        text: string;
        html?: string;
    }): Promise<void>;
};

/** Exponential backoff for one send: `initialDelayMs`, then doubling. */
export type NotificationRetryPolicy = {
    maxAttempts: number;
    initialDelayMs: number;
};

/**
 * A send failure that says whether trying again could help. Any other error
 * (connection refused, timeout) is treated as retryable.
 */
export class NotificationSendError extends Error {
    constructor(
        message: string,
        readonly retryable: boolean,
    ) {
        super(message);
        this.name = 'NotificationSendError';
    }
}

const isRetryable = (error: unknown) =>
    !(error instanceof NotificationSendError) || error.retryable;

/**
 * Runs `send` until it succeeds, fails with a non-retryable error, or has
 * been tried `maxAttempts` times, waiting `initialDelayMs * 2^(n-1)` (real
 * time) before retry n. Returns the attempts made and the last error.
 */
export const sendWithRetry = async (
    send: () => Promise<void>,
    policy: NotificationRetryPolicy,
    sleep: (ms: number) => Promise<void> = (ms) =>
        new Promise((resolve) => {
            setTimeout(resolve, ms);
        }),
): Promise<{ attempts: number; error: string | null }> => {
    const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
    for (let attempt = 1; ; attempt += 1) {
        try {
            // Attempts are sequential by design.
            // eslint-disable-next-line no-await-in-loop
            await send();
            return { attempts: attempt, error: null };
        } catch (e) {
            if (attempt >= maxAttempts || !isRetryable(e)) {
                return { attempts: attempt, error: getErrorMessage(e) };
            }
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(Math.max(0, policy.initialDelayMs) * 2 ** (attempt - 1));
    }
};

/** The synthetic alert 'Send test notification' sends (as Grafana's does). */
export const TEST_ALERT_LABELS: Readonly<Record<string, string>> = {
    alertname: 'TestAlert',
    instance: 'Lightdash',
};
export const TEST_ALERT_ANNOTATIONS: Readonly<Record<string, string>> = {
    summary: 'Notification test',
    description:
        'This is a test notification from Lightdash alerting. If you can read it, this Contact Point works.',
};

// The outcome of a test notification lives in common: the frontend reads it.
export type { ContactPointTestResult } from '@lightdash/common';

/** A firing alert, or a resolved one (which has `endsAt`). */
export type NotificationAlert = ActiveAlert | ResolvedAlert;

/** The alerts one route sends to one Contact Point together. */
export type NotificationGroup = {
    projectUuid: string;
    route: ResolvedNotificationRoute;
    contactPointSlug: string;
    groupKey: string;
    /** Every alert is of a shadow rule: record the send, never make it. */
    shadow: boolean;
    alerts: NotificationAlert[];
};

export const alertKey = (
    alert: Pick<ActiveAlert, 'ruleUuid' | 'fingerprint'>,
) => `${alert.ruleUuid}:${alert.fingerprint}`;

export const alertStatus = (alert: NotificationAlert): 'firing' | 'resolved' =>
    'endsAt' in alert ? 'resolved' : 'firing';

/** Whether `group` should be sent at `now`, given its last send. */
export const isNotificationGroupDue = (
    group: Pick<NotificationGroup, 'route' | 'alerts'>,
    previous:
        | Pick<NotificationGroupState, 'lastSentAt' | 'sentAlerts'>
        | undefined,
    now: Date,
): boolean => {
    if (group.alerts.length === 0) return false;
    if (!previous) {
        const firstStartsAt = Math.min(
            ...group.alerts.map((alert) => alert.startsAt.getTime()),
        );
        return (
            now.getTime() >=
            firstStartsAt + parsePrometheusDuration(group.route.groupWait)
        );
    }
    const changed = group.alerts.some(
        (alert) => previous.sentAlerts[alertKey(alert)] !== alertStatus(alert),
    );
    const wait = changed
        ? group.route.groupInterval
        : group.route.repeatInterval;
    return (
        now.getTime() >=
        previous.lastSentAt.getTime() + parsePrometheusDuration(wait)
    );
};

const groupId = (
    group: Pick<
        NotificationGroupState,
        'projectUuid' | 'contactPointSlug' | 'groupKey' | 'shadow'
    >,
) =>
    JSON.stringify([
        group.projectUuid,
        group.contactPointSlug,
        group.groupKey,
        group.shadow,
    ]);

/**
 * Routes and groups one project's alerts through its tree. A resolved alert
 * only joins a group that last sent it as firing (`sentAlerts`, by group id).
 * Shadow rules' alerts never share a group with other alerts.
 */
export const groupAlerts = (
    projectUuid: string,
    tree: NotificationRoute,
    alerts: NotificationAlert[],
    sentAlerts: (
        id: string,
    ) => NotificationGroupState['sentAlerts'] | undefined = () => undefined,
): NotificationGroup[] => {
    const groups = new Map<string, NotificationGroup>();
    alerts.forEach((alert) => {
        routeAlert(tree, alert.labels).forEach((route) => {
            if (route.contactPoint === undefined) return;
            const groupKey = alertGroupKey(route, alert.labels);
            if (
                alertStatus(alert) === 'resolved' &&
                sentAlerts(
                    groupId({
                        projectUuid,
                        contactPointSlug: route.contactPoint,
                        groupKey,
                        shadow: alert.shadow,
                    }),
                )?.[alertKey(alert)] !== 'firing'
            ) {
                return;
            }
            const id = JSON.stringify([
                route.contactPoint,
                groupKey,
                alert.shadow,
            ]);
            const group = groups.get(id) ?? {
                projectUuid,
                route,
                contactPointSlug: route.contactPoint,
                groupKey,
                shadow: alert.shadow,
                alerts: [],
            };
            group.alerts.push(alert);
            groups.set(id, group);
        });
    });
    return [...groups.values()];
};

/** POSTs `payload` as JSON; a non-2xx response throws a NotificationSendError. */
const postJson = async (
    what: string,
    url: string,
    headers: Record<string, string>,
    payload: unknown,
): Promise<void> => {
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    // Drain the body so the connection is released.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) {
        throw new NotificationSendError(
            `${what} responded with HTTP ${response.status} ${response.statusText}`.trim(),
            // 4xx means the request itself is wrong; sending it again won't
            // help.
            response.status < 400 || response.status >= 500,
        );
    }
};

const notificationStatus = (
    shadow: boolean,
    error: string | null,
): NotificationLogEntry['status'] => {
    if (shadow) return 'shadow';
    return error === null ? 'sent' : 'failed';
};

export class AlertNotifier {
    constructor(private readonly deps: AlertNotifierDeps) {}

    /** Sends every notification group that is due now. */
    async flush(): Promise<void> {
        const now = this.deps.clock.now();
        const [alerts, states] = await Promise.all([
            this.deps.alertNotificationModel.listActiveAlerts(),
            this.deps.alertNotificationModel.listGroups(),
        ]);
        // Projects with only sent groups left may have resolved alerts.
        const alertsByProject = new Map<string, ActiveAlert[]>(
            states.map((state) => [state.projectUuid, []]),
        );
        alerts.forEach((alert) => {
            alertsByProject.set(alert.projectUuid, [
                ...(alertsByProject.get(alert.projectUuid) ?? []),
                alert,
            ]);
        });
        const statesById = new Map(
            states.map((state) => [groupId(state), state]),
        );
        const liveGroupIds = new Set<string>();
        for (const [projectUuid, projectAlerts] of alertsByProject) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const groups = await this.flushProject(
                    projectUuid,
                    projectAlerts,
                    statesById,
                    now,
                );
                groups.forEach((id) => liveGroupIds.add(id));
            } catch (error) {
                // One project's broken tree must not stop the others. Its
                // groups stay as they are and are retried next flush.
                states
                    .filter((state) => state.projectUuid === projectUuid)
                    .forEach((state) => liveGroupIds.add(groupId(state)));
                Logger.error(
                    `Alerting notifier could not flush project ${projectUuid}: ${getErrorMessage(
                        error,
                    )}`,
                );
            }
        }
        // A group without alerts is over; if they fire again it is a new
        // group and waits group_wait again.
        await this.deps.alertNotificationModel.deleteGroups(
            states
                .filter((state) => !liveGroupIds.has(groupId(state)))
                .map((state) => state.uuid),
        );
    }

    /** Sends the project's due groups; returns the ids of its live groups. */
    private async flushProject(
        projectUuid: string,
        alerts: ActiveAlert[],
        statesById: Map<string, NotificationGroupState>,
        now: Date,
    ): Promise<string[]> {
        const tree = await this.deps.notificationRouteModel.find(projectUuid);
        if (!tree) return [];
        const resolved = await this.listResolvedAlerts(
            projectUuid,
            alerts,
            statesById,
        );
        const groups = groupAlerts(
            projectUuid,
            tree,
            [...alerts, ...resolved],
            (id) => statesById.get(id)?.sentAlerts,
        );
        const contactPoints = new Map(
            (
                await this.deps.alertNotificationModel.listContactPoints(
                    projectUuid,
                )
            ).map((contactPoint) => [contactPoint.slug, contactPoint]),
        );
        for (const group of groups) {
            const contactPoint = contactPoints.get(group.contactPointSlug);
            if (contactPoint) {
                // Groups are sent one at a time, in order.
                // eslint-disable-next-line no-await-in-loop
                await this.sendIfDue(
                    group,
                    statesById.get(groupId(group)),
                    contactPoint,
                    now,
                );
            }
        }
        return groups.map(groupId);
    }

    /** Series the project's groups sent as firing that no longer notify. */
    private async listResolvedAlerts(
        projectUuid: string,
        alerts: ActiveAlert[],
        statesById: Map<string, NotificationGroupState>,
    ): Promise<ResolvedAlert[]> {
        const active = new Set(alerts.map(alertKey));
        const keys = new Map<
            string,
            { ruleUuid: string; fingerprint: string }
        >();
        statesById.forEach((state) => {
            if (state.projectUuid !== projectUuid) return;
            Object.entries(state.sentAlerts).forEach(([key, status]) => {
                if (status !== 'firing' || active.has(key)) return;
                const separator = key.indexOf(':');
                keys.set(key, {
                    ruleUuid: key.slice(0, separator),
                    fingerprint: key.slice(separator + 1),
                });
            });
        });
        const resolved =
            await this.deps.alertNotificationModel.listResolvedAlerts([
                ...keys.values(),
            ]);
        return resolved.filter((alert) => alert.projectUuid === projectUuid);
    }

    /** Claims and sends `group` if it is due; a lost claim sends nothing. */
    private async sendIfDue(
        group: NotificationGroup,
        previous: NotificationGroupState | undefined,
        contactPoint: NotificationContactPoint,
        now: Date,
    ): Promise<void> {
        if (!isNotificationGroupDue(group, previous, now)) return;
        const claimed = await this.deps.alertNotificationModel.claimGroupSend({
            projectUuid: group.projectUuid,
            contactPointSlug: group.contactPointSlug,
            groupKey: group.groupKey,
            shadow: group.shadow,
            previous,
            // A resolved alert leaves the group once it is sent.
            sentAlerts: Object.fromEntries(
                group.alerts
                    .filter((alert) => alertStatus(alert) === 'firing')
                    .map((alert) => [alertKey(alert), 'firing']),
            ),
            at: now,
        });
        if (claimed) await this.send(group, contactPoint, now);
    }

    private async send(
        group: NotificationGroup,
        contactPoint: NotificationContactPoint,
        now: Date,
    ): Promise<void> {
        const alerts = [...group.alerts].sort((a, b) =>
            alertKey(a).localeCompare(alertKey(b)),
        );
        for (const integration of contactPoint.integrations) {
            // eslint-disable-next-line no-await-in-loop
            await this.sendIntegration(
                group,
                alerts,
                contactPoint,
                integration,
                now,
            );
        }
    }

    private async sendIntegration(
        group: NotificationGroup,
        groupAlertsSorted: NotificationAlert[],
        contactPoint: NotificationContactPoint,
        integration: ContactPointIntegration,
        now: Date,
    ): Promise<void> {
        const alerts = integration.disableResolveMessage
            ? groupAlertsSorted.filter(
                  (alert) => alertStatus(alert) === 'firing',
              )
            : groupAlertsSorted;
        if (alerts.length === 0) return;
        const message = this.buildDelivery({
            group,
            alerts,
            contactPoint,
            integration,
            now,
            generatorURL: (alert) =>
                `${this.siteUrl()}/projects/${group.projectUuid}/alerting/rules/${alert.ruleUuid}`,
        });
        const { payload } = message;
        // A shadow send is only recorded; a message that can't be built is
        // still recorded, with the reason.
        const { attempts, error } = group.shadow
            ? { attempts: 0, error: message.error ?? null }
            : await sendWithRetry(message.post, this.deps.retry);
        if (error !== null && !group.shadow) {
            Logger.warn(
                `Alerting notification to contact point ${contactPoint.uuid} failed after ${attempts} attempt(s): ${error}`,
            );
        }
        await this.deps.alertNotificationModel.insertNotification({
            projectUuid: group.projectUuid,
            ruleUuids: [...new Set(alerts.map((alert) => alert.ruleUuid))],
            contactPointUuid: contactPoint.uuid,
            integrationType: integration.type,
            groupKey: group.groupKey,
            status: notificationStatus(group.shadow, error),
            attempts,
            alerts: alerts.map((alert) => ({
                ruleUuid: alert.ruleUuid,
                fingerprint: alert.fingerprint,
                status: alertStatus(alert),
            })),
            payload,
            error,
            at: now,
        });
    }

    /**
     * Sends a synthetic firing `TestAlert` through every integration of
     * `contactPoint`, one attempt each, and reports each outcome. Nothing is
     * written to the send log or the notification groups.
     */
    async sendTest(
        projectUuid: string,
        contactPoint: NotificationContactPoint,
    ): Promise<ContactPointTestResult> {
        const now = this.deps.clock.now();
        const labels = { ...TEST_ALERT_LABELS };
        const alert: ActiveAlert = {
            projectUuid,
            ruleUuid: '',
            fingerprint: alertLabelsFingerprint(labels),
            labels,
            annotations: { ...TEST_ALERT_ANNOTATIONS },
            startsAt: now,
            shadow: false,
        };
        const group: NotificationGroup = {
            projectUuid,
            route: {
                id: 'test',
                path: [],
                contactPoint: contactPoint.slug,
                groupBy: [],
                groupWait: '0s',
                groupInterval: '0s',
                repeatInterval: '0s',
            },
            contactPointSlug: contactPoint.slug,
            groupKey: `test:${contactPoint.slug}`,
            shadow: false,
            alerts: [alert],
        };
        const results: ContactPointTestResult['results'] = [];
        for (const integration of contactPoint.integrations) {
            // Integrations are tried one at a time, in order.
            const { post } = this.buildDelivery({
                group,
                alerts: [alert],
                contactPoint,
                integration,
                now,
                generatorURL: () =>
                    `${this.siteUrl()}/projects/${projectUuid}/alerting/contact-points/${contactPoint.uuid}`,
            });
            // A test reports at once; it is not retried.
            // eslint-disable-next-line no-await-in-loop
            const { error } = await sendWithRetry(post, {
                maxAttempts: 1,
                initialDelayMs: 0,
            });
            results.push(
                error === null
                    ? { type: integration.type, ok: true }
                    : { type: integration.type, ok: false, error },
            );
        }
        return { ok: results.every((result) => result.ok), results };
    }

    private siteUrl(): string {
        return this.deps.siteUrl.replace(/\/+$/, '');
    }

    /**
     * Builds one integration's message for `alerts`: the payload to record
     * and `post`, which sends it. A message that can't be built has `error`
     * and a `post` that fails with it, without retries.
     */
    private buildDelivery({
        group,
        alerts,
        contactPoint,
        integration,
        now,
        generatorURL,
    }: {
        group: NotificationGroup;
        alerts: NotificationAlert[];
        contactPoint: NotificationContactPoint;
        integration: ContactPointIntegration;
        now: Date;
        generatorURL: (alert: NotificationAlert) => string;
    }): { payload: unknown; post: () => Promise<void>; error?: string } {
        const siteUrl = this.siteUrl();
        const groupLabels = alertGroupLabels(group.route, alerts[0].labels);
        let payload: unknown = null;
        let post: () => Promise<void>;
        if (
            integration.type === 'webhook' ||
            integration.type === 'incident_io'
        ) {
            // incident.io takes the same Alertmanager v4 payload (CONTRACTS
            // 4.3), with a bearer token from a secret.
            const webhookPayload = buildAlertmanagerWebhookPayload({
                receiver: contactPoint.name,
                groupKey: group.groupKey,
                groupLabels,
                externalURL: siteUrl,
                maxAlerts:
                    integration.type === 'webhook'
                        ? integration.maxAlerts
                        : undefined,
                alerts: alerts.map((alert) => ({
                    status: alertStatus(alert),
                    labels: alert.labels,
                    annotations: alert.annotations,
                    startsAt: alert.startsAt.toISOString(),
                    endsAt:
                        'endsAt' in alert
                            ? alert.endsAt.toISOString()
                            : undefined,
                    generatorURL: generatorURL(alert),
                    fingerprint: alert.fingerprint,
                })),
            });
            payload = webhookPayload;
            post =
                integration.type === 'webhook'
                    ? () => this.postWebhook(integration, webhookPayload)
                    : () => this.postIncidentIo(integration, webhookPayload);
        } else {
            const data = buildAlertTemplateData({
                receiver: contactPoint.name,
                groupLabels,
                externalURL: siteUrl,
                alerts: alerts.map((alert) => ({
                    status: alertStatus(alert),
                    labels: alert.labels,
                    annotations: alert.annotations,
                    startsAt: alert.startsAt,
                    endsAt: 'endsAt' in alert ? alert.endsAt : undefined,
                    fingerprint: alert.fingerprint,
                    generatorURL: generatorURL(alert),
                })),
            });
            if (integration.type === 'email') {
                const email = {
                    to: [...integration.addresses],
                    ...buildEmailMessage({
                        alerts: data.Alerts,
                        groupLabels,
                    }),
                };
                payload = email;
                post = () => this.sendEmail(email);
            } else {
                try {
                    const message = renderSlackMessage(integration, data);
                    if (integration.type === 'slack_webhook') {
                        const slackPayload = buildSlackWebhookPayload({
                            ...message,
                            status: data.Status,
                            at: now,
                        });
                        payload = slackPayload;
                        post = () =>
                            this.postSlackWebhook(integration, slackPayload);
                    } else {
                        const slackMessage = {
                            channel: integration.channel,
                            text: buildSlackAppText(message),
                        };
                        payload = slackMessage;
                        post = () =>
                            this.postSlackApp(group.projectUuid, slackMessage);
                    }
                } catch (e) {
                    // A template that doesn't render is a configuration error:
                    // nothing is sent and trying again won't help.
                    const renderError = new NotificationSendError(
                        getErrorMessage(e),
                        false,
                    );
                    return {
                        payload,
                        post: () => Promise.reject(renderError),
                        error: renderError.message,
                    };
                }
            }
        }
        return { payload, post };
    }

    private async postWebhook(
        integration: Extract<ContactPointIntegration, { type: 'webhook' }>,
        payload: unknown,
    ): Promise<void> {
        const headers: Record<string, string> = {
            'content-type': 'application/json',
        };
        if (integration.authorization) {
            const secret = await this.resolveSecret(
                integration.authorization.secretRef,
            );
            headers.authorization = `Bearer ${secret}`;
        }
        await postJson('Webhook', integration.url, headers, payload);
    }

    private async postIncidentIo(
        integration: Extract<ContactPointIntegration, { type: 'incident_io' }>,
        payload: unknown,
    ): Promise<void> {
        const token = await this.resolveSecret(integration.token.secretRef);
        await postJson(
            'incident.io',
            integration.url,
            {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            payload,
        );
    }

    private async postSlackWebhook(
        integration: Extract<
            ContactPointIntegration,
            { type: 'slack_webhook' }
        >,
        payload: unknown,
    ): Promise<void> {
        const url = await this.resolveSecret(integration.url.secretRef);
        await postJson(
            'Slack webhook',
            url,
            { 'content-type': 'application/json' },
            payload,
        );
    }

    private async postSlackApp(
        projectUuid: string,
        message: { channel: string; text: string },
    ): Promise<void> {
        const organizationUuid =
            await this.deps.alertNotificationModel.findProjectOrganizationUuid(
                projectUuid,
            );
        if (organizationUuid === undefined) {
            throw new NotificationSendError(
                `Project ${projectUuid} has no organization`,
                false,
            );
        }
        try {
            await this.deps.slackApp.postMessage({
                organizationUuid,
                ...message,
            });
        } catch (e) {
            if (e instanceof NotificationSendError) throw e;
            // The app not being installed is a configuration error: trying
            // again won't help. Anything else (Slack down, rate limited) is
            // retried.
            const reason = getErrorMessage(e);
            throw new NotificationSendError(
                reason,
                !/not installed/i.test(reason),
            );
        }
    }

    private async sendEmail(
        message: EmailMessage & { to: string[] },
    ): Promise<void> {
        if (message.to.length === 0) {
            throw new NotificationSendError(
                'Email contact point has no addresses',
                false,
            );
        }
        await this.deps.email.sendEmail(message);
    }

    /** A missing secret is a configuration error, so it is not retried. */
    private async resolveSecret(secretRef: string): Promise<string> {
        const secret = await this.deps.secrets.resolve(secretRef);
        if (secret === undefined) {
            throw new NotificationSendError(
                `Secret "${secretRef}" could not be resolved`,
                false,
            );
        }
        return secret;
    }
}
