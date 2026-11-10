import { type Knex } from 'knex';
import { AlertRulesTableName } from './AlertRuleModel';
import { AlertStateHistoryModel } from './AlertStateHistoryModel';

/** What the scheduler needs to know about an unpaused rule. */
export type SchedulableAlertRule = {
    ruleUuid: string;
    projectUuid: string;
    organizationUuid: string;
    interval: string;
    /** The last interval slot enqueued for this rule, if any. */
    lastScheduledAt: Date | null;
};

type DbSchedulableAlertRule = {
    alert_rule_uuid: string;
    project_uuid: string;
    organization_uuid: string;
    interval: string;
    last_scheduled_at: Date | null;
};

/**
 * Interval slots of Alert Rules: the last slot enqueued
 * (`alert_rules.last_scheduled_at`), the last slot claimed for evaluation
 * (`alert_rules.last_evaluation_slot`) and whether that evaluation is still
 * running (`alert_rules.evaluation_started_at`).
 */
export class AlertScheduleModel {
    constructor(private readonly database: Knex) {}

    /** Every unpaused rule, in every project. */
    async listSchedulable(): Promise<SchedulableAlertRule[]> {
        const rows = await this.database(AlertRulesTableName)
            .innerJoin(
                'projects',
                'projects.project_uuid',
                `${AlertRulesTableName}.project_uuid`,
            )
            .innerJoin(
                'organizations',
                'organizations.organization_id',
                'projects.organization_id',
            )
            .where(`${AlertRulesTableName}.paused`, false)
            .orderBy(`${AlertRulesTableName}.alert_rule_uuid`)
            .select<DbSchedulableAlertRule[]>(
                `${AlertRulesTableName}.alert_rule_uuid`,
                `${AlertRulesTableName}.project_uuid`,
                'organizations.organization_uuid',
                `${AlertRulesTableName}.interval`,
                `${AlertRulesTableName}.last_scheduled_at`,
            );
        return rows.map((row) => ({
            ruleUuid: row.alert_rule_uuid,
            projectUuid: row.project_uuid,
            organizationUuid: row.organization_uuid,
            interval: row.interval,
            lastScheduledAt: row.last_scheduled_at,
        }));
    }

    /**
     * Claims `slot` for the rule: true when this caller moved the rule's
     * last scheduled slot forward to it, false when the slot (or a later
     * one) was already claimed or the rule is gone or paused. Concurrent
     * claims of one slot serialize on the row, so only one of them wins.
     */
    async claimSlot(trx: Knex, ruleUuid: string, slot: Date): Promise<boolean> {
        const updated = await trx(AlertRulesTableName)
            .where('alert_rule_uuid', ruleUuid)
            .andWhere('paused', false)
            .andWhere((query) =>
                query
                    .whereNull('last_scheduled_at')
                    .orWhere('last_scheduled_at', '<', slot),
            )
            .update({ last_scheduled_at: slot });
        return updated > 0;
    }

    /**
     * Claims `slot` for evaluation (`alert_rules.last_evaluation_slot`) and
     * marks the rule as being evaluated (`alert_rules.evaluation_started_at`
     * = `now`). The rule's row is locked for the check, so concurrent claims
     * serialize and only one wins. The claim is refused with reason:
     * - `duplicate` when that slot (or a later one) was already claimed by
     *   some worker, or the rule is gone;
     * - `overrun` when an evaluation of an earlier slot is still running
     *   (it started after `staleBefore`). The skip is written to the rule's
     *   history in the same transaction.
     * An evaluation that started at or before `staleBefore` is taken to have
     * died with its worker and no longer blocks newer slots.
     * `previous` is the slot the claim replaced, for `releaseEvaluationSlot`.
     */
    async claimEvaluationSlot(
        ruleUuid: string,
        slot: Date,
        { now, staleBefore }: { now: Date; staleBefore: Date },
    ): Promise<
        | { claimed: true; previous: Date | null }
        | { claimed: false; reason: 'duplicate' | 'overrun' }
    > {
        return this.database.transaction(async (trx) => {
            const row = await trx(AlertRulesTableName)
                .where('alert_rule_uuid', ruleUuid)
                .forUpdate()
                .first<
                    | {
                          project_uuid: string;
                          last_evaluation_slot: Date | null;
                          evaluation_started_at: Date | null;
                      }
                    | undefined
                >(
                    'project_uuid',
                    'last_evaluation_slot',
                    'evaluation_started_at',
                );
            if (!row) return { claimed: false, reason: 'duplicate' };
            const previous = row.last_evaluation_slot;
            if (previous && previous.getTime() >= slot.getTime()) {
                return { claimed: false, reason: 'duplicate' };
            }
            if (
                row.evaluation_started_at &&
                row.evaluation_started_at.getTime() > staleBefore.getTime()
            ) {
                await AlertStateHistoryModel.insertEvaluationSkipped(trx, {
                    projectUuid: row.project_uuid,
                    ruleUuid,
                    at: slot,
                    reason: 'overrun',
                });
                return { claimed: false, reason: 'overrun' };
            }
            await trx(AlertRulesTableName)
                .where('alert_rule_uuid', ruleUuid)
                .update({
                    last_evaluation_slot: slot,
                    evaluation_started_at: now,
                });
            return { claimed: true, previous };
        });
    }

    /**
     * Marks the evaluation of a claimed slot as ended, so newer slots run.
     * A no-op if another worker has since claimed a later slot.
     */
    async finishEvaluationSlot(ruleUuid: string, slot: Date): Promise<void> {
        await this.database(AlertRulesTableName)
            .where('alert_rule_uuid', ruleUuid)
            .andWhere('last_evaluation_slot', slot)
            .update({ evaluation_started_at: null });
    }

    /**
     * Gives back a claim whose evaluation failed, so a retry of the slot
     * runs again, and marks the evaluation as ended. A no-op if another
     * worker has since claimed a later slot.
     */
    async releaseEvaluationSlot(
        ruleUuid: string,
        slot: Date,
        previous: Date | null,
    ): Promise<void> {
        await this.database(AlertRulesTableName)
            .where('alert_rule_uuid', ruleUuid)
            .andWhere('last_evaluation_slot', slot)
            .update({
                last_evaluation_slot: previous,
                evaluation_started_at: null,
            });
    }

    async transaction<T>(fn: (trx: Knex.Transaction) => Promise<T>) {
        return this.database.transaction(fn);
    }
}
