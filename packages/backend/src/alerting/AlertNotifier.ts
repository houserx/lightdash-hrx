// The notifier: Alertmanager dispatcher semantics over the database, driven
// by `flush()` and the injected clock (CONTRACTS 4.3, PROGRESS "Evaluation
// semantics"). Each flush routes every notifying series through its
// project's Notification Route tree, groups them per route and Contact
// Point, and sends each group that is due:
// - a new group once `now ≥ earliest startsAt + groupWait`;
// - a group with alerts not yet sent as firing once `now ≥ last send +
//   groupInterval`;
// - an unchanged group once `now ≥ last send + repeatInterval`.
// The send is claimed in `alert_notification_groups` before anything leaves
// the process, so concurrent or repeated flushes never send a group twice.
import {
    alertGroupKey,
    alertGroupLabels,
    buildAlertmanagerWebhookPayload,
    getErrorMessage,
    parsePrometheusDuration,
    routeAlert,
    type ContactPointIntegration,
    type NotificationRoute,
    type ResolvedNotificationRoute,
} from '@lightdash/common';
import Logger from '../logging/logger';
import {
    type ActiveAlert,
    type AlertNotificationModel,
    type NotificationContactPoint,
    type NotificationGroupState,
} from './AlertNotificationModel';

const WEBHOOK_TIMEOUT_MS = 10_000;

type NotificationRouteTreeSource = {
    find(projectUuid: string): Promise<NotificationRoute | undefined>;
};

type AlertNotifierDeps = {
    alertNotificationModel: AlertNotificationModel;
    notificationRouteModel: NotificationRouteTreeSource;
    secrets: { resolve(name: string): Promise<string | undefined> };
    clock: { now(): Date };
    siteUrl: string;
};

/** The alerts one route sends to one Contact Point together. */
export type NotificationGroup = {
    projectUuid: string;
    route: ResolvedNotificationRoute;
    contactPointSlug: string;
    groupKey: string;
    alerts: ActiveAlert[];
};

export const alertKey = (
    alert: Pick<ActiveAlert, 'ruleUuid' | 'fingerprint'>,
) => `${alert.ruleUuid}:${alert.fingerprint}`;

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
        (alert) => previous.sentAlerts[alertKey(alert)] !== 'firing',
    );
    const wait = changed
        ? group.route.groupInterval
        : group.route.repeatInterval;
    return (
        now.getTime() >=
        previous.lastSentAt.getTime() + parsePrometheusDuration(wait)
    );
};

/** Routes and groups one project's alerts through its tree. */
export const groupAlerts = (
    projectUuid: string,
    tree: NotificationRoute,
    alerts: ActiveAlert[],
): NotificationGroup[] => {
    const groups = new Map<string, NotificationGroup>();
    alerts.forEach((alert) => {
        routeAlert(tree, alert.labels).forEach((route) => {
            if (route.contactPoint === undefined) return;
            const groupKey = alertGroupKey(route, alert.labels);
            const id = JSON.stringify([route.contactPoint, groupKey]);
            const group = groups.get(id) ?? {
                projectUuid,
                route,
                contactPointSlug: route.contactPoint,
                groupKey,
                alerts: [],
            };
            group.alerts.push(alert);
            groups.set(id, group);
        });
    });
    return [...groups.values()];
};

const groupId = (
    group: Pick<
        NotificationGroupState,
        'projectUuid' | 'contactPointSlug' | 'groupKey'
    >,
) =>
    JSON.stringify([group.projectUuid, group.contactPointSlug, group.groupKey]);

export class AlertNotifier {
    constructor(private readonly deps: AlertNotifierDeps) {}

    /** Sends every notification group that is due now. */
    async flush(): Promise<void> {
        const now = this.deps.clock.now();
        const [alerts, states] = await Promise.all([
            this.deps.alertNotificationModel.listActiveAlerts(),
            this.deps.alertNotificationModel.listGroups(),
        ]);
        const alertsByProject = new Map<string, ActiveAlert[]>();
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
        const groups = groupAlerts(projectUuid, tree, alerts);
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
            previous,
            sentAlerts: Object.fromEntries(
                group.alerts.map((alert) => [alertKey(alert), 'firing']),
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
        alerts: ActiveAlert[],
        contactPoint: NotificationContactPoint,
        integration: ContactPointIntegration,
        now: Date,
    ): Promise<void> {
        // Only generic webhooks so far; the other integration types are
        // added by their own features (alert-contact-*).
        if (integration.type !== 'webhook') return;
        const siteUrl = this.deps.siteUrl.replace(/\/+$/, '');
        const payload = buildAlertmanagerWebhookPayload({
            receiver: contactPoint.name,
            groupKey: group.groupKey,
            groupLabels: alertGroupLabels(group.route, alerts[0].labels),
            externalURL: siteUrl,
            maxAlerts: integration.maxAlerts,
            alerts: alerts.map((alert) => ({
                status: 'firing',
                labels: alert.labels,
                annotations: alert.annotations,
                startsAt: alert.startsAt.toISOString(),
                generatorURL: `${siteUrl}/projects/${group.projectUuid}/alerting/rules/${alert.ruleUuid}`,
                fingerprint: alert.fingerprint,
            })),
        });
        let error: string | null = null;
        try {
            await this.postWebhook(integration, payload);
        } catch (e) {
            error = getErrorMessage(e);
            Logger.warn(
                `Alerting notification to contact point ${contactPoint.uuid} failed: ${error}`,
            );
        }
        await this.deps.alertNotificationModel.insertNotification({
            projectUuid: group.projectUuid,
            ruleUuids: [...new Set(alerts.map((alert) => alert.ruleUuid))],
            contactPointUuid: contactPoint.uuid,
            integrationType: integration.type,
            groupKey: group.groupKey,
            status: error === null ? 'sent' : 'failed',
            attempts: 1,
            alerts: alerts.map((alert) => ({
                ruleUuid: alert.ruleUuid,
                fingerprint: alert.fingerprint,
                status: 'firing',
            })),
            payload,
            error,
            at: now,
        });
    }

    private async postWebhook(
        integration: Extract<ContactPointIntegration, { type: 'webhook' }>,
        payload: unknown,
    ): Promise<void> {
        const headers: Record<string, string> = {
            'content-type': 'application/json',
        };
        if (integration.authorization) {
            const { secretRef } = integration.authorization;
            const secret = await this.deps.secrets.resolve(secretRef);
            if (secret === undefined) {
                throw new Error(`Secret "${secretRef}" could not be resolved`);
            }
            headers.authorization = `Bearer ${secret}`;
        }
        const response = await fetch(integration.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        // Drain the body so the connection is released.
        await response.arrayBuffer().catch(() => undefined);
        if (!response.ok) {
            throw new Error(
                `Webhook responded with HTTP ${response.status} ${response.statusText}`.trim(),
            );
        }
    }
}
