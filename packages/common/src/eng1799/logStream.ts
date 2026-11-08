/**
 * Log stream chart (ENG-1799): a native chart type that shows log lines from
 * a Telemetry Source, one row per line.
 */

/** Normalised log levels, as Grafana's logs panel groups them. */
export type LogLevel =
    | 'critical'
    | 'error'
    | 'warning'
    | 'info'
    | 'debug'
    | 'trace'
    | 'unknown';

/** Every log level, most severe first. */
export const LOG_LEVELS: readonly LogLevel[] = [
    'critical',
    'error',
    'warning',
    'info',
    'debug',
    'trace',
    'unknown',
];

/** Grafana's default colour for each log level. */
export const DEFAULT_LOG_LEVEL_COLORS: Readonly<Record<LogLevel, string>> = {
    critical: '#705da0',
    error: '#e24d42',
    warning: '#eab839',
    info: '#7eb26d',
    debug: '#1f78c1',
    trace: '#6ed0e0',
    unknown: '#8e8e8e',
};

/**
 * Raw level names and the level each one means, as in Grafana's `LogLevel`
 * enum. Keys are lower case.
 */
const LOG_LEVEL_ALIASES: Readonly<Record<string, LogLevel>> = {
    emerg: 'critical',
    fatal: 'critical',
    alert: 'critical',
    crit: 'critical',
    critical: 'critical',
    warn: 'warning',
    warning: 'warning',
    err: 'error',
    eror: 'error',
    error: 'error',
    info: 'info',
    information: 'info',
    informational: 'info',
    notice: 'info',
    dbug: 'debug',
    debug: 'debug',
    trace: 'trace',
    unknown: 'unknown',
};

/**
 * Normalises a raw log level the way Grafana's logs panel does: case and
 * surrounding whitespace are ignored, and anything it doesn't recognise
 * (including a missing or non-string value) is `unknown`.
 */
export const normalizeLogLevel = (raw: unknown): LogLevel => {
    if (typeof raw !== 'string') return 'unknown';
    const key = raw.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(LOG_LEVEL_ALIASES, key)
        ? LOG_LEVEL_ALIASES[key]
        : 'unknown';
};

/** The colour of a log level: the chart's override if set, else Grafana's default. */
export const getLogLevelColor = (
    level: LogLevel,
    overrides?: Partial<Record<LogLevel, string>>,
): string => overrides?.[level] || DEFAULT_LOG_LEVEL_COLORS[level];

export type LogStreamChart = {
    /** Field id of the log line column */
    lineFieldId?: string;
    /** Field id of the timestamp column */
    timestampFieldId?: string;
    /** Field id of the level column. Without one, the level comes from the labels */
    levelFieldId?: string;
    /** Field id of the labels column (a JSON object of string values) */
    labelsFieldId?: string;
    /** Wrap long lines instead of truncating them. Defaults to false */
    wrapLines?: boolean;
    /** Show the newest line first. Defaults to true */
    newestFirst?: boolean;
    /** Show each line's labels. Defaults to false */
    showLabels?: boolean;
    /** Colour overrides per log level, as CSS colours */
    levelColors?: Partial<Record<LogLevel, string>>;
};
