import {
    type AlertInstanceState,
    type AlertStateHistoryEntry,
} from '@lightdash/common';
import { type Knex } from 'knex';
import { type AlertSeriesTransition } from './evaluateAlertSeries';

// Table from migration 20261108120000_create_alerting_tables.
export const AlertStateHistoryTableName = 'alert_state_history';

type DbAlertStateHistory = {
    alert_state_history_uuid: string;
    alert_rule_uuid: string;
    fingerprint: string;
    labels: Record<string, string>;
    previous_state: AlertInstanceState;
    state: AlertInstanceState;
    value: number | null;
    at: Date;
};

/** The state history of Alert Rules: every series transition. */
export class AlertStateHistoryModel {
    constructor(private readonly database: Knex) {}

    /** Writes the transitions of one evaluation, in the caller's transaction. */
    static async insertTransitions(
        trx: Knex,
        {
            projectUuid,
            ruleUuid,
            at,
            transitions,
        }: {
            projectUuid: string;
            ruleUuid: string;
            at: Date;
            transitions: readonly AlertSeriesTransition[];
        },
    ): Promise<void> {
        if (transitions.length === 0) return;
        await trx(AlertStateHistoryTableName).insert(
            transitions.map((transition) => ({
                project_uuid: projectUuid,
                alert_rule_uuid: ruleUuid,
                fingerprint: transition.fingerprint,
                labels: JSON.stringify(transition.labels),
                previous_state: transition.previousState,
                state: transition.state,
                value: transition.value,
                at,
            })),
        );
    }

    /** The rule's history, newest first. */
    async listForRule(ruleUuid: string): Promise<AlertStateHistoryEntry[]> {
        const rows = await this.database(AlertStateHistoryTableName)
            .where('alert_rule_uuid', ruleUuid)
            .whereNotNull('fingerprint')
            .orderBy([
                { column: 'at', order: 'desc' },
                { column: 'fingerprint', order: 'asc' },
            ])
            .select<DbAlertStateHistory[]>(
                'alert_state_history_uuid',
                'alert_rule_uuid',
                'fingerprint',
                'labels',
                'previous_state',
                'state',
                'value',
                'at',
            );
        return rows.map((row) => ({
            type: 'transition',
            uuid: row.alert_state_history_uuid,
            ruleUuid: row.alert_rule_uuid,
            fingerprint: row.fingerprint,
            labels: row.labels,
            previousState: row.previous_state,
            state: row.state,
            value: row.value === null ? null : Number(row.value),
            at: row.at.toISOString(),
        }));
    }
}
