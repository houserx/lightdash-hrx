import { describe, expect, it, vi } from 'vitest';
import {
    ALERTING_TICK_JOB_KEY,
    createAlertingTaskHandlers,
} from './alertingTaskHandlers';

const NOW = new Date('2026-11-08T09:01:00.000Z');

const setup = (tick: () => Promise<{ enqueued: [] }>) => {
    const addJob = vi.fn(async () => {});
    const evaluateRule = vi.fn(async () => ({
        status: 'evaluated' as const,
    }));
    const handlers = createAlertingTaskHandlers({
        evaluator: { evaluateRule },
        scheduler: { tick },
        jobQueue: { addJob },
        clock: { now: () => NOW },
    });
    return { handlers, addJob, evaluateRule };
};

describe('alerting task handlers', () => {
    it('queues the next tick 15s later under one job key', async () => {
        const { handlers, addJob } = setup(async () => ({ enqueued: [] }));
        await handlers.alertingTick({});
        expect(addJob).toHaveBeenCalledWith(
            'alertingTick',
            {},
            {
                jobKey: ALERTING_TICK_JOB_KEY,
                runAt: new Date('2026-11-08T09:01:15.000Z'),
            },
        );
    });

    it('still queues the next tick when the cycle fails', async () => {
        const { handlers, addJob } = setup(async () => {
            throw new Error('database unavailable');
        });
        await expect(handlers.alertingTick({})).resolves.toBeUndefined();
        expect(addJob).toHaveBeenCalledTimes(1);
    });

    it('throws when the next tick cannot be queued, so graphile retries', async () => {
        const { handlers, addJob } = setup(async () => ({ enqueued: [] }));
        addJob.mockRejectedValueOnce(new Error('queue down'));
        await expect(handlers.alertingTick({})).rejects.toThrow('queue down');
    });

    it('evaluates the rule for the payload slot', async () => {
        const { handlers, evaluateRule } = setup(async () => ({
            enqueued: [],
        }));
        await handlers.alertRuleEvaluate({
            ruleUuid: 'rule-1',
            scheduledAt: '2026-11-08T09:00:00.000Z',
        });
        expect(evaluateRule).toHaveBeenCalledWith('rule-1', {
            scheduledAt: new Date('2026-11-08T09:00:00.000Z'),
        });
    });

    it('rejects a payload without a valid slot', async () => {
        const { handlers, evaluateRule } = setup(async () => ({
            enqueued: [],
        }));
        await expect(
            handlers.alertRuleEvaluate({ ruleUuid: 'rule-1', scheduledAt: '' }),
        ).rejects.toThrow('invalid scheduledAt');
        expect(evaluateRule).not.toHaveBeenCalled();
    });
});
