import { type Knex } from 'knex';
import { AlertRulesTableName } from './AlertRuleModel';

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
 * (`alert_rules.last_scheduled_at`) and the last slot claimed for
 * evaluation (`alert_rules.last_evaluation_slot`).
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
     * Claims `slot` for evaluation (`alert_rules.last_evaluation_slot`):
     * `claimed` is true when this caller moved the rule's last evaluation
     * slot forward to it, false when that slot (or a later one) was already
     * claimed by some worker or the rule is gone. The rule's row is locked
     * for the check, so concurrent claims of one slot serialize and only one
     * wins. `previous` is the slot the claim replaced, for `releaseEvaluationSlot`.
     */
    async claimEvaluationSlot(
        ruleUuid: string,
        slot: Date,
    ): Promise<{ claimed: boolean; previous: Date | null }> {
        return this.database.transaction(async (trx) => {
            const row = await trx(AlertRulesTableName)
                .where('alert_rule_uuid', ruleUuid)
                .forUpdate()
                .first<{ last_evaluation_slot: Date | null } | undefined>(
                    'last_evaluation_slot',
                );
            if (!row) return { claimed: false, previous: null };
            const previous = row.last_evaluation_slot;
            if (previous && previous.getTime() >= slot.getTime()) {
                return { claimed: false, previous };
            }
            await trx(AlertRulesTableName)
                .where('alert_rule_uuid', ruleUuid)
                .update({ last_evaluation_slot: slot });
            return { claimed: true, previous };
        });
    }

    /**
     * Gives back a claim whose evaluation failed, so a retry of the slot
     * runs again. A no-op if another worker has since claimed a later slot.
     */
    async releaseEvaluationSlot(
        ruleUuid: string,
        slot: Date,
        previous: Date | null,
    ): Promise<void> {
        await this.database(AlertRulesTableName)
            .where('alert_rule_uuid', ruleUuid)
            .andWhere('last_evaluation_slot', slot)
            .update({ last_evaluation_slot: previous });
    }

    async transaction<T>(fn: (trx: Knex.Transaction) => Promise<T>) {
        return this.database.transaction(fn);
    }
}
