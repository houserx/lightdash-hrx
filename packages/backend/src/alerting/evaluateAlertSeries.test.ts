import { describe, expect, it } from 'vitest';
import {
    evaluateAlertSeries,
    getAlertInstanceLabels,
    type AlertInstanceRecord,
} from './evaluateAlertSeries';

const T0 = new Date('2026-11-08T09:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const rule = {
    name: 'Disk almost full',
    labels: { team: 'infra' },
    annotations: { summary: 'Disk almost full' },
    valueColumn: 'value',
    reducer: 'last' as const,
    condition: { operator: '>' as const, threshold: 90 },
    for: '0s',
    keepFiringFor: '0s',
};

const disk = (values: Record<string, number>) =>
    Object.entries(values).map(([instance, value]) => ({ instance, value }));

const byInstance = (instances: AlertInstanceRecord[], name: string) =>
    instances.find((i) => i.labels.instance === name);

describe('evaluateAlertSeries', () => {
    it('gives every series its own state, value and labels', () => {
        const { instances, removedFingerprints } = evaluateAlertSeries({
            rule,
            rows: disk({ 'db-1': 95, 'db-2': 40, 'db-3': 99 }),
            previous: [],
            at: T0,
        });
        expect(removedFingerprints).toEqual([]);
        expect(instances).toHaveLength(3);
        expect(byInstance(instances, 'db-1')).toMatchObject({
            state: 'firing',
            value: 95,
            stateSince: T0,
            labels: {
                instance: 'db-1',
                team: 'infra',
                alertname: 'Disk almost full',
            },
            annotations: { summary: 'Disk almost full' },
        });
        expect(byInstance(instances, 'db-2')).toMatchObject({
            state: 'normal',
            value: 40,
        });
        expect(byInstance(instances, 'db-3')?.state).toBe('firing');
        expect(new Set(instances.map((i) => i.fingerprint)).size).toBe(3);
    });

    it('reduces each series with the rule reducer', () => {
        const { instances } = evaluateAlertSeries({
            rule: { ...rule, reducer: 'max' },
            rows: [
                { instance: 'db-1', value: 95 },
                { instance: 'db-1', value: 20 },
            ],
            previous: [],
            at: T0,
        });
        expect(instances).toHaveLength(1);
        expect(instances[0]).toMatchObject({ state: 'firing', value: 95 });
    });

    it('lets rule labels win over series labels and sets alertname last', () => {
        expect(
            getAlertInstanceLabels(rule, {
                instance: 'db-1',
                team: 'other',
                alertname: 'x',
            }),
        ).toEqual({
            instance: 'db-1',
            team: 'infra',
            alertname: 'Disk almost full',
        });
    });

    it('continues from the previous snapshot of the same series', () => {
        const first = evaluateAlertSeries({
            rule: { ...rule, for: '2m' },
            rows: disk({ 'db-1': 95 }),
            previous: [],
            at: T0,
        });
        expect(first.instances[0].state).toBe('pending');
        const third = evaluateAlertSeries({
            rule: { ...rule, for: '2m' },
            rows: disk({ 'db-1': 96 }),
            previous: first.instances,
            at: at(2),
        });
        expect(third.instances[0]).toMatchObject({
            state: 'firing',
            value: 96,
            stateSince: at(2),
        });
    });

    it('fires only after `for` and returns a recovered pending series to normal', () => {
        const forRule = { ...rule, for: '2m' };
        const states: Record<string, string[]> = { 'db-1': [], 'db-2': [] };
        let previous: AlertInstanceRecord[] = [];
        for (const m of [0, 1, 2, 3]) {
            ({ instances: previous } = evaluateAlertSeries({
                rule: forRule,
                rows: disk({ 'db-1': 95, 'db-2': m === 0 ? 95 : 10 }),
                previous,
                at: at(m),
            }));
            for (const name of ['db-1', 'db-2'])
                states[name].push(byInstance(previous, name)!.state);
        }
        expect(states).toEqual({
            'db-1': ['pending', 'pending', 'firing', 'firing'],
            'db-2': ['pending', 'normal', 'normal', 'normal'],
        });
        expect(byInstance(previous, 'db-1')?.stateSince).toEqual(at(2));
    });

    it('keeps a recovered series firing for `keepFiringFor`, then resolves it', () => {
        const keepRule = { ...rule, keepFiringFor: '2m' };
        const states: string[] = [];
        let previous: AlertInstanceRecord[] = [];
        for (const [m, value] of [
            [0, 95],
            [1, 10],
            [2, 10],
            [3, 10],
        ] as const) {
            ({ instances: previous } = evaluateAlertSeries({
                rule: keepRule,
                rows: disk({ 'db-1': value }),
                previous,
                at: at(m),
            }));
            states.push(byInstance(previous, 'db-1')!.state);
        }
        expect(states).toEqual(['firing', 'firing', 'resolved', 'normal']);
        expect(byInstance(previous, 'db-1')?.stateSince).toEqual(at(3));
    });

    it('resolves a firing series missing from the result, then removes it', () => {
        const fired = evaluateAlertSeries({
            rule,
            rows: disk({ 'db-1': 95, 'db-2': 40 }),
            previous: [],
            at: T0,
        });
        const gone = evaluateAlertSeries({
            rule,
            rows: disk({ 'db-2': 40 }),
            previous: fired.instances,
            at: at(1),
        });
        expect(byInstance(gone.instances, 'db-1')).toMatchObject({
            state: 'resolved',
            value: null,
        });
        const cleared = evaluateAlertSeries({
            rule,
            rows: disk({ 'db-2': 40 }),
            previous: gone.instances,
            at: at(2),
        });
        expect(byInstance(cleared.instances, 'db-1')).toBeUndefined();
        expect(cleared.removedFingerprints).toEqual([
            byInstance(fired.instances, 'db-1')?.fingerprint,
        ]);
    });

    it('leaves the stored series alone when the result is empty', () => {
        const fired = evaluateAlertSeries({
            rule,
            rows: disk({ 'db-1': 95 }),
            previous: [],
            at: T0,
        });
        expect(
            evaluateAlertSeries({
                rule,
                rows: [],
                previous: fired.instances,
                at: at(1),
            }),
        ).toEqual({ instances: fired.instances, removedFingerprints: [] });
    });
});
