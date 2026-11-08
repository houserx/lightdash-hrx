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
