// Alert Rule series split (ENG-1799): turn query result rows into labelled
// time series, one per distinct label set, each with a stable fingerprint.
//
// - SQL results: every column except the value column and the time column(s)
//   is a label, so `time, job_name, value` gives one series per job_name.
// - Telemetry results (`promql`, `logql_metric`, `cloudwatch`, shape
//   `timestamp, value, labels json, series`): the `labels` json column is the
//   label set; `series` is its rendered text and is ignored.

export type AlertSeriesLabels = Record<string, string>;

export type AlertQueryRow = Record<string, unknown>;

export type AlertSeries = {
    labels: AlertSeriesLabels;
    /** 16 lowercase hex chars; independent of label order. */
    fingerprint: string;
    /** Row values in input order; nulls (and non-numeric values) are `null`. */
    values: (number | null)[];
    /** The time column value of each row, or `null` when there is none. */
    timestamps: unknown[];
};

export type SplitAlertSeriesOptions = {
    /** Column holding the value. Default `value`. */
    valueColumn?: string;
    /**
     * Columns that are time, not labels. Default: `time` and `timestamp`,
     * plus any column holding a `Date`.
     */
    timeColumns?: readonly string[];
    /** Json column holding the label map for telemetry results. Default `labels`. */
    labelsColumn?: string;
};

const DEFAULT_VALUE_COLUMN = 'value';
const DEFAULT_TIME_COLUMNS = ['time', 'timestamp'] as const;
const DEFAULT_LABELS_COLUMN = 'labels';

const FNV64_OFFSET = BigInt('0xcbf29ce484222325');
const FNV64_PRIME = BigInt('0x100000001b3');
const MASK64 = BigInt('0xffffffffffffffff');
// Prometheus' label separator byte, so `{a="bc"}` and `{ab="c"}` differ.
const SEPARATOR = 0xff;

/**
 * Fingerprint of a label set: 64-bit FNV-1a over the sorted
 * `name 0xff value 0xff` UTF-8 bytes (the Prometheus model fingerprint),
 * as 16 lowercase hex chars. Label order does not matter.
 */
export const alertLabelsFingerprint = (labels: AlertSeriesLabels): string => {
    const encoder = new TextEncoder();
    let hash = FNV64_OFFSET;
    const add = (byte: number) => {
        // eslint-disable-next-line no-bitwise
        hash = ((hash ^ BigInt(byte)) * FNV64_PRIME) & MASK64;
    };
    Object.keys(labels)
        .sort()
        .forEach((name) => {
            encoder.encode(name).forEach(add);
            add(SEPARATOR);
            encoder.encode(labels[name]).forEach(add);
            add(SEPARATOR);
        });
    return hash.toString(16).padStart(16, '0');
};

const labelValue = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

/** Labels with null values are dropped, as Prometheus drops empty labels. */
const toLabels = (entries: [string, unknown][]): AlertSeriesLabels =>
    entries.reduce<AlertSeriesLabels>((acc, [name, value]) => {
        const text = labelValue(value);
        return text === null ? acc : { ...acc, [name]: text };
    }, {});

const parseLabelsColumn = (value: unknown): AlertSeriesLabels => {
    if (value === null || value === undefined || value === '') return {};
    const parsed: unknown =
        typeof value === 'string' ? JSON.parse(value) : value;
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new Error(
            `Alert series labels must be a json object, got ${typeof parsed}`,
        );
    }
    return toLabels(Object.entries(parsed));
};

const toValue = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isNaN(num) ? null : num;
};

/**
 * Split query rows into series. Rows keep their input order within a series;
 * series are returned in order of first appearance. No rows gives `[]`.
 */
export const splitAlertSeries = (
    rows: readonly AlertQueryRow[],
    options: SplitAlertSeriesOptions = {},
): AlertSeries[] => {
    const valueColumn = options.valueColumn ?? DEFAULT_VALUE_COLUMN;
    const labelsColumn = options.labelsColumn ?? DEFAULT_LABELS_COLUMN;
    const timeColumns: readonly string[] =
        options.timeColumns ?? DEFAULT_TIME_COLUMNS;
    const isTelemetry = rows.some((row) => labelsColumn in row);

    const isTimeColumn = (column: string, value: unknown) =>
        timeColumns.includes(column) || value instanceof Date;

    const bySeries = new Map<string, AlertSeries>();
    rows.forEach((row) => {
        const entries = Object.entries(row);
        const timeEntry = entries.find(([column, value]) =>
            isTimeColumn(column, value),
        );
        const labels = isTelemetry
            ? parseLabelsColumn(row[labelsColumn])
            : toLabels(
                  entries.filter(
                      ([column, value]) =>
                          column !== valueColumn &&
                          !isTimeColumn(column, value),
                  ),
              );
        const fingerprint = alertLabelsFingerprint(labels);
        let series = bySeries.get(fingerprint);
        if (!series) {
            series = { labels, fingerprint, values: [], timestamps: [] };
            bySeries.set(fingerprint, series);
        }
        series.values.push(toValue(row[valueColumn]));
        series.timestamps.push(timeEntry ? timeEntry[1] : null);
    });
    return [...bySeries.values()];
};
