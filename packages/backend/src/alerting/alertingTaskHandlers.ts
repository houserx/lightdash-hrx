import {
    ALERTING_SCHEDULER_TASKS,
    getErrorMessage,
    type AlertingTickPayload,
    type AlertRuleEvaluatePayload,
} from '@lightdash/common';
import Logger from '../logging/logger';
import { type AlertEvaluator } from './AlertEvaluator';
import { type AlertJobQueue, type AlertScheduler } from './AlertScheduler';

/** One queued `alertingTick` at a time, across every worker. */
export const ALERTING_TICK_JOB_KEY = 'alerting-tick';

/** How long after a tick the next one runs. */
export const ALERTING_TICK_INTERVAL_MS = 15_000;

export type AlertingTaskHandlers = {
    [ALERTING_SCHEDULER_TASKS.ALERTING_TICK]: (
        payload: AlertingTickPayload,
    ) => Promise<void>;
    [ALERTING_SCHEDULER_TASKS.ALERT_RULE_EVALUATE]: (
        payload: AlertRuleEvaluatePayload,
    ) => Promise<void>;
};

type AlertingTaskHandlerArgs = {
    evaluator: Pick<AlertEvaluator, 'evaluateRule'>;
    scheduler: Pick<AlertScheduler, 'tick'>;
    jobQueue: AlertJobQueue;
    clock: { now(): Date };
};

/** Queues the next `alertingTick`, replacing any tick already queued. */
export const enqueueAlertingTick = (
    jobQueue: AlertJobQueue,
    runAt: Date,
): Promise<void> =>
    jobQueue.addJob(
        ALERTING_SCHEDULER_TASKS.ALERTING_TICK,
        {},
        { jobKey: ALERTING_TICK_JOB_KEY, runAt },
    );

/**
 * The graphile-worker handlers for the alerting tasks.
 *
 * `alertingTick` runs one scheduler cycle and always queues the next tick
 * 15s later, even when the cycle fails, so the chain never breaks: the next
 * tick is the retry. A failed cycle is logged and leaves no heartbeat, which
 * `/api/v1/alerting/health` reports as stale. Only a failure to queue the
 * next tick is thrown, so graphile retries the job.
 */
export const createAlertingTaskHandlers = ({
    evaluator,
    scheduler,
    jobQueue,
    clock,
}: AlertingTaskHandlerArgs): AlertingTaskHandlers => ({
    [ALERTING_SCHEDULER_TASKS.ALERTING_TICK]: async () => {
        try {
            await scheduler.tick();
        } catch (error) {
            Logger.error(
                `Alerting tick failed, the next tick retries: ${getErrorMessage(
                    error,
                )}`,
            );
        }
        await enqueueAlertingTick(
            jobQueue,
            new Date(clock.now().getTime() + ALERTING_TICK_INTERVAL_MS),
        );
    },
    [ALERTING_SCHEDULER_TASKS.ALERT_RULE_EVALUATE]: async (payload) => {
        const scheduledAt = new Date(payload.scheduledAt);
        if (Number.isNaN(scheduledAt.getTime())) {
            throw new Error(
                `alertRuleEvaluate: invalid scheduledAt ${payload.scheduledAt}`,
            );
        }
        const outcome = await evaluator.evaluateRule(payload.ruleUuid, {
            scheduledAt,
        });
        if (outcome.status === 'skipped') {
            Logger.debug(
                `Alert rule ${payload.ruleUuid} skipped for ${payload.scheduledAt}: ${outcome.reason}`,
            );
        }
    },
});
