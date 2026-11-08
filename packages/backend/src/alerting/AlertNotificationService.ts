import {
    NotFoundError,
    ParameterError,
    type AlertNotification,
    type AlertNotificationListFilters,
    type SessionUser,
} from '@lightdash/common';
import {
    assertAlertingAbility,
    singleQueryValue,
    UUID_PATTERN,
} from './alertingAccess';
import { type AlertNotificationModel } from './AlertNotificationModel';

export const ALERT_NOTIFICATIONS_DEFAULT_LIMIT = 100;
export const ALERT_NOTIFICATIONS_MAX_LIMIT = 1000;

export type AlertNotificationListQuery = AlertNotificationListFilters & {
    limit: number;
};

const uuidQueryValue = (key: string, value: unknown): string | undefined => {
    const uuid = singleQueryValue(key, value);
    if (uuid !== undefined && !UUID_PATTERN.test(uuid)) {
        throw new ParameterError(`${key} must be a uuid`);
    }
    return uuid;
};

/**
 * Reads the notification list's query string: `rule=<uuid>`,
 * `contactPoint=<uuid>` and `limit=<1..1000>` (default 100), each at most
 * once. Other parameters are ignored.
 */
export const parseAlertNotificationListQuery = (
    query: Record<string, unknown>,
): AlertNotificationListQuery => {
    const ruleUuid = uuidQueryValue('rule', query.rule);
    const contactPointUuid = uuidQueryValue('contactPoint', query.contactPoint);
    const limitValue = singleQueryValue('limit', query.limit);
    const limit =
        limitValue === undefined
            ? ALERT_NOTIFICATIONS_DEFAULT_LIMIT
            : Number(limitValue);
    if (
        !/^\d+$/.test(limitValue ?? '1') ||
        limit < 1 ||
        limit > ALERT_NOTIFICATIONS_MAX_LIMIT
    ) {
        throw new ParameterError(
            `limit must be a whole number from 1 to ${ALERT_NOTIFICATIONS_MAX_LIMIT}`,
        );
    }
    return {
        ...(ruleUuid !== undefined && { ruleUuid }),
        ...(contactPointUuid !== undefined && { contactPointUuid }),
        limit,
    };
};

/**
 * The notification log: every send to a Contact Point integration (sent,
 * failed or shadow), newest first. Whoever may view the project's Alert
 * Rules may read it.
 */
export class AlertNotificationService {
    constructor(
        private readonly deps: {
            alertNotificationModel: AlertNotificationModel;
        },
    ) {}

    async list(
        user: SessionUser,
        projectUuid: string,
        { limit, ...filters }: AlertNotificationListQuery,
    ): Promise<AlertNotification[]> {
        await this.assertCanView(user, projectUuid);
        return this.deps.alertNotificationModel.listNotifications(
            projectUuid,
            filters,
            limit,
        );
    }

    /** One rule's notifications; 404 when the rule isn't in the project. */
    async listForRule(
        user: SessionUser,
        projectUuid: string,
        ruleUuid: string,
        { limit, contactPointUuid }: AlertNotificationListQuery,
    ): Promise<AlertNotification[]> {
        await this.assertCanView(user, projectUuid);
        if (
            !UUID_PATTERN.test(ruleUuid) ||
            !(await this.deps.alertNotificationModel.ruleExists(
                projectUuid,
                ruleUuid,
            ))
        ) {
            throw new NotFoundError('Alert Rule not found');
        }
        return this.deps.alertNotificationModel.listNotifications(
            projectUuid,
            {
                ruleUuid,
                ...(contactPointUuid !== undefined && { contactPointUuid }),
            },
            limit,
        );
    }

    private async assertCanView(user: SessionUser, projectUuid: string) {
        await assertAlertingAbility(
            this.deps.alertNotificationModel,
            user,
            'view',
            'AlertRule',
            projectUuid,
        );
    }
}
