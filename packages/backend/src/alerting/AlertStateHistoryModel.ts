import {
    type AlertInstanceState,
    type AlertStateHistoryEntry,
} from '@lightdash/common';
import { type Knex } from 'knex';
import { type AlertSeriesTransition } from './evaluateAlertSeries';

// Table from migration 20261108120000_create_alerting_tables.
export const AlertStateHistoryTableName = 'alert_state_history';

/**
 * `state` of a rule-level row for a skipped evaluation (the column is NOT
 * NULL; such rows have no series, so `fingerprint` is null).
 */
const EvaluationSkippedState = 'evaluation_skipped';

type DbAlertStateHistory = {
    alert_state_history_uuid: string;
    alert_rule_uuid: string;
    fingerprint: string | null;
    labels: Record<string, string>;
    previous_state: AlertInstanceState | null;
    state: AlertInstanceState | typeof EvaluationSkippedState;
    value: number | null;
    reason: string | null;
    at: Date;
};

/**
 * The state history of Alert Rules: every series transition, and every
 * scheduled evaluation that was skipped.
 */
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

    /** Records a skipped evaluation of the rule's `at` slot. */
    static async insertEvaluationSkipped(
        trx: Knex,
        {
            projectUuid,
            ruleUuid,
            at,
            reason,
        }: {
            projectUuid: string;
            ruleUuid: string;
            at: Date;
            reason: string;
        },
    ): Promise<void> {
        await trx(AlertStateHistoryTableName).insert({
            project_uuid: projectUuid,
            alert_rule_uuid: ruleUuid,
            fingerprint: null,
            state: EvaluationSkippedState,
            reason,
            at,
        });
    }

    /** The rule's history, newest first. */
    async listForRule(ruleUuid: string): Promise<AlertStateHistoryEntry[]> {
        const rows = await this.database(AlertStateHistoryTableName)
            .where('alert_rule_uuid', ruleUuid)
            .orderBy([
                { column: 'at', order: 'desc' },
                // Rule-level entries (no fingerprint) first within a slot.
                { column: 'fingerprint', order: 'asc', nulls: 'first' },
            ])
            .select<DbAlertStateHistory[]>(
                'alert_state_history_uuid',
                'alert_rule_uuid',
                'fingerprint',
                'labels',
                'previous_state',
                'state',
                'value',
                'reason',
                'at',
            );
        return rows.map((row): AlertStateHistoryEntry => {
            if (
                row.fingerprint === null ||
                row.state === EvaluationSkippedState
            ) {
                return {
                    type: 'evaluation_skipped',
                    uuid: row.alert_state_history_uuid,
                    ruleUuid: row.alert_rule_uuid,
                    reason: row.reason ?? 'unknown',
                    at: row.at.toISOString(),
                };
            }
            return {
                type: 'transition',
                uuid: row.alert_state_history_uuid,
                ruleUuid: row.alert_rule_uuid,
                fingerprint: row.fingerprint,
                labels: row.labels,
                previousState: row.previous_state ?? 'normal',
                state: row.state,
                value: row.value === null ? null : Number(row.value),
                at: row.at.toISOString(),
            };
        });
    }
}
