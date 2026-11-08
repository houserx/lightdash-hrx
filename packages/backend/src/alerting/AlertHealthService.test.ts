import { describe, expect, it } from 'vitest';
import { AlertHealthService } from './AlertHealthService';

const lastCycle = new Date('2026-11-08T12:00:00.000Z');

const healthAt = (secondsLater: number, latest: Date | null = lastCycle) =>
    new AlertHealthService({
        alertHeartbeatModel: { getLatestCompletedAt: async () => latest },
        clock: {
            now: () =>
                new Date((latest ?? lastCycle).getTime() + secondsLater * 1000),
        },
    }).getHealth();

describe('AlertHealthService', () => {
    it('reports never_run before the first cycle', async () => {
        expect(await healthAt(0, null)).toEqual({
            status: 'never_run',
            lastCycleAt: null,
            lagSeconds: null,
        });
    });

    it('stays ok up to a minute of silence', async () => {
        expect(await healthAt(60)).toEqual({
            status: 'ok',
            lastCycleAt: lastCycle.toISOString(),
            lagSeconds: 60,
        });
    });

    it('is stale after a minute of silence', async () => {
        expect(await healthAt(61)).toMatchObject({
            status: 'stale',
            lagSeconds: 61,
        });
    });

    it('rounds partial seconds down and never reports negative lag', async () => {
        expect(await healthAt(20.9)).toMatchObject({ lagSeconds: 20 });
        expect(await healthAt(-5)).toMatchObject({
            status: 'ok',
            lagSeconds: 0,
        });
    });
});
