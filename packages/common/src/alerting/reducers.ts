// Alert Rule reducers (ENG-1799): collapse one series to a single value.
// Nulls (and undefined) are ignored, as Grafana's "drop non-numeric" mode does.

export const ALERT_REDUCERS = [
    'last',
    'mean',
    'max',
    'min',
    'sum',
    'count',
] as const;

export type AlertReducer = (typeof ALERT_REDUCERS)[number];

export type AlertSeriesValue = number | null | undefined;

export const isAlertReducer = (value: unknown): value is AlertReducer =>
    typeof value === 'string' &&
    (ALERT_REDUCERS as readonly string[]).includes(value);

/**
 * Reduce a series to one value, ignoring nulls.
 * An empty series (or one with only nulls) gives `null`, except `count`,
 * which gives `0`.
 */
export const reduceAlertSeries = (
    series: readonly AlertSeriesValue[],
    reducer: AlertReducer,
): number | null => {
    const values = series.filter(
        (value): value is number => value !== null && value !== undefined,
    );
    if (reducer === 'count') return values.length;
    if (values.length === 0) return null;
    switch (reducer) {
        case 'last':
            return values[values.length - 1];
        case 'sum':
            return values.reduce((total, value) => total + value, 0);
        case 'mean':
            return (
                values.reduce((total, value) => total + value, 0) /
                values.length
            );
        case 'max':
            return values.reduce((a, b) => (b > a ? b : a));
        case 'min':
            return values.reduce((a, b) => (b < a ? b : a));
        default: {
            const unknownReducer: never = reducer;
            throw new Error(`Unknown alert reducer: ${String(unknownReducer)}`);
        }
    }
};
