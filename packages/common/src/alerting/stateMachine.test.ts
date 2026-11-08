import {
    isAlertInstanceState,
    transitionAlertInstance,
    type AlertInstanceSnapshot,
    type AlertInstanceTiming,
} from './stateMachine';

const at = (minutes: number) =>
    new Date(Date.UTC(2026, 10, 8, 9, 0, 0) + minutes * 60_000);

const run = (met: boolean[], timing: AlertInstanceTiming) => {
    const snapshots: AlertInstanceSnapshot[] = [];
    met.reduce<AlertInstanceSnapshot | undefined>((snap, conditionMet, m) => {
        const next = transitionAlertInstance(
            snap,
            { conditionMet, at: at(m) },
            timing,
        );
        snapshots.push(next);
        return next;
    }, undefined);
    return snapshots;
};

describe('transitionAlertInstance', () => {
    it('goes pending, then firing once the condition held for `for`', () => {
        const snaps = run([true, true, true, true], {
            forMs: 120_000,
            keepFiringForMs: 0,
        });
        expect(snaps.map((s) => s.state)).toEqual([
            'pending',
            'pending',
            'firing',
            'firing',
        ]);
        expect(snaps[1].stateSince).toEqual(at(0));
        expect(snaps[2].stateSince).toEqual(at(2));
        expect(snaps[3].stateSince).toEqual(at(2));
        expect(snaps[3].activeAt).toEqual(at(0));
    });

    it('returns a pending series to normal when the condition clears', () => {
        const snaps = run([true, false], {
            forMs: 120_000,
            keepFiringForMs: 0,
        });
        expect(snaps.map((s) => s.state)).toEqual(['pending', 'normal']);
        expect(snaps[1].activeAt).toBeNull();
    });

    it('fires at once with for 0s, resolves, then returns to normal', () => {
        const snaps = run([true, false, false, false], {
            forMs: 0,
            keepFiringForMs: 0,
        });
        expect(snaps.map((s) => s.state)).toEqual([
            'firing',
            'resolved',
            'normal',
            'normal',
        ]);
        expect(snaps[2].stateSince).toEqual(at(2));
        expect(snaps[3].stateSince).toEqual(at(2));
        expect(snaps[3].lastConditionMetAt).toEqual(at(0));
    });

    it('keeps firing for keepFiringFor after the condition last held', () => {
        const snaps = run([true, false, false, false], {
            forMs: 0,
            keepFiringForMs: 120_000,
        });
        expect(snaps.map((s) => s.state)).toEqual([
            'firing',
            'firing',
            'resolved',
            'normal',
        ]);
        expect(snaps[1].stateSince).toEqual(at(0));
    });

    it('restarts keepFiringFor when the condition holds again', () => {
        const snaps = run([true, false, true, false, false], {
            forMs: 0,
            keepFiringForMs: 120_000,
        });
        expect(snaps.map((s) => s.state)).toEqual([
            'firing',
            'firing',
            'firing',
            'firing',
            'resolved',
        ]);
    });

    it('starts a new episode when a resolved series meets the condition', () => {
        const snaps = run([true, false, true], {
            forMs: 60_000,
            keepFiringForMs: 0,
        });
        // pending at 0, normal at 1 (never fired), pending again at 2
        expect(snaps.map((s) => s.state)).toEqual([
            'pending',
            'normal',
            'pending',
        ]);
        expect(snaps[2].activeAt).toEqual(at(2));
    });

    it('treats nodata and error like a series that is not firing', () => {
        const previous: AlertInstanceSnapshot = {
            state: 'nodata',
            stateSince: at(0),
            activeAt: null,
            lastConditionMetAt: null,
            lastEvaluatedAt: at(0),
        };
        const timing = { forMs: 60_000, keepFiringForMs: 0 };
        expect(
            transitionAlertInstance(
                previous,
                { conditionMet: true, at: at(1) },
                timing,
            ).state,
        ).toBe('pending');
        expect(
            transitionAlertInstance(
                { ...previous, state: 'error' },
                { conditionMet: false, at: at(1) },
                timing,
            ).state,
        ).toBe('normal');
    });

    it('accepts a snapshot with ISO string timestamps, as read from JSON', () => {
        const [first] = run([true], { forMs: 120_000, keepFiringForMs: 0 });
        const fromJson = JSON.parse(JSON.stringify(first));
        const next = transitionAlertInstance(
            fromJson,
            { conditionMet: true, at: at(2).toISOString() },
            { forMs: 120_000, keepFiringForMs: 0 },
        );
        expect(next.state).toBe('firing');
        expect(next.activeAt).toEqual(at(0));
    });

    it('rejects invalid timestamps and negative durations', () => {
        expect(() =>
            transitionAlertInstance(
                undefined,
                { conditionMet: true, at: 'not a date' },
                { forMs: 0, keepFiringForMs: 0 },
            ),
        ).toThrow();
        expect(() =>
            transitionAlertInstance(
                undefined,
                { conditionMet: true, at: at(0) },
                { forMs: -1, keepFiringForMs: 0 },
            ),
        ).toThrow();
    });
});

describe('isAlertInstanceState', () => {
    it('knows the six states', () => {
        expect(isAlertInstanceState('nodata')).toBe(true);
        expect(isAlertInstanceState('alerting')).toBe(false);
    });
});
