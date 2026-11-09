/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Pure alerting core exported from @lightdash/common (packages/common/src/alerting/**).
// Each describe is one feature; checks select it with `-t <feature-id>`.
// Everything is imported from the package entry, so it must be exported there.
import { describe, expect, it } from 'vitest';

const common = async () => (await import('../../index')) as Record<string, any>;

describe('alert-durations', () => {
    it('parses and formats Prometheus-style durations', async () => {
        const { parsePrometheusDuration, formatPrometheusDuration } =
            await common();
        expect(parsePrometheusDuration('30s')).toBe(30_000);
        expect(parsePrometheusDuration('5m')).toBe(300_000);
        expect(parsePrometheusDuration('1h30m')).toBe(5_400_000);
        expect(parsePrometheusDuration('1d')).toBe(86_400_000);
        expect(parsePrometheusDuration('250ms')).toBe(250);
        expect(parsePrometheusDuration('0s')).toBe(0);
        expect(() => parsePrometheusDuration('5 minutes')).toThrow();
        expect(() => parsePrometheusDuration('')).toThrow();
        expect(() => parsePrometheusDuration('-1m')).toThrow();
        expect(formatPrometheusDuration(3_600_000)).toBe('1h');
        expect(formatPrometheusDuration(5_400_000)).toBe('1h30m');
        expect(formatPrometheusDuration(30_000)).toBe('30s');
        expect(formatPrometheusDuration(0)).toBe('0s');
    });
});

describe('alert-reducers', () => {
    it('reduces a series with each reducer, ignoring nulls', async () => {
        const { reduceAlertSeries, ALERT_REDUCERS } = await common();
        expect([...ALERT_REDUCERS].sort()).toEqual(
            ['count', 'last', 'max', 'mean', 'min', 'sum'].sort(),
        );
        const values = [3, 9, null, 1, 7];
        expect(reduceAlertSeries(values, 'last')).toBe(7);
        expect(reduceAlertSeries(values, 'mean')).toBe(5);
        expect(reduceAlertSeries(values, 'max')).toBe(9);
        expect(reduceAlertSeries(values, 'min')).toBe(1);
        expect(reduceAlertSeries(values, 'sum')).toBe(20);
        expect(reduceAlertSeries(values, 'count')).toBe(4);
        expect(reduceAlertSeries([4, null], 'last')).toBe(4);
        expect(reduceAlertSeries([], 'max')).toBeNull();
        expect(reduceAlertSeries([null], 'mean')).toBeNull();
        expect(reduceAlertSeries([], 'count')).toBe(0);
    });
});

describe('alert-conditions', () => {
    it('checks thresholds and ranges', async () => {
        const { evaluateAlertCondition: ev } = await common();
        expect(ev(6, { operator: '>', threshold: 5 })).toBe(true);
        expect(ev(5, { operator: '>', threshold: 5 })).toBe(false);
        expect(ev(5, { operator: '>=', threshold: 5 })).toBe(true);
        expect(ev(4, { operator: '<', threshold: 5 })).toBe(true);
        expect(ev(5, { operator: '<=', threshold: 5 })).toBe(true);
        expect(ev(5, { operator: '==', threshold: 5 })).toBe(true);
        expect(ev(5, { operator: '!=', threshold: 5 })).toBe(false);
        const within = { operator: 'within_range', min: 10, max: 20 };
        const outside = { operator: 'outside_range', min: 10, max: 20 };
        expect(ev(15, within)).toBe(true);
        expect(ev(10, within)).toBe(false);
        expect(ev(9, outside)).toBe(true);
        expect(ev(21, outside)).toBe(true);
        expect(ev(15, outside)).toBe(false);
        expect(ev(null, { operator: '>', threshold: 0 })).toBe(false);
        expect(ev(null, outside)).toBe(false);
    });
});

describe('alert-series-split', () => {
    it('splits SQL rows by every non-value, non-time column', async () => {
        const { splitAlertSeries } = await common();
        const rows = [
            { time: '2026-11-08T09:00:00Z', job_name: 'a', value: 1 },
            { time: '2026-11-08T09:00:00Z', job_name: 'b', value: 5 },
            { time: '2026-11-08T09:01:00Z', job_name: 'a', value: 2 },
            { time: '2026-11-08T09:01:00Z', job_name: 'b', value: null },
        ];
        const series = splitAlertSeries(rows);
        expect(series).toHaveLength(2);
        const a = series.find((s: any) => s.labels.job_name === 'a');
        const b = series.find((s: any) => s.labels.job_name === 'b');
        expect(a.labels).toEqual({ job_name: 'a' });
        expect(a.values).toEqual([1, 2]);
        expect(b.values).toEqual([5, null]);
        expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
        expect(a.fingerprint).not.toBe(b.fingerprint);
    });
    it('uses the labels json column for telemetry shapes', async () => {
        const { splitAlertSeries, alertLabelsFingerprint } = await common();
        const rows = [
            {
                timestamp: '2026-11-08T09:00:00Z',
                value: 0.5,
                labels: '{"pod":"api-1","namespace":"platform"}',
                series: '{namespace="platform",pod="api-1"}',
            },
            {
                timestamp: '2026-11-08T09:00:30Z',
                value: 0.7,
                labels: { namespace: 'platform', pod: 'api-1' },
                series: '{namespace="platform",pod="api-1"}',
            },
            {
                timestamp: '2026-11-08T09:00:00Z',
                value: 0.1,
                labels: { namespace: 'platform', pod: 'api-2' },
                series: '{namespace="platform",pod="api-2"}',
            },
        ];
        const series = splitAlertSeries(rows);
        expect(series).toHaveLength(2);
        const api1 = series.find((s: any) => s.labels.pod === 'api-1');
        expect(api1.labels).toEqual({ namespace: 'platform', pod: 'api-1' });
        expect(api1.values).toEqual([0.5, 0.7]);
        expect(alertLabelsFingerprint({ a: '1', b: '2' })).toBe(
            alertLabelsFingerprint({ b: '2', a: '1' }),
        );
        expect(api1.fingerprint).toBe(
            alertLabelsFingerprint({ pod: 'api-1', namespace: 'platform' }),
        );
    });
    it('honours a custom value column and returns nothing for no rows', async () => {
        const { splitAlertSeries } = await common();
        const series = splitAlertSeries([{ queue: 'fills', depth: 12 }], {
            valueColumn: 'depth',
        });
        expect(series).toEqual([
            expect.objectContaining({
                labels: { queue: 'fills' },
                values: [12],
            }),
        ]);
        expect(splitAlertSeries([])).toEqual([]);
    });
});

const at = (minutes: number) =>
    new Date(Date.UTC(2026, 10, 8, 9, 0, 0) + minutes * 60_000);

describe('alert-state-machine', () => {
    it('goes pending then firing after `for`', async () => {
        const { transitionAlertInstance } = await common();
        const timing = { forMs: 120_000, keepFiringForMs: 0 };
        let snap: any;
        const seen: string[] = [];
        for (let m = 0; m < 4; m += 1) {
            snap = transitionAlertInstance(
                snap,
                { conditionMet: true, at: at(m) },
                timing,
            );
            seen.push(snap.state);
        }
        expect(seen).toEqual(['pending', 'pending', 'firing', 'firing']);
        snap = transitionAlertInstance(
            undefined,
            { conditionMet: true, at: at(0) },
            timing,
        );
        snap = transitionAlertInstance(
            snap,
            { conditionMet: false, at: at(1) },
            timing,
        );
        expect(snap.state).toBe('normal');
    });
    it('fires at once with for 0s, resolves, then returns to normal', async () => {
        const { transitionAlertInstance } = await common();
        const timing = { forMs: 0, keepFiringForMs: 0 };
        const met = [true, false, false];
        const seen: string[] = [];
        let snap: any;
        met.forEach((conditionMet, m) => {
            snap = transitionAlertInstance(
                snap,
                { conditionMet, at: at(m) },
                timing,
            );
            seen.push(snap.state);
        });
        expect(seen).toEqual(['firing', 'resolved', 'normal']);
        expect(new Date(snap.stateSince).toISOString()).toBe(
            at(2).toISOString(),
        );
    });
    it('keeps firing for keepFiringFor after the condition clears', async () => {
        const { transitionAlertInstance } = await common();
        const timing = { forMs: 0, keepFiringForMs: 120_000 };
        const met = [true, false, false, false];
        const seen: string[] = [];
        let snap: any;
        met.forEach((conditionMet, m) => {
            snap = transitionAlertInstance(
                snap,
                { conditionMet, at: at(m) },
                timing,
            );
            seen.push(snap.state);
        });
        expect(seen).toEqual(['firing', 'firing', 'resolved', 'normal']);
    });
});

describe('alert-evaluator-identity', () => {
    it('marks alert rule queries with the system identity', async () => {
        const { buildAlertEvaluatorQueryContext } = await common();
        const context = buildAlertEvaluatorQueryContext({
            ruleUuid: '3f0a4f8e-0000-4000-8000-000000000001',
            projectUuid: '3f0a4f8e-0000-4000-8000-0000000000aa',
            description: 'Pages when RDS free storage drops below 10%',
        });
        expect(context).toMatchObject({
            sub: 'system:alert-evaluator',
            sys: true,
            agent: false,
            projectUuid: '3f0a4f8e-0000-4000-8000-0000000000aa',
            audit: {
                description: 'Pages when RDS free storage drops below 10%',
                source: 'alert_rule',
                resource_uuid: '3f0a4f8e-0000-4000-8000-000000000001',
            },
        });
        expect(() =>
            buildAlertEvaluatorQueryContext({
                ruleUuid: 'r',
                projectUuid: 'p',
                description: '   ',
            }),
        ).toThrow();
    });
});

describe('alert-scheduler-task-names', () => {
    it('registers the alerting graphile-worker task names', async () => {
        const { ALERTING_SCHEDULER_TASKS, SCHEDULER_TASKS, ALL_TASK_NAMES } =
            await common();
        expect(ALERTING_SCHEDULER_TASKS).toEqual({
            ALERTING_TICK: 'alertingTick',
            ALERT_RULE_EVALUATE: 'alertRuleEvaluate',
        });
        expect(Object.values(SCHEDULER_TASKS)).toEqual(
            expect.arrayContaining(['alertingTick', 'alertRuleEvaluate']),
        );
        expect(ALL_TASK_NAMES).toContain('alertRuleEvaluate');
    });
});
