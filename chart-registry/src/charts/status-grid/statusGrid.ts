/**
 * The status-grid model: one cell per series holding the series' latest
 * value, for health overview boards (Grafana's stat panel repeated over
 * series, or a status history reduced to its last column).
 */

export type StatusPoint = {
    /** Epoch milliseconds, or null when the row has no usable time. */
    time: number | null;
    series: string | null;
    /** The raw value (kept raw so string value mappings still apply). */
    value: unknown;
};

export type StatusCell = {
    series: string;
    /** The latest non-empty raw value, or null when the series has none. */
    value: unknown;
};

const isMissing = (value: unknown): boolean =>
    value === null || value === undefined || String(value).trim() === '';

/**
 * Builds one cell per series, in the order the series first appear. A
 * series' value is its latest non-empty value (Grafana's "Last *"): the one
 * with the greatest time, or the last one in row order among rows without
 * a time or at the same time. Rows with a time come after rows without
 * one. Rows without a series are skipped; a series whose values are all
 * empty still gets a cell, with a null value.
 */
export const buildStatusGrid = (
    points: readonly StatusPoint[],
): StatusCell[] => {
    const latest = new Map<string, { time: number; value: unknown } | null>();
    for (const point of points) {
        if (point.series === null) continue;
        const current = latest.get(point.series);
        if (current === undefined) latest.set(point.series, null);
        if (isMissing(point.value)) continue;
        const time = point.time ?? Number.NEGATIVE_INFINITY;
        if (!current || time >= current.time) {
            latest.set(point.series, { time, value: point.value });
        }
    }
    return [...latest.entries()].map(([series, found]) => ({
        series,
        value: found ? found.value : null,
    }));
};

/** The `columns` option: a whole number from 1 to 24, else `fallback`. */
export const columnsOption = (raw: unknown, fallback: number): number => {
    const value =
        typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && raw.trim() !== ''
              ? Number(raw)
              : NaN;
    if (!Number.isFinite(value) || value < 1) return fallback;
    return Math.min(Math.round(value), 24);
};
