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

export const GRAPH_MODES = ['area', 'none'] as const;

export type GraphMode = (typeof GRAPH_MODES)[number];

/** The `graphMode` option; anything unknown is Grafana's default, area. */
export const graphModeOption = (raw: unknown): GraphMode =>
    GRAPH_MODES.find((mode) => mode === raw) ?? 'area';

export type Sparkline = {
    /** How many points the line goes through. */
    points: number;
    /** SVG path of the line through every point, left to right in time. */
    line: string;
    /** The line closed down to the bottom edge, for the area fill. */
    area: string;
};

const coord = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * The sparkline of the series in a `width` x `height` box: one point per
 * row with both a time and a value, in time order (`points` must already be
 * ordered, see `orderPoints`). x spans the first to the last time, y the
 * series' min (bottom) to max (top); a flat series runs through the middle.
 * Null values are skipped, so the line joins its neighbours, as Grafana's
 * sparkline does. Null when fewer than two points have a time and a value:
 * there is no line to draw.
 */
export const sparkline = (
    points: readonly StatPoint[],
    width: number,
    height: number,
): Sparkline | null => {
    const drawn = points.filter(
        (p): p is { time: number; value: number } =>
            p.time !== null && p.value !== null,
    );
    if (drawn.length < 2) return null;
    const first = drawn[0].time;
    const last = drawn[drawn.length - 1].time;
    let min = Infinity;
    let max = -Infinity;
    for (const p of drawn) {
        if (p.value < min) min = p.value;
        if (p.value > max) max = p.value;
    }
    // Every point at one instant: spread them evenly in row order instead.
    const x = (p: { time: number }, i: number): number =>
        last > first
            ? ((p.time - first) / (last - first)) * width
            : (i / (drawn.length - 1)) * width;
    const y = (value: number): number =>
        max > min
            ? height - ((value - min) / (max - min)) * height
            : height / 2;
    const xy = drawn.map((p, i) => `${coord(x(p, i))},${coord(y(p.value))}`);
    const line = `M${xy.join('L')}`;
    const area =
        `${line}L${coord(x(drawn[drawn.length - 1], drawn.length - 1))},${coord(height)}` +
        `L${coord(x(drawn[0], 0))},${coord(height)}Z`;
    return { points: drawn.length, line, area };
};
