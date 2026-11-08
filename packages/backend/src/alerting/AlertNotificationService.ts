import {
    compareShadowRun,
    NotFoundError,
    ParameterError,
    type AlertNotification,
    type AlertNotificationListFilters,
    type SessionUser,
    type ShadowRunExpectedDifference,
    type ShadowRunReport,
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

export type ShadowReportRequest = {
    since: string;
    grafanaHistory: unknown;
    expectedDifferences: ShadowRunExpectedDifference[];
    toleranceMs?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const SHADOW_RUN_DIFFERENCE_KINDS = [
    'missing_in_lightdash',
    'extra_in_lightdash',
] as const;

/**
 * Reads a Shadow Run report request: `since` (ISO time), `grafanaHistory`
 * (a Grafana state history frame, checked by the comparison),
 * `expectedDifferences` (optional, default none) and `toleranceMs`
 * (optional). Throws a ParameterError on anything else.
 */
export const parseShadowReportRequest = (
    body: unknown,
): ShadowReportRequest => {
    if (!isRecord(body)) {
        throw new ParameterError('The request body must be an object');
    }
    const {
        since,
        grafanaHistory,
        expectedDifferences = [],
        toleranceMs,
    } = body;
    if (typeof since !== 'string' || !Number.isFinite(Date.parse(since))) {
        throw new ParameterError('since must be an ISO timestamp');
    }
    if (grafanaHistory === undefined) {
        throw new ParameterError('grafanaHistory is required');
    }
    if (
        !Array.isArray(expectedDifferences) ||
        !expectedDifferences.every(
            (difference) =>
                isRecord(difference) &&
                typeof difference.ruleName === 'string' &&
                typeof difference.reason === 'string' &&
                SHADOW_RUN_DIFFERENCE_KINDS.some(
                    (kind) => kind === difference.kind,
                ),
        )
    ) {
        throw new ParameterError(
            'expectedDifferences must be a list of {ruleName, kind, reason}, with kind missing_in_lightdash or extra_in_lightdash',
        );
    }
    if (toleranceMs !== undefined && typeof toleranceMs !== 'number') {
        throw new ParameterError('toleranceMs must be a number');
    }
    return {
        since,
        grafanaHistory,
        expectedDifferences:
            expectedDifferences as ShadowRunExpectedDifference[],
        ...(toleranceMs !== undefined && { toleranceMs }),
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

    /**
     * The Shadow Run report: the project's shadow firings since `since`
     * compared with Grafana's state history and the expected differences.
     * The body is checked after access, so outsiders always get a 403.
     */
    async shadowReport(
        user: SessionUser,
        projectUuid: string,
        body: unknown,
    ): Promise<ShadowRunReport> {
        await this.assertCanView(user, projectUuid);
        const request = parseShadowReportRequest(body);
        const firings =
            await this.deps.alertNotificationModel.listShadowFirings(
                projectUuid,
                new Date(request.since),
            );
        return compareShadowRun({
            ...request,
            shadow: firings.map((firing) => ({
                ruleName: firing.ruleName,
                labels: firing.labels,
                status: 'firing',
                at: firing.startedAt.toISOString(),
            })),
        });
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
