// Groups metric-shaped telemetry rows (timestamp, value, labels[, series]) into
// one line per series for the Investigate time-series chart (CONTRACTS §1.1).

export type InvestigateRow = Record<string, unknown>;

export type TimeSeriesLine = {
    name: string;
    points: [number, number | null][];
};

/** Finds a column by name, ignoring case (warehouses may upper-case identifiers). */
export const findColumn = (
    columns: string[],
    name: string,
): string | undefined =>
    columns.find((column) => column.toLowerCase() === name.toLowerCase());

/** Reads a timestamp given as a Date, epoch ms or a parseable string. */
export const toEpochMs = (value: unknown): number | undefined => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value !== '') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return parsed;
        const numeric = Number(value);
        if (!Number.isNaN(numeric)) return numeric;
    }
    return undefined;
};

const toNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};

const toLabel = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
};

/**
 * One line per distinct series. The series name is the `series` column when the
 * query returns it, otherwise the `labels` value. Points are sorted by time and
 * rows without a usable timestamp are skipped.
 */
export const groupTimeSeries = (
    columns: string[],
    rows: InvestigateRow[],
): TimeSeriesLine[] => {
    const timestampColumn = findColumn(columns, 'timestamp');
    const valueColumn = findColumn(columns, 'value');
    const seriesColumn =
        findColumn(columns, 'series') ?? findColumn(columns, 'labels');
    if (!timestampColumn || !valueColumn) return [];

    const lines = new Map<string, TimeSeriesLine>();
    rows.forEach((row) => {
        const time = toEpochMs(row[timestampColumn]);
        if (time === undefined) return;
        const name = seriesColumn ? toLabel(row[seriesColumn]) : '';
        const line = lines.get(name) ?? { name, points: [] };
        line.points.push([time, toNumber(row[valueColumn])]);
        lines.set(name, line);
    });
    return Array.from(lines.values()).map((line) => ({
        ...line,
        points: [...line.points].sort((a, b) => a[0] - b[0]),
    }));
};
