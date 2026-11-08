import {
    type AlertInstanceState,
    type ContactPointIntegration,
} from '@lightdash/common';
import { type Knex } from 'knex';
import { AlertInstancesTableName, AlertRulesTableName } from './AlertRuleModel';
import { AlertStateHistoryTableName } from './AlertStateHistoryModel';
import { ContactPointsTableName } from './ContactPointModel';

// Tables from migrations 20261108120000_create_alerting_tables and
// 20261108160000_create_alert_notification_groups.
export const AlertNotificationsTableName = 'alert_notifications';
export const AlertNotificationGroupsTableName = 'alert_notification_groups';

/** Instance states that notify as firing alerts. */
export const NOTIFYING_ALERT_STATES: readonly AlertInstanceState[] = [
    'firing',
    'nodata',
    'error',
];

/** A series that should currently be notified as firing. */
export type ActiveAlert = {
    projectUuid: string;
    ruleUuid: string;
    fingerprint: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    /** When the series entered its current (notifying) state. */
    startsAt: Date;
};

/** A series that was sent as firing and has since stopped notifying. */
export type ResolvedAlert = ActiveAlert & {
    /** When the series left its notifying state. */
    endsAt: Date;
};

export type NotificationGroupState = {
    uuid: string;
    projectUuid: string;
    contactPointSlug: string;
    groupKey: string;
    lastSentAt: Date;
    /** `<ruleUuid>:<fingerprint>` → the status it was last sent with. */
    sentAlerts: Record<string, 'firing' | 'resolved'>;
};

export type NotificationContactPoint = {
    uuid: string;
    slug: string;
    name: string;
    integrations: ContactPointIntegration[];
};

export type NotificationLogEntry = {
    projectUuid: string;
    ruleUuids: string[];
    contactPointUuid: string;
    integrationType: string;
    groupKey: string;
    status: 'sent' | 'failed';
    attempts: number;
    alerts: { ruleUuid: string; fingerprint: string; status: string }[];
    payload: unknown;
    error: string | null;
    at: Date;
};

type DbGroup = {
    alert_notification_group_uuid: string;
    project_uuid: string;
    contact_point_slug: string;
    group_key: string;
    last_sent_at: Date;
    sent_alerts: Record<string, 'firing' | 'resolved'>;
};

const toGroupState = (row: DbGroup): NotificationGroupState => ({
    uuid: row.alert_notification_group_uuid,
    projectUuid: row.project_uuid,
    contactPointSlug: row.contact_point_slug,
    groupKey: row.group_key,
    lastSentAt: row.last_sent_at,
    sentAlerts: row.sent_alerts,
});

/** Storage for the notifier: active alerts, group state and the send log. */
export class AlertNotificationModel {
    constructor(private readonly database: Knex) {}

    /** Every notifying series of non-shadow rules, across projects. */
    async listActiveAlerts(): Promise<ActiveAlert[]> {
        const rows = await this.database(`${AlertInstancesTableName} as i`)
            .join(
                `${AlertRulesTableName} as r`,
                'r.alert_rule_uuid',
                'i.alert_rule_uuid',
            )
            .whereIn('i.state', NOTIFYING_ALERT_STATES)
            // Shadow rules never notify (alert-shadow-no-notify logs them).
            .where('r.shadow', false)
            .orderBy([
                { column: 'r.project_uuid' },
                { column: 'i.alert_rule_uuid' },
                { column: 'i.fingerprint' },
            ])
            .select<
                {
                    project_uuid: string;
                    alert_rule_uuid: string;
                    fingerprint: string;
                    labels: Record<string, string>;
                    annotations: Record<string, string>;
                    state_since: Date;
                }[]
            >(
                'r.project_uuid',
                'i.alert_rule_uuid',
                'i.fingerprint',
                'i.labels',
                'i.annotations',
                'i.state_since',
            );
        return rows.map((row) => ({
            projectUuid: row.project_uuid,
            ruleUuid: row.alert_rule_uuid,
            fingerprint: row.fingerprint,
            labels: row.labels,
            annotations: row.annotations,
            startsAt: row.state_since,
        }));
    }

    /**
     * The given series as resolved alerts, read from the state history: the
     * labels and time of their last transition out of a notifying state
     * (`endsAt`) and of the last transition into one before it (`startsAt`).
     * Series with no such transition, or of shadow rules, are left out.
     */
    async listResolvedAlerts(
        keys: { ruleUuid: string; fingerprint: string }[],
    ): Promise<ResolvedAlert[]> {
        if (keys.length === 0) return [];
        const notifying = NOTIFYING_ALERT_STATES.map(() => '?').join(', ');
        const { rows } = await this.database.raw<{
            rows: {
                project_uuid: string;
                alert_rule_uuid: string;
                fingerprint: string;
                labels: Record<string, string>;
                annotations: Record<string, string>;
                starts_at: Date | null;
                ends_at: Date;
            }[];
        }>(
            `
            WITH wanted AS (
                SELECT * FROM jsonb_to_recordset(?::jsonb)
                    AS w (alert_rule_uuid uuid, fingerprint text)
            ),
            ended AS (
                SELECT DISTINCT ON (h.alert_rule_uuid, h.fingerprint)
                    h.project_uuid, h.alert_rule_uuid, h.fingerprint,
                    h.labels, h.at AS ends_at
                FROM ${AlertStateHistoryTableName} h
                JOIN wanted w
                    ON w.alert_rule_uuid = h.alert_rule_uuid
                    AND w.fingerprint = h.fingerprint
                WHERE h.previous_state IN (${notifying})
                    AND h.state NOT IN (${notifying})
                ORDER BY h.alert_rule_uuid, h.fingerprint, h.at DESC
            )
            SELECT
                e.project_uuid, e.alert_rule_uuid, e.fingerprint, e.labels,
                e.ends_at,
                COALESCE(i.annotations, r.annotations) AS annotations,
                (
                    SELECT max(s.at)
                    FROM ${AlertStateHistoryTableName} s
                    WHERE s.alert_rule_uuid = e.alert_rule_uuid
                        AND s.fingerprint = e.fingerprint
                        AND s.state IN (${notifying})
                        AND s.at <= e.ends_at
                ) AS starts_at
            FROM ended e
            JOIN ${AlertRulesTableName} r
                ON r.alert_rule_uuid = e.alert_rule_uuid
            LEFT JOIN ${AlertInstancesTableName} i
                ON i.alert_rule_uuid = e.alert_rule_uuid
                AND i.fingerprint = e.fingerprint
            WHERE r.shadow = false
            ORDER BY e.project_uuid, e.alert_rule_uuid, e.fingerprint
            `,
            [
                JSON.stringify(
                    keys.map((key) => ({
                        alert_rule_uuid: key.ruleUuid,
                        fingerprint: key.fingerprint,
                    })),
                ),
                ...NOTIFYING_ALERT_STATES,
                ...NOTIFYING_ALERT_STATES,
                ...NOTIFYING_ALERT_STATES,
            ],
        );
        return rows.map((row) => ({
            projectUuid: row.project_uuid,
            ruleUuid: row.alert_rule_uuid,
            fingerprint: row.fingerprint,
            labels: row.labels,
            annotations: row.annotations,
            startsAt: row.starts_at ?? row.ends_at,
            endsAt: row.ends_at,
        }));
    }

    async listGroups(): Promise<NotificationGroupState[]> {
        const rows = await this.database(
            AlertNotificationGroupsTableName,
        ).select<DbGroup[]>('*');
        return rows.map(toGroupState);
    }

    async listContactPoints(
        projectUuid: string,
    ): Promise<NotificationContactPoint[]> {
        const rows = await this.database(ContactPointsTableName)
            .where('project_uuid', projectUuid)
            .select<
                {
                    contact_point_uuid: string;
                    slug: string;
                    name: string;
                    integrations: ContactPointIntegration[];
                }[]
            >('contact_point_uuid', 'slug', 'name', 'integrations');
        return rows.map((row) => ({
            uuid: row.contact_point_uuid,
            slug: row.slug,
            name: row.name,
            integrations: row.integrations,
        }));
    }

    /**
     * Claims the right to send a group, recording the send up front. With
     * `previous` it only succeeds if nobody else sent the group since it was
     * read; without it, only if the group has no row yet. Either way at
     * most one notifier wins, so a group is never sent twice.
     */
    async claimGroupSend(args: {
        projectUuid: string;
        contactPointSlug: string;
        groupKey: string;
        previous: NotificationGroupState | undefined;
        sentAlerts: Record<string, 'firing' | 'resolved'>;
        at: Date;
    }): Promise<boolean> {
        const sentAlerts = JSON.stringify(args.sentAlerts);
        if (args.previous) {
            const updated = await this.database(
                AlertNotificationGroupsTableName,
            )
                .where({
                    alert_notification_group_uuid: args.previous.uuid,
                    last_sent_at: args.previous.lastSentAt,
                })
                .update({ last_sent_at: args.at, sent_alerts: sentAlerts });
            return updated === 1;
        }
        const inserted = await this.database(AlertNotificationGroupsTableName)
            .insert({
                project_uuid: args.projectUuid,
                contact_point_slug: args.contactPointSlug,
                group_key: args.groupKey,
                last_sent_at: args.at,
                sent_alerts: sentAlerts,
                created_at: args.at,
            })
            .onConflict(['project_uuid', 'contact_point_slug', 'group_key'])
            .ignore()
            .returning('alert_notification_group_uuid');
        return inserted.length === 1;
    }

    /** Forgets groups that no longer have alerts. */
    async deleteGroups(uuids: string[]): Promise<void> {
        if (uuids.length === 0) return;
        await this.database(AlertNotificationGroupsTableName)
            .whereIn('alert_notification_group_uuid', uuids)
            .delete();
    }

    async insertNotification(entry: NotificationLogEntry): Promise<void> {
        await this.database(AlertNotificationsTableName).insert({
            project_uuid: entry.projectUuid,
            // The column holds one rule; groups spanning rules keep every
            // rule in `alerts`.
            alert_rule_uuid:
                entry.ruleUuids.length === 1 ? entry.ruleUuids[0] : null,
            contact_point_uuid: entry.contactPointUuid,
            integration_type: entry.integrationType,
            group_key: entry.groupKey,
            status: entry.status,
            attempts: entry.attempts,
            alerts: JSON.stringify(entry.alerts),
            payload: JSON.stringify(entry.payload),
            error: entry.error,
            created_at: entry.at,
            sent_at: entry.status === 'sent' ? entry.at : null,
        });
    }
}
