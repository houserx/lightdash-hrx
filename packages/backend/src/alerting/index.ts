// Alert Rules, Contact Points and Notification Routes (ENG-1799).
//
// The module is built from injected dependencies so the API, the evaluator
// and the scheduler can run in the app, the worker and the acceptance
// harness alike. See PROGRESS.md "Backend" for the full contract.
import { type Router } from 'express';
import { type Knex } from 'knex';
import { AlertEvaluator, type AlertWarehouseClients } from './AlertEvaluator';
import { AlertHealthService } from './AlertHealthService';
import { AlertHeartbeatModel } from './AlertHeartbeatModel';
import { AlertInstanceModel } from './AlertInstanceModel';
import { AlertNotificationModel } from './AlertNotificationModel';
import { AlertNotificationService } from './AlertNotificationService';
import { AlertNotifier } from './AlertNotifier';
import { AlertRuleModel } from './AlertRuleModel';
import { AlertRuleService } from './AlertRuleService';
import { AlertScheduleModel } from './AlertScheduleModel';
import {
    AlertScheduler,
    type AlertHeartbeatConfig,
    type AlertJobQueue,
} from './AlertScheduler';
import { AlertStateHistoryModel } from './AlertStateHistoryModel';
import { ContactPointModel } from './ContactPointModel';
import { ContactPointService } from './ContactPointService';
import { NotificationRouteModel } from './NotificationRouteModel';
import { NotificationRouteService } from './NotificationRouteService';
import { createAlertingApiRouter } from './router';

export type AlertingModuleDeps = {
    database: Knex;
    /** Every "now" in alerting comes from here. */
    clock: { now(): Date };
    warehouseClients: AlertWarehouseClients;
    secrets: { resolve(name: string): Promise<string | undefined> };
    email: {
        sendEmail(message: {
            to: string[];
            subject: string;
            text: string;
            html?: string;
        }): Promise<void>;
    };
    /** Throws when the Slack app isn't installed for the organization. */
    slackApp: {
        postMessage(args: {
            organizationUuid: string;
            channel: string;
            text: string;
            blocks?: unknown[];
        }): Promise<void>;
    };
    /** graphile `addJob`: one queued job per `jobKey`. */
    jobQueue: AlertJobQueue;
    /** Called (GET or POST) after every completed scheduler cycle. */
    heartbeat: AlertHeartbeatConfig | null;
    /** Exponential backoff for notification sends. */
    retry: { maxAttempts: number; initialDelayMs: number };
    siteUrl: string;
};

export type AlertingModule = {
    alertHealth: AlertHealthService;
    alertRules: AlertRuleService;
    alertNotifications: AlertNotificationService;
    contactPoints: ContactPointService;
    notificationRoutes: NotificationRouteService;
    evaluator: AlertEvaluator;
    scheduler: AlertScheduler;
    notifier: AlertNotifier;
    close(): Promise<void>;
};

export const createAlertingModule = (
    deps: AlertingModuleDeps,
): AlertingModule => {
    const alertRuleModel = new AlertRuleModel(deps.database);
    const notificationRouteModel = new NotificationRouteModel(deps.database);
    const alertScheduleModel = new AlertScheduleModel(deps.database);
    const alertNotificationModel = new AlertNotificationModel(deps.database);
    const alertHeartbeatModel = new AlertHeartbeatModel(deps.database);
    const evaluator = new AlertEvaluator({
        alertRuleModel,
        alertInstanceModel: new AlertInstanceModel(deps.database),
        alertScheduleModel,
        warehouseClients: deps.warehouseClients,
        clock: deps.clock,
    });
    const notifier = new AlertNotifier({
        alertNotificationModel,
        notificationRouteModel,
        secrets: deps.secrets,
        slackApp: deps.slackApp,
        email: deps.email,
        clock: deps.clock,
        retry: deps.retry,
        siteUrl: deps.siteUrl,
    });
    return {
        alertHealth: new AlertHealthService({
            alertHeartbeatModel,
            clock: deps.clock,
        }),
        alertRules: new AlertRuleService({
            alertRuleModel,
            alertStateHistoryModel: new AlertStateHistoryModel(deps.database),
            rulePreviewer: evaluator,
            clock: deps.clock,
        }),
        alertNotifications: new AlertNotificationService({
            alertNotificationModel,
        }),
        contactPoints: new ContactPointService({
            contactPointModel: new ContactPointModel(deps.database),
            notificationRouteModel,
            testNotifier: notifier,
            clock: deps.clock,
        }),
        notificationRoutes: new NotificationRouteService({
            notificationRouteModel,
            clock: deps.clock,
        }),
        evaluator,
        scheduler: new AlertScheduler({
            alertScheduleModel,
            jobQueue: deps.jobQueue,
            clock: deps.clock,
            notifier,
            alertHeartbeatModel,
            heartbeat: deps.heartbeat,
        }),
        notifier,
        // The database belongs to the caller; nothing of ours to release yet.
        close: async () => {},
    };
};

/** The alerting HTTP API, with full paths: mount it at the app root. */
export const createAlertingRouter = (module: AlertingModule): Router =>
    createAlertingApiRouter({
        alertHealth: module.alertHealth,
        alertRules: module.alertRules,
        alertNotifications: module.alertNotifications,
        contactPoints: module.contactPoints,
        notificationRoutes: module.notificationRoutes,
    });
