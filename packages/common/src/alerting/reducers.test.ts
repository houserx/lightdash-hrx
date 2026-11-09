import { ALERT_REDUCERS, isAlertReducer, reduceAlertSeries } from './reducers';

describe('reduceAlertSeries', () => {
    const series = [3, 9, null, 1, 7];

    it.each([
        ['last', 7],
        ['mean', 5],
        ['max', 9],
        ['min', 1],
        ['sum', 20],
        ['count', 4],
    ] as const)('%s ignores nulls', (reducer, expected) => {
        expect(reduceAlertSeries(series, reducer)).toBe(expected);
    });

    it('last skips trailing nulls', () => {
        expect(reduceAlertSeries([4, null, undefined], 'last')).toBe(4);
    });

    it.each(ALERT_REDUCERS.filter((r) => r !== 'count'))(
        '%s of an empty or all-null series is null',
        (reducer) => {
            expect(reduceAlertSeries([], reducer)).toBeNull();
            expect(reduceAlertSeries([null, null], reducer)).toBeNull();
        },
    );

    it('count of an empty series is 0', () => {
        expect(reduceAlertSeries([], 'count')).toBe(0);
        expect(reduceAlertSeries([null], 'count')).toBe(0);
    });

    it('handles negatives and zero', () => {
        expect(reduceAlertSeries([-5, 0, -1], 'max')).toBe(0);
        expect(reduceAlertSeries([-5, 0, -1], 'min')).toBe(-5);
    });
});

describe('isAlertReducer', () => {
    it('accepts known reducers only', () => {
        expect(isAlertReducer('mean')).toBe(true);
        expect(isAlertReducer('avg')).toBe(false);
        expect(isAlertReducer(1)).toBe(false);
    });
});
