// Turns log-shaped telemetry rows into log list entries for Investigate
// (CONTRACTS §1.1): logql gives `timestamp, line, labels, stream` and
// cloudwatch_logs gives `timestamp, message, fields`.

import { findColumn, toEpochMs, type InvestigateRow } from './timeSeries';

export type LogEntry = {
    /** ISO 8601 in UTC, or the raw value when it is not a readable time. */
    timestamp: string;
    message: string;
    /** The logql stream, logql labels or cloudwatch_logs fields, as text. */
    context: string;
};

const toText = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

const formatTimestamp = (value: unknown): string => {
    const time = toEpochMs(value);
    if (time === undefined) return toText(value);
    const date = new Date(time);
    return Number.isNaN(date.getTime()) ? toText(value) : date.toISOString();
};

/**
 * One entry per row, in the order the query returned them (the engine's sort
 * order is the user's choice). Columns match case-insensitively.
 */
export const toLogEntries = (
    columns: string[],
    rows: InvestigateRow[],
): LogEntry[] => {
    const timestampColumn = findColumn(columns, 'timestamp');
    const messageColumn =
        findColumn(columns, 'line') ?? findColumn(columns, 'message');
    const contextColumn =
        findColumn(columns, 'stream') ??
        findColumn(columns, 'labels') ??
        findColumn(columns, 'fields');
    return rows.map((row) => ({
        timestamp: timestampColumn ? formatTimestamp(row[timestampColumn]) : '',
        message: messageColumn ? toText(row[messageColumn]) : '',
        context: contextColumn ? toText(row[contextColumn]) : '',
    }));
};
