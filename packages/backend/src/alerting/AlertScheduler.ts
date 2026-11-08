import {
    ALERTING_SCHEDULER_TASKS,
    getErrorMessage,
    parsePrometheusDuration,
    type AlertRuleEvaluatePayload,
} from '@lightdash/common';
import Logger from '../logging/logger';
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

export type AlertSchedulerEnqueued = {
    ruleUuid: string;
    scheduledAt: string;
    jobKey: string;
};

type AlertSchedulerArgs = {
    alertScheduleModel: AlertScheduleModel;
    jobQueue: AlertJobQueue;
    clock: { now(): Date };
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
 */
export class AlertScheduler {
    private readonly alertScheduleModel: AlertScheduleModel;

    private readonly jobQueue: AlertJobQueue;

    private readonly clock: { now(): Date };

    constructor(args: AlertSchedulerArgs) {
        this.alertScheduleModel = args.alertScheduleModel;
        this.jobQueue = args.jobQueue;
        this.clock = args.clock;
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
        return { enqueued };
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
