import {
    ALERTING_AS_CODE_VERSION,
    ForbiddenError,
    getNotificationRouteContactPoints,
    NotFoundError,
    ParameterError,
    parsePrometheusDuration,
    validateAlertingAsCode,
    type NotificationRoute,
    type NotificationRoutesAsCode,
    type NotificationRouteTree,
    type SavedNotificationRouteTree,
    type SessionUser,
} from '@lightdash/common';
import { assertAlertingAbility, type AlertingAction } from './alertingAccess';
import { type NotificationRouteModel } from './NotificationRouteModel';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (errors: string[]): ParameterError =>
    new ParameterError(
        `Invalid Notification Route tree: ${errors.join('; ')}`,
        { errors },
    );

/**
 * Alertmanager refuses a zero group_interval or repeat_interval: the group
 * would be sent again on every flush.
 */
const zeroTimerErrors = (route: NotificationRoute, path: string): string[] => [
    ...(['groupInterval', 'repeatInterval'] as const)
        .filter(
            (timer) =>
                route[timer] !== undefined &&
                parsePrometheusDuration(route[timer]) === 0,
        )
        .map((timer) => `${path}${timer}: must be greater than 0`),
    ...(route.routes ?? []).flatMap((child, i) =>
        zeroTimerErrors(child, `${path}routes[${i}].`),
    ),
];

/**
 * Checks the shape of a whole tree against the notification_routes as-code
 * JSON schema (so the API and uploads accept the same trees), plus the
 * matcher regexes and timers. Contact Points are checked on save.
 */
const parseTree = (body: unknown): NotificationRouteTree => {
    if (!isPlainObject(body)) {
        throw new ParameterError(
            'The Notification Route tree must be a JSON object',
        );
    }
    // `managed` comes back from GET; it's ignored so a read tree can be
    // saved as is. `version` and `type` belong to as-code documents only.
    const { managed: _managed, ...tree } = body;
    const documentKeys = ['version', 'type'].filter((key) => key in tree);
    if (documentKeys.length > 0) {
        throw invalid(documentKeys.map((key) => `${key}: is not allowed`));
    }
    const document = {
        version: ALERTING_AS_CODE_VERSION,
        type: 'notification_routes',
        ...tree,
    };
    const { valid, errors } = validateAlertingAsCode(document);
    if (!valid) throw invalid(errors);
    const {
        version: _version,
        type: _type,
        ...parsed
    } = document as NotificationRoutesAsCode;
    const timerErrors = zeroTimerErrors(parsed, '');
    if (timerErrors.length > 0) throw invalid(timerErrors);
    return parsed;
};

export class NotificationRouteService {
    constructor(
        private readonly deps: {
            notificationRouteModel: NotificationRouteModel;
            clock: { now(): Date };
        },
    ) {}

    private async assertAbility(
        user: SessionUser,
        action: AlertingAction,
        projectUuid: string,
    ) {
        await assertAlertingAbility(
            this.deps.notificationRouteModel,
            user,
            action,
            'NotificationRoute',
            projectUuid,
        );
    }

    /** The project's tree, or null before the first save. */
    async get(
        user: SessionUser,
        projectUuid: string,
    ): Promise<SavedNotificationRouteTree | null> {
        await this.assertAbility(user, 'view', projectUuid);
        return (
            (await this.deps.notificationRouteModel.find(projectUuid)) ?? null
        );
    }

    /** Replaces the project's whole tree. */
    async save(
        user: SessionUser,
        projectUuid: string,
        body: unknown,
    ): Promise<SavedNotificationRouteTree> {
        await this.assertAbility(user, 'manage', projectUuid);
        const tree = parseTree(body);
        await this.deps.notificationRouteModel.save({
            projectUuid,
            tree,
            userUuid: user.userUuid,
            now: this.deps.clock.now(),
            check: (current, contactPointSlugs) => {
                if (current?.managed) {
                    throw new ForbiddenError(
                        'The Notification Route tree is managed in git; change it there and upload it again',
                    );
                }
                const unknown = getNotificationRouteContactPoints(tree).filter(
                    (slug) => !contactPointSlugs.has(slug),
                );
                if (unknown.length > 0) {
                    throw invalid(
                        unknown.map(
                            (slug) =>
                                `contactPoint: no Contact Point "${slug}" in this project`,
                        ),
                    );
                }
            },
        });
        const saved = await this.deps.notificationRouteModel.find(projectUuid);
        if (!saved)
            throw new NotFoundError('Notification Route tree not found');
        return saved;
    }
}
