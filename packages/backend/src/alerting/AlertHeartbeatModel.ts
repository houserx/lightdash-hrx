import { type Knex } from 'knex';

// Table from migration 20261108120000_create_alerting_tables.
export const AlertEvaluatorHeartbeatsTableName = 'alert_evaluator_heartbeats';

export type AlertEvaluatorHeartbeat = {
    cycleStartedAt: Date;
    completedAt: Date;
    /** Rules enqueued for evaluation in this cycle. */
    rulesEvaluated: number;
    /** The heartbeat URL's HTTP status, `failed`, or null without a URL. */
    heartbeatStatus: string | null;
    error: string | null;
};

/** One append-only row per completed scheduler cycle. */
export class AlertHeartbeatModel {
    constructor(private readonly database: Knex) {}

    async insert(heartbeat: AlertEvaluatorHeartbeat): Promise<void> {
        await this.database(AlertEvaluatorHeartbeatsTableName).insert({
            cycle_started_at: heartbeat.cycleStartedAt,
            completed_at: heartbeat.completedAt,
            rules_evaluated: heartbeat.rulesEvaluated,
            heartbeat_status: heartbeat.heartbeatStatus,
            error: heartbeat.error,
        });
    }
}
