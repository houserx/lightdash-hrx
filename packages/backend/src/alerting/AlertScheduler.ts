import {
    ALERTING_SCHEDULER_TASKS,
    getErrorMessage,
    parsePrometheusDuration,
    type AlertRuleEvaluatePayload,
} from '@lightdash/common';
import Logger from '../logging/logger';
import { type AlertHeartbeatModel } from './AlertHeartbeatModel';
import {
    type AlertScheduleModel,
    type SchedulableAlertRule,
} from './AlertScheduleModel';

export type AlertJobQueue = {
    addJob(
        taskName: string,
        payload: object,
        opts: { jobKey: string; runAt?: Date },
    ): Promise<void>;
};

export type AlertHeartbeatConfig = { url: string; method: 'GET' | 'POST' };

/** A heartbeat call that hangs must not hold up the next cycle. */
const HEARTBEAT_TIMEOUT_MS = 10_000;

export type AlertSchedulerEnqueued = {
    ruleUuid: string;
    scheduledAt: string;
    jobKey: string;
};

type AlertSchedulerArgs = {
    alertScheduleModel: AlertScheduleModel;
    jobQueue: AlertJobQueue;
    clock: { now(): Date };
    notifier: { flush(): Promise<void> };
    alertHeartbeatModel: AlertHeartbeatModel;
    heartbeat: AlertHeartbeatConfig | null;
};

/** The interval slot `now` falls in: `floor(now / interval) * interval`. */
export const getAlertRuleSlot = (now: Date, intervalMs: number): Date =>
    new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);

/** One job key per rule and slot, so the queue keeps one job for both. */
export const getAlertRuleEvaluateJobKey = (
    ruleUuid: string,
    scheduledAt: string,
): string =>
    `${ALERTING_SCHEDULER_TASKS.ALERT_RULE_EVALUATE}:${ruleUuid}:${scheduledAt}`;

/**
 * Finds the Alert Rules that are due and enqueues one `alertRuleEvaluate`
 * job per rule per interval slot. A rule is due once per slot: the slot is
 * claimed in the database before its job is enqueued (in one transaction,
 * so a failed enqueue gives the slot back), which keeps schedulers running
 * side by side from enqueueing it twice. Paused rules are never due. Only
 * the current slot is enqueued; slots missed while nothing ticked are not
 * caught up.
 *
 * A cycle then flushes due notifications, records a row in
 * `alert_evaluator_heartbeats` and calls the configured heartbeat URL. A
 * failed flush or heartbeat call is logged and recorded on the row, never
 * thrown, so the cycle still completes.
 */
export class AlertScheduler {
    private readonly alertScheduleModel: AlertScheduleModel;

    private readonly jobQueue: AlertJobQueue;

    private readonly clock: { now(): Date };

    private readonly notifier: { flush(): Promise<void> };

    private readonly alertHeartbeatModel: AlertHeartbeatModel;

    private readonly heartbeat: AlertHeartbeatConfig | null;

    constructor(args: AlertSchedulerArgs) {
        this.alertScheduleModel = args.alertScheduleModel;
        this.jobQueue = args.jobQueue;
        this.clock = args.clock;
        this.notifier = args.notifier;
        this.alertHeartbeatModel = args.alertHeartbeatModel;
        this.heartbeat = args.heartbeat;
    }

    async tick(): Promise<{ enqueued: AlertSchedulerEnqueued[] }> {
        const now = this.clock.now();
        const rules = await this.alertScheduleModel.listSchedulable();
        const enqueued: AlertSchedulerEnqueued[] = [];
        for (const rule of rules) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const entry = await this.enqueueIfDue(rule, now);
                if (entry) enqueued.push(entry);
            } catch (error) {
                // One rule's bad interval or a failed enqueue must not stop
                // the others; the slot stays unclaimed for the next tick.
                Logger.error(
                    `Alerting scheduler could not enqueue rule ${
                        rule.ruleUuid
                    }: ${getErrorMessage(error)}`,
                );
            }
        }
        const errors: string[] = [];
        try {
            await this.notifier.flush();
        } catch (error) {
            const message = `notification flush failed: ${getErrorMessage(
                error,
            )}`;
            Logger.error(`Alerting scheduler: ${message}`);
            errors.push(message);
        }
        const heartbeat = await this.callHeartbeat();
        if (heartbeat.error) errors.push(heartbeat.error);
        await this.alertHeartbeatModel.insert({
            cycleStartedAt: now,
            completedAt: this.clock.now(),
            rulesEvaluated: enqueued.length,
            heartbeatStatus: heartbeat.status,
            error: errors.length > 0 ? errors.join('; ') : null,
        });
        return { enqueued };
    }

    /** Calls the heartbeat URL, if one is configured; never throws. */
    private async callHeartbeat(): Promise<{
        status: string | null;
        error?: string;
    }> {
        if (!this.heartbeat) return { status: null };
        const { url, method } = this.heartbeat;
        try {
            const response = await fetch(url, {
                method,
                signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
            });
            // Drain the body so the connection is released.
            await response.arrayBuffer().catch(() => undefined);
            if (response.ok) return { status: String(response.status) };
            const error = `heartbeat ${method} returned HTTP ${response.status}`;
            Logger.warn(`Alerting scheduler: ${error}`);
            return { status: String(response.status), error };
        } catch (error) {
            const message = `heartbeat ${method} failed: ${getErrorMessage(
                error,
            )}`;
            Logger.warn(`Alerting scheduler: ${message}`);
            return { status: 'failed', error: message };
        }
    }

    private async enqueueIfDue(
        rule: SchedulableAlertRule,
        now: Date,
    ): Promise<AlertSchedulerEnqueued | undefined> {
        const intervalMs = parsePrometheusDuration(rule.interval);
        if (intervalMs <= 0) {
            throw new Error(`Invalid interval ${rule.interval}`);
        }
        const slot = getAlertRuleSlot(now, intervalMs);
        if (rule.lastScheduledAt && rule.lastScheduledAt >= slot) {
            return undefined;
        }
        const scheduledAt = slot.toISOString();
        const jobKey = getAlertRuleEvaluateJobKey(rule.ruleUuid, scheduledAt);
        return this.alertScheduleModel.transaction(async (trx) => {
            const claimed = await this.alertScheduleModel.claimSlot(
                trx,
                rule.ruleUuid,
                slot,
            );
            if (!claimed) return undefined;
            const payload: AlertRuleEvaluatePayload = {
                ruleUuid: rule.ruleUuid,
                scheduledAt,
                organizationUuid: rule.organizationUuid,
                projectUuid: rule.projectUuid,
            };
            await this.jobQueue.addJob(
                ALERTING_SCHEDULER_TASKS.ALERT_RULE_EVALUATE,
                payload,
                { jobKey },
            );
            return { ruleUuid: rule.ruleUuid, scheduledAt, jobKey };
        });
    }
}
