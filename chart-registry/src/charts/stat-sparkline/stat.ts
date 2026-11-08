/**
 * The stat's model: the rows' values in time order and the one value a
 * Grafana reducer (`options.reduceOptions.calcs[0]`) makes of them.
 */

export type StatPoint = { time: number | null; value: number | null };

export const REDUCERS = [
    'lastNotNull',
    'last',
    'firstNotNull',
    'first',
    'min',
    'max',
    'mean',
    'sum',
    'count',
    'range',
] as const;

export type Reducer = (typeof REDUCERS)[number];

export const DEFAULT_REDUCER: Reducer = 'lastNotNull';

export const isReducer = (value: unknown): value is Reducer =>
    (REDUCERS as readonly unknown[]).includes(value);

/**
 * Points in time order: rows with a time sorted by it (stable, so equal
 * times keep row order); rows without one stay in row order after them.
 * When no row has a time, row order is the series order.
 */
export const orderPoints = (points: StatPoint[]): StatPoint[] => {
    const timed = points.filter((p) => p.time !== null);
    const untimed = points.filter((p) => p.time === null);
    timed.sort((a, b) => (a.time as number) - (b.time as number));
    return [...timed, ...untimed];
};

/**
 * Grafana's field reducer. Null values are skipped by every reducer except
 * `last`, `first` and `count` (which counts every row, as Grafana does).
 * Returns null when there is no value to show.
 */
export const reduce = (
    values: (number | null)[],
    reducer: Reducer,
): number | null => {
    const numbers = values.filter((v): v is number => v !== null);
    switch (reducer) {
        case 'last':
            return values.length > 0 ? values[values.length - 1] : null;
        case 'first':
            return values.length > 0 ? values[0] : null;
        case 'count':
            return values.length;
        default:
            break;
    }
    if (numbers.length === 0) return null;
    // Loops, not Math.min(...numbers): spreading a large result overflows the stack.
    const min = numbers.reduce((a, b) => (b < a ? b : a));
    const max = numbers.reduce((a, b) => (b > a ? b : a));
    switch (reducer) {
        case 'firstNotNull':
            return numbers[0];
        case 'min':
            return min;
        case 'max':
            return max;
        case 'sum':
            return numbers.reduce((total, v) => total + v, 0);
        case 'mean':
            return numbers.reduce((total, v) => total + v, 0) / numbers.length;
        case 'range':
            return max - min;
        case 'lastNotNull':
        default:
            return numbers[numbers.length - 1];
    }
};
