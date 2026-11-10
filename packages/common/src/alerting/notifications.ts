// The notification log of Alert Rules (ENG-1799): one entry per send to a
// Contact Point integration, whether it was sent, failed or only recorded
// for a shadow rule.

/** `shadow`: a shadow rule would have notified; nothing was sent. */
export type AlertNotificationStatus = 'sent' | 'failed' | 'shadow';

/** One alert of a notification and the status it was sent with. */
export type AlertNotificationAlert = {
    ruleUuid: string;
    fingerprint: string;
    status: 'firing' | 'resolved';
};

/**
 * An entry of GET .../alerting/notifications and
 * .../alerting/rules/{uuid}/notifications, newest first.
 */
export type AlertNotification = {
    uuid: string;
    projectUuid: string;
    /** Every rule with an alert in the notification. */
    ruleUuids: string[];
    /** Null once the Contact Point is deleted (or for test sends). */
    contactPointUuid: string | null;
    integrationType: string | null;
    groupKey: string | null;
    status: AlertNotificationStatus;
    /** `firing` if any alert fires, as in an Alertmanager payload. */
    alertStatus: 'firing' | 'resolved';
    attempts: number;
    alerts: AlertNotificationAlert[];
    error: string | null;
    createdAt: string;
    /** When it was delivered; null unless `status` is `sent`. */
    sentAt: string | null;
};

export type AlertNotificationListFilters = {
    ruleUuid?: string;
    contactPointUuid?: string;
};
