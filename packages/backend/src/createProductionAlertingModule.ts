// Production wiring for the alerting module (ENG-1799 alert-worker-wiring).
//
// Adapts Lightdash's own clients to `AlertingModuleDeps`, so the app and the
// scheduler process build the module the same way. Configuration that
// CONTRACTS.md leaves open comes from env vars (see PROGRESS.md, "Contract
// assumptions"): ALERTING_HEARTBEAT_URL, ALERTING_HEARTBEAT_METHOD and
// ALERTING_SECRET_<NAME>.
import {
    MissingConfigError,
    QueryExecutionContext,
    SlackInstallationNotFoundError,
    type WarehouseClient,
} from '@lightdash/common';
import { type ChatPostMessageArguments } from '@slack/web-api';
import { type Knex } from 'knex';
import {
    createAlertingModule,
    type AlertingModule,
    type AlertingModuleDeps,
} from './alerting';
import { type AlertWarehouseClients } from './alerting/AlertEvaluator';
import { NotificationSendError } from './alerting/AlertNotifier';
import {
    type AlertHeartbeatConfig,
    type AlertJobQueue,
} from './alerting/AlertScheduler';
import type EmailClient from './clients/EmailClient/EmailClient';
import { type SlackClient } from './clients/Slack/SlackClient';
import { type ProjectModel } from './models/ProjectModel/ProjectModel';
import { type SchedulerClient } from './scheduler/SchedulerClient';
import {
    ConnectionSurface,
    type ConnectionContext,
} from './services/WarehouseClientFactory/ConnectionContext';
import { type WarehouseClientFactory } from './services/WarehouseClientFactory/WarehouseClientFactory';

/** Notification sends: up to 3 attempts, backing off from 1s. */
export const ALERTING_NOTIFICATION_RETRY = {
    maxAttempts: 3,
    initialDelayMs: 1_000,
} as const;

/** graphile attempts for an alerting job before it is given up. */
export const ALERTING_JOB_MAX_ATTEMPTS = 3;

type Env = Record<string, string | undefined>;

/**
 * `ALERTING_HEARTBEAT_URL` and `ALERTING_HEARTBEAT_METHOD` (`GET` or `POST`,
 * default `POST`). No URL means no heartbeat call.
 */
export const getAlertingHeartbeatConfig = (
    env: Env,
): AlertHeartbeatConfig | null => {
    const url = env.ALERTING_HEARTBEAT_URL?.trim();
    if (!url) return null;
    try {
        // eslint-disable-next-line no-new
        new URL(url);
    } catch {
        throw new Error('ALERTING_HEARTBEAT_URL must be an absolute URL');
    }
    const method = (
        env.ALERTING_HEARTBEAT_METHOD?.trim() || 'POST'
    ).toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
        throw new Error('ALERTING_HEARTBEAT_METHOD must be GET or POST');
    }
    return { url, method };
};

/** `incident-io-grafana` → `ALERTING_SECRET_INCIDENT_IO_GRAFANA`. */
export const getAlertingSecretEnvName = (name: string): string =>
    `ALERTING_SECRET_${name
        .trim()
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase()}`;

export const createEnvAlertingSecrets = (
    env: Env,
): AlertingModuleDeps['secrets'] => ({
    resolve: async (name) => env[getAlertingSecretEnvName(name)] || undefined,
});

/** graphile `addJob`; a job key keeps one queued job per key. */
export const createGraphileAlertJobQueue = (
    schedulerClient: Pick<SchedulerClient, 'graphileUtils'>,
): AlertJobQueue => ({
    addJob: async (taskName, payload, { jobKey, runAt }) => {
        const graphileUtils = await schedulerClient.graphileUtils;
        await graphileUtils.addJob(taskName, payload, {
            jobKey,
            ...(runAt ? { runAt } : {}),
            maxAttempts: ALERTING_JOB_MAX_ATTEMPTS,
        });
    },
});

/**
 * Opens the project's warehouse through `WarehouseClientFactory`, from the
 * project's saved (shared) credentials, as a system actor with no person and
 * query context `alert`. The factory handles SSH tunnels, client reuse and
 * federated identities. A project that needs personal credentials fails,
 * and the rule follows its errorState. The alerting query context is not
 * used here: the federation client mints the evaluator identity from it
 * (CONTRACTS §4.3).
 */
export const createProjectAlertWarehouseClients = ({
    projectModel,
    getWarehouseClientFactory,
}: {
    projectModel: Pick<
        ProjectModel,
        'getSummary' | 'getWarehouseCredentialsForProject'
    >;
    getWarehouseClientFactory: () => Pick<
        WarehouseClientFactory,
        'withWarehouseClient'
    >;
}): AlertWarehouseClients => ({
    getWarehouseClient: async ({ projectUuid }) => {
        const { organizationUuid } = await projectModel.getSummary(projectUuid);
        const credentials =
            await projectModel.getWarehouseCredentialsForProject(projectUuid);
        const context: ConnectionContext = {
            organizationUuid,
            actor: {
                surface: ConnectionSurface.SCHEDULE,
                person: null,
                aiClient: null,
            },
            queryContext: QueryExecutionContext.ALERT,
            purpose: 'query',
            aiAccess: 'enforce',
        };
        return {
            runQuery: (...args: Parameters<WarehouseClient['runQuery']>) =>
                getWarehouseClientFactory().withWarehouseClient(
                    {
                        kind: 'resolved',
                        projectUuid,
                        credentials,
                        aiPlan: null,
                        warehouseConnectionUuid: null,
                        connectionRoute: null,
                    },
                    context,
                    ({ warehouseClient }) => warehouseClient.runQuery(...args),
                ),
        };
    },
});

export const createAlertEmailClient = (
    emailClient: Pick<EmailClient, 'canSendEmail' | 'sendPrerenderedEmail'>,
): AlertingModuleDeps['email'] => ({
    sendEmail: async (message) => {
        if (!emailClient.canSendEmail()) {
            throw new NotificationSendError(
                'Email is not configured (SMTP is not set up)',
                false,
            );
        }
        await emailClient.sendPrerenderedEmail(message);
    },
});

export const createAlertSlackApp = (
    slackClient: Pick<SlackClient, 'postMessage'>,
): AlertingModuleDeps['slackApp'] => ({
    postMessage: async ({ organizationUuid, channel, text, blocks }) => {
        try {
            await slackClient.postMessage({
                organizationUuid,
                channel,
                text,
                ...(blocks
                    ? {
                          blocks: blocks as ChatPostMessageArguments['blocks'],
                      }
                    : {}),
            });
        } catch (error) {
            if (
                error instanceof SlackInstallationNotFoundError ||
                error instanceof MissingConfigError
            ) {
                throw new NotificationSendError(
                    'Slack app is not installed for this organization',
                    false,
                );
            }
            throw error;
        }
    },
});

export type ProductionAlertingModuleArgs = {
    database: Knex;
    siteUrl: string;
    projectModel: ProjectModel;
    getWarehouseClientFactory: () => WarehouseClientFactory;
    emailClient: EmailClient;
    slackClient: SlackClient;
    schedulerClient: SchedulerClient;
    env?: Env;
};

/** The alerting module as the app and the scheduler worker run it. */
export const createProductionAlertingModule = ({
    database,
    siteUrl,
    projectModel,
    getWarehouseClientFactory,
    emailClient,
    slackClient,
    schedulerClient,
    env = process.env,
}: ProductionAlertingModuleArgs): AlertingModule =>
    createAlertingModule({
        database,
        clock: { now: () => new Date() },
        warehouseClients: createProjectAlertWarehouseClients({
            projectModel,
            getWarehouseClientFactory,
        }),
        secrets: createEnvAlertingSecrets(env),
        email: createAlertEmailClient(emailClient),
        slackApp: createAlertSlackApp(slackClient),
        jobQueue: createGraphileAlertJobQueue(schedulerClient),
        heartbeat: getAlertingHeartbeatConfig(env),
        retry: ALERTING_NOTIFICATION_RETRY,
        siteUrl,
    });
