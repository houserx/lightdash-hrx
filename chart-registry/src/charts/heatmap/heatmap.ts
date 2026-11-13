export type HeatmapCell = {
    time: string;
    bucket: string;
    value: number;
};

export type HeatmapModel = {
    /** Distinct times, oldest first. */
    times: string[];
    /** Distinct buckets, lowest bound first, `+Inf` last. */
    buckets: string[];
    /** One cell per (time, bucket) present in the results. */
    cells: HeatmapCell[];
    min: number;
    max: number;
};

/**
 * Numeric value of a bucket label (a Prometheus `le` bound such as `0.5` or
 * `+Inf`), or null when the label is not a number.
 */
export const bucketBound = (bucket: string): number | null => {
    const label = bucket.trim();
    if (/^\+?inf(inity)?$/i.test(label)) return Infinity;
    if (/^-inf(inity)?$/i.test(label)) return -Infinity;
    if (label === '') return null;
    const parsed = Number(label);
    return Number.isNaN(parsed) ? null : parsed;
};

/** Numeric buckets in numeric order (`+Inf` last), then any others by name. */
export const compareBuckets = (a: string, b: string): number => {
    const x = bucketBound(a);
    const y = bucketBound(b);
    if (x !== null && y !== null) return x === y ? 0 : x < y ? -1 : 1;
    if (x !== null) return -1;
    if (y !== null) return 1;
    return a.localeCompare(b);
};

const timeOf = (time: string): number => {
    const parsed = Date.parse(time);
    return Number.isNaN(parsed) ? NaN : parsed;
};

/** Times in chronological order; unparseable ones after, by name. */
export const compareTimes = (a: string, b: string): number => {
    const x = timeOf(a);
    const y = timeOf(b);
    const xOk = !Number.isNaN(x);
    const yOk = !Number.isNaN(y);
    if (xOk && yOk) return x - y;
    if (xOk) return -1;
    if (yOk) return 1;
    return a.localeCompare(b);
};

/**
 * Builds the time x bucket grid. Rows with no time, bucket or numeric value
 * are skipped; rows repeating a (time, bucket) pair add to the same cell.
 */
export const buildHeatmap = (
    rows: {
        time: string | null;
        bucket: string | null;
        value: number | null;
    }[],
): HeatmapModel => {
    const byKey = new Map<string, HeatmapCell>();
    for (const row of rows) {
        if (row.time === null || row.bucket === null || row.value === null) {
            continue;
        }
        const key = JSON.stringify([row.time, row.bucket]);
        const existing = byKey.get(key);
        if (existing) {
            existing.value += row.value;
        } else {
            byKey.set(key, {
                time: row.time,
                bucket: row.bucket,
                value: row.value,
            });
        }
    }
    const cells = [...byKey.values()];
    const times = [...new Set(cells.map((c) => c.time))].sort(compareTimes);
    const buckets = [...new Set(cells.map((c) => c.bucket))].sort(
        compareBuckets,
    );
    let min = Infinity;
    let max = -Infinity;
    for (const cell of cells) {
        if (cell.value < min) min = cell.value;
        if (cell.value > max) max = cell.value;
    }
    return { times, buckets, cells, min, max };
};

const parseHex = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
];

const toHex = (channels: number[]): string =>
    `#${channels
        .map((c) =>
            Math.round(Math.min(255, Math.max(0, c)))
                .toString(16)
                .padStart(2, '0'),
        )
        .join('')}`.toUpperCase();

/**
 * Colour at `t` (0..1) along evenly spaced `#RRGGBB` stops, interpolated
 * linearly in RGB.
 */
export const interpolateColor = (stops: string[], t: number): string => {
    if (stops.length === 1) return stops[0].toUpperCase();
    const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
    const position = clamped * (stops.length - 1);
    const index = Math.min(Math.floor(position), stops.length - 2);
    const local = position - index;
    const from = parseHex(stops[index]);
    const to = parseHex(stops[index + 1]);
    return toHex(from.map((c, i) => c + (to[i] - c) * local));
};
