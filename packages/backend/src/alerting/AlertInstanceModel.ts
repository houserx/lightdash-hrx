import { type AlertInstanceState } from '@lightdash/common';
import { type Knex } from 'knex';
import { AlertInstancesTableName } from './AlertRuleModel';
import { AlertStateHistoryModel } from './AlertStateHistoryModel';
import {
    type AlertInstanceRecord,
    type AlertSeriesTransition,
} from './evaluateAlertSeries';

type DbAlertInstanceState = {
    fingerprint: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    state: AlertInstanceState;
    value: number | null;
    state_since: Date;
    active_at: Date | null;
    last_condition_met_at: Date | null;
    last_evaluated_at: Date;
};

const toRecord = (row: DbAlertInstanceState): AlertInstanceRecord => ({
    fingerprint: row.fingerprint,
    labels: row.labels,
    annotations: row.annotations,
    state: row.state,
    value: row.value === null ? null : Number(row.value),
    stateSince: row.state_since,
    activeAt: row.active_at,
    lastConditionMetAt: row.last_condition_met_at,
    lastEvaluatedAt: row.last_evaluated_at,
});

/** The per-series state the evaluator keeps in `alert_instances`. */
export class AlertInstanceModel {
    constructor(private readonly database: Knex) {}

    async listForRule(ruleUuid: string): Promise<AlertInstanceRecord[]> {
        const rows = await this.database(AlertInstancesTableName)
            .where('alert_rule_uuid', ruleUuid)
            .select<DbAlertInstanceState[]>(
                'fingerprint',
                'labels',
                'annotations',
                'state',
                'value',
                'state_since',
                'active_at',
                'last_condition_met_at',
                'last_evaluated_at',
            );
        return rows.map(toRecord);
    }

    /**
     * Upserts the given series (by fingerprint), deletes the removed ones and
     * writes the evaluation's transitions to the state history, all at once.
     */
    async save(
        {
            projectUuid,
            ruleUuid,
            at,
        }: { projectUuid: string; ruleUuid: string; at: Date },
        {
            instances,
            removedFingerprints,
            transitions,
        }: {
            instances: AlertInstanceRecord[];
            removedFingerprints: string[];
            transitions: readonly AlertSeriesTransition[];
        },
    ): Promise<void> {
        await this.database.transaction(async (trx) => {
            await AlertStateHistoryModel.insertTransitions(trx, {
                projectUuid,
                ruleUuid,
                at,
                transitions,
            });
            if (removedFingerprints.length > 0) {
                await trx(AlertInstancesTableName)
                    .where('alert_rule_uuid', ruleUuid)
                    .whereIn('fingerprint', removedFingerprints)
                    .delete();
            }
            if (instances.length === 0) return;
            await trx(AlertInstancesTableName)
                .insert(
                    instances.map((instance) => ({
                        alert_rule_uuid: ruleUuid,
                        fingerprint: instance.fingerprint,
                        labels: JSON.stringify(instance.labels),
                        annotations: JSON.stringify(instance.annotations),
                        state: instance.state,
                        value: instance.value,
                        state_since: instance.stateSince,
                        active_at: instance.activeAt,
                        last_condition_met_at: instance.lastConditionMetAt,
                        last_evaluated_at: instance.lastEvaluatedAt,
                    })),
                )
                .onConflict(['alert_rule_uuid', 'fingerprint'])
                .merge([
                    'labels',
                    'annotations',
                    'state',
                    'value',
                    'state_since',
                    'active_at',
                    'last_condition_met_at',
                    'last_evaluated_at',
                ]);
        });
    }
}
