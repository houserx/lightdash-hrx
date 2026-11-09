import { type AlertHeartbeatModel } from './AlertHeartbeatModel';

/** The evaluator counts as stale after this long without a completed cycle. */
export const ALERTING_STALE_AFTER_SECONDS = 60;

export type AlertingHealth = {
    status: 'never_run' | 'ok' | 'stale';
    /** ISO time the latest scheduler cycle completed, or null before the first. */
    lastCycleAt: string | null;
    /** Whole seconds since `lastCycleAt`, or null before the first cycle. */
    lagSeconds: number | null;
};

type AlertHealthServiceDeps = {
    alertHeartbeatModel: Pick<AlertHeartbeatModel, 'getLatestCompletedAt'>;
    clock: { now(): Date };
};

/** Evaluator lag, read from the heartbeat rows each scheduler cycle writes. */
export class AlertHealthService {
    constructor(private readonly deps: AlertHealthServiceDeps) {}

    async getHealth(): Promise<AlertingHealth> {
        const lastCycle =
            await this.deps.alertHeartbeatModel.getLatestCompletedAt();
        if (!lastCycle) {
            return { status: 'never_run', lastCycleAt: null, lagSeconds: null };
        }
        const lagSeconds = Math.max(
            0,
            Math.floor(
                (this.deps.clock.now().getTime() - lastCycle.getTime()) / 1000,
            ),
        );
        return {
            status: lagSeconds > ALERTING_STALE_AFTER_SECONDS ? 'stale' : 'ok',
            lastCycleAt: lastCycle.toISOString(),
            lagSeconds,
        };
    }
}
