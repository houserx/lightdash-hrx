import {
    AuthorizationError,
    LightdashError,
    type SessionUser,
} from '@lightdash/common';
import express, {
    type ErrorRequestHandler,
    type NextFunction,
    type Request,
    type Response,
    type Router,
} from 'express';
import Logger from '../logging/logger';
import {
    parseAlertNotificationListQuery,
    type AlertNotificationService,
} from './AlertNotificationService';
import {
    parseAlertRuleListFilters,
    type AlertRuleService,
} from './AlertRuleService';
import { type ContactPointService } from './ContactPointService';
import { type NotificationRouteService } from './NotificationRouteService';

export const ALERTING_PROJECT_API_PATH =
    '/api/v2/projects/:projectUuid/alerting';

type AlertingRouterServices = {
    alertRules: AlertRuleService;
    alertNotifications: AlertNotificationService;
    contactPoints: ContactPointService;
    notificationRoutes: NotificationRouteService;
};

type Handler = (user: SessionUser, req: Request) => Promise<unknown>;

/** Runs `handler` for a signed-in user and answers `{status: 'ok', results}`. */
const route =
    (handler: Handler) =>
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const user = req.user as SessionUser | undefined;
            if (!user?.userUuid || !user.ability) {
                throw new AuthorizationError();
            }
            const results = await handler(user, req);
            res.status(200).json({ status: 'ok', results });
        } catch (error) {
            next(error);
        }
    };

/**
 * Answers errors in Lightdash's API shape. The router does this itself so it
 * works without the app's error handler (as in the acceptance harness).
 */
const handleErrors: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
) => {
    if (error instanceof LightdashError) {
        res.status(error.statusCode).json({
            status: 'error',
            error: {
                name: error.name,
                statusCode: error.statusCode,
                message: error.message,
                data: error.data,
            },
        });
        return;
    }
    // express.json() reports a malformed body as a 400 with `type`.
    if (
        error instanceof SyntaxError &&
        'type' in error &&
        error.type === 'entity.parse.failed'
    ) {
        res.status(400).json({
            status: 'error',
            error: {
                name: 'ParameterError',
                statusCode: 400,
                message: 'The request body is not valid JSON',
                data: {},
            },
        });
        return;
    }
    Logger.error('Alerting API request failed', { error });
    res.status(500).json({
        status: 'error',
        error: {
            name: 'UnexpectedServerError',
            statusCode: 500,
            message: 'Something went wrong.',
            data: {},
        },
    });
};

export const createAlertingApiRouter = (
    services: AlertingRouterServices,
): Router => {
    const router = express.Router();
    const base = ALERTING_PROJECT_API_PATH;
    // A no-op when the app has already parsed the body.
    router.use(base, express.json({ limit: '10mb' }));

    router.get(
        `${base}/rules`,
        route((user, req) =>
            services.alertRules.list(
                user,
                req.params.projectUuid,
                parseAlertRuleListFilters(req.query),
            ),
        ),
    );
    router.post(
        `${base}/rules`,
        route((user, req) =>
            services.alertRules.create(user, req.params.projectUuid, req.body),
        ),
    );
    // Before the `:ruleUuid` routes, so "preview" is never read as a uuid.
    router.post(
        `${base}/rules/preview`,
        route((user, req) =>
            services.alertRules.preview(user, req.params.projectUuid, req.body),
        ),
    );
    router.get(
        `${base}/rules/:ruleUuid`,
        route((user, req) =>
            services.alertRules.get(
                user,
                req.params.projectUuid,
                req.params.ruleUuid,
            ),
        ),
    );
    router.get(
        `${base}/rules/:ruleUuid/versions`,
        route((user, req) =>
            services.alertRules.listVersions(
                user,
                req.params.projectUuid,
                req.params.ruleUuid,
            ),
        ),
    );
    router.get(
        `${base}/rules/:ruleUuid/history`,
        route((user, req) =>
            services.alertRules.listHistory(
                user,
                req.params.projectUuid,
                req.params.ruleUuid,
            ),
        ),
    );
    router.get(
        `${base}/rules/:ruleUuid/notifications`,
        route((user, req) =>
            services.alertNotifications.listForRule(
                user,
                req.params.projectUuid,
                req.params.ruleUuid,
                parseAlertNotificationListQuery(req.query),
            ),
        ),
    );
    router.patch(
        `${base}/rules/:ruleUuid`,
        route((user, req) =>
            services.alertRules.update(
                user,
                req.params.projectUuid,
                req.params.ruleUuid,
                req.body,
            ),
        ),
    );
    router.delete(
        `${base}/rules/:ruleUuid`,
        route(async (user, req) => {
            await services.alertRules.delete(
                user,
                req.params.projectUuid,
                req.params.ruleUuid,
            );
            return undefined;
        }),
    );

    router.get(
        `${base}/contact-points`,
        route((user, req) =>
            services.contactPoints.list(user, req.params.projectUuid),
        ),
    );
    router.post(
        `${base}/contact-points`,
        route((user, req) =>
            services.contactPoints.create(
                user,
                req.params.projectUuid,
                req.body,
            ),
        ),
    );
    router.get(
        `${base}/contact-points/:contactPointUuid`,
        route((user, req) =>
            services.contactPoints.get(
                user,
                req.params.projectUuid,
                req.params.contactPointUuid,
            ),
        ),
    );
    router.patch(
        `${base}/contact-points/:contactPointUuid`,
        route((user, req) =>
            services.contactPoints.update(
                user,
                req.params.projectUuid,
                req.params.contactPointUuid,
                req.body,
            ),
        ),
    );
    router.delete(
        `${base}/contact-points/:contactPointUuid`,
        route(async (user, req) => {
            await services.contactPoints.delete(
                user,
                req.params.projectUuid,
                req.params.contactPointUuid,
            );
            return undefined;
        }),
    );

    router.get(
        `${base}/notification-routes`,
        route((user, req) =>
            services.notificationRoutes.get(user, req.params.projectUuid),
        ),
    );
    router.put(
        `${base}/notification-routes`,
        route((user, req) =>
            services.notificationRoutes.save(
                user,
                req.params.projectUuid,
                req.body,
            ),
        ),
    );

    router.get(
        `${base}/notifications`,
        route((user, req) =>
            services.alertNotifications.list(
                user,
                req.params.projectUuid,
                parseAlertNotificationListQuery(req.query),
            ),
        ),
    );

    router.use(base, handleErrors);
    return router;
};
