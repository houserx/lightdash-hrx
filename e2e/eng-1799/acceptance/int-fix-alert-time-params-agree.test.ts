/* eslint-disable */
// @ts-nocheck
// int-fix-alert-time-params-agree: the alerting evaluator's reserved time parameters
// (common/alerting/queryParameters.ts) equal ldq's (common/utils/timeRange.ts) for the same
// absolute window, including durations of a week or more (the formatPrometheusDuration clash),
// and the engine accepts every __interval / __range they produce as a step.
import { disposeAll, harness, load, pgRun, track } from './support';

afterAll(disposeAll);

const AT = new Date('2026-11-08T10:00:00.000Z');
const RANGES: [string, number][] = [
    ['10m', 600_000],
    ['1h', 3_600_000],
    ['6h', 21_600_000],
    ['1d', 86_400_000],
    ['7d', 7 * 86_400_000],
    ['14d', 14 * 86_400_000],
    ['30d', 30 * 86_400_000],
];

describe('int-fix-alert-time-params-agree', () => {
    it('both modules produce identical values, and the engine accepts them', async () => {
        const common = await load('packages/common/src/index.ts');
        const alerting = await load('packages/common/src/alerting/queryParameters.ts');
        const ldq = await load('packages/common/src/utils/timeRange.ts');
        const durations = await load('packages/common/src/alerting/durations.ts');
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));

        for (const [timeRange, ms] of RANGES) {
            const fromAlerting = alerting.resolveAlertQueryParameters({ at: AT, timeRange });
            const fromLdq = ldq.getReservedTimeParameterValues({ from: new Date(AT.getTime() - ms).toISOString(), to: AT.toISOString() }, { now: AT });
            expect(fromAlerting, timeRange).toEqual({
                __from: fromLdq.__from,
                __to: fromLdq.__to,
                __interval: fromLdq.__interval,
                __range: fromLdq.__range,
            });
            expect(durations.formatPrometheusDuration(ms), timeRange).toBe(ldq.formatPrometheusDuration(ms));
            expect(common.formatPrometheusDuration(ms), timeRange).toBe(ldq.formatPrometheusDuration(ms));

            for (const step of [fromAlerting.__interval, fromAlerting.__range]) {
                const result = await pgRun(engine, [`SELECT count(*) AS n FROM promql('up', '${fromAlerting.__from}', '${fromAlerting.__to}', '${step}')`]);
                expect(result.error, `${timeRange} step ${step}`).toBeUndefined();
                expect(Number(result.rows[0].n)).toBeGreaterThan(0);
            }
        }
    });
});
