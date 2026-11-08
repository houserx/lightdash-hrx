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

/** Interval slots of Alert Rules (`alert_rules.last_scheduled_at`). */
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

    async transaction<T>(fn: (trx: Knex.Transaction) => Promise<T>) {
        return this.database.transaction(fn);
    }
}
