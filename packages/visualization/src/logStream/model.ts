import {
    getLogLevelColor,
    LOG_LEVELS,
    normalizeLogLevel,
    type LogLevel,
    type ResultRow,
} from '@lightdash/common';
import { type ResolvedLogStreamChartConfig } from './config';

/** One log line, ready to draw. */
export type LogStreamLine = {
    /** Unique within the model: the line's row index in the data. */
    id: string;
    /** The log text. Empty when the row has none. */
    line: string;
    /** Milliseconds since the epoch, or null when the row has no valid time. */
    timestamp: number | null;
    /** The timestamp as the data formatted it. */
    formattedTimestamp: string;
    level: LogLevel;
    /** The level's colour: the chart's override, else Grafana's default. */
    color: string;
    /** The line's labels, every value as text. */
    labels: Record<string, string>;
};

/** What a log stream draws: its lines and display options. */
export type LogStreamModel = {
    /**
     * Sorted by time: newest first when `newestFirst`, else oldest first.
     * Lines with the same time keep the data's order; lines with no time
     * come last, in the data's order.
     */
    lines: LogStreamLine[];
    wrapLines: boolean;
    newestFirst: boolean;
    showLabels: boolean;
    /** Every level's colour, overrides applied. */
    levelColors: Record<LogLevel, string>;
};

/** Labels that carry a line's level when there is no level column, in order. */
const LEVEL_LABEL_KEYS = ['level', 'detected_level'];

const rawOf = (row: ResultRow, fieldId: string | undefined): unknown =>
    fieldId === undefined ? undefined : row[fieldId]?.value?.raw;

const formattedOf = (row: ResultRow, fieldId: string | undefined): string =>
    fieldId === undefined ? '' : (row[fieldId]?.value?.formatted ?? '');

const toText = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

const toTimestamp = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const time =
        value instanceof Date
            ? value.getTime()
            : typeof value === 'number'
              ? value
              : new Date(String(value)).getTime();
    return Number.isFinite(time) ? time : null;
};

/** Labels from an object or its JSON text; anything else has none. */
export const parseLogLabels = (value: unknown): Record<string, string> => {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            return {};
        }
    }
    if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
    ) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(parsed).map(([key, v]) => [key, toText(v)]),
    );
};

const isBlank = (value: unknown) =>
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '');

const levelOf = (raw: unknown, labels: Record<string, string>): LogLevel => {
    if (!isBlank(raw)) return normalizeLogLevel(raw);
    const key = LEVEL_LABEL_KEYS.find((k) => !isBlank(labels[k]));
    return key === undefined ? 'unknown' : normalizeLogLevel(labels[key]);
};

/**
 * Orders lines by time (newest or oldest first), lines with no time last.
 * The sort is stable, so equal times keep the data's order.
 */
export const sortLogStreamLines = (
    lines: LogStreamLine[],
    newestFirst: boolean,
): LogStreamLine[] =>
    [...lines].sort((a, b) => {
        if (a.timestamp === b.timestamp) return 0;
        if (a.timestamp === null) return 1;
        if (b.timestamp === null) return -1;
        return newestFirst
            ? b.timestamp - a.timestamp
            : a.timestamp - b.timestamp;
    });

/** Turns logs-shaped rows into the lines a log stream draws. */
export const buildLogStreamModel = ({
    rows,
    config,
}: {
    rows: ResultRow[];
    config: ResolvedLogStreamChartConfig;
}): LogStreamModel => {
    const levelColors = Object.fromEntries(
        LOG_LEVELS.map((level) => [
            level,
            getLogLevelColor(level, config.levelColors),
        ]),
    ) as Record<LogLevel, string>;
    const lines = rows.map((row, index): LogStreamLine => {
        const labels = parseLogLabels(rawOf(row, config.labelsFieldId));
        const level = levelOf(rawOf(row, config.levelFieldId), labels);
        return {
            id: String(index),
            line: toText(rawOf(row, config.lineFieldId)),
            timestamp: toTimestamp(rawOf(row, config.timestampFieldId)),
            formattedTimestamp: formattedOf(row, config.timestampFieldId),
            level,
            color: levelColors[level],
            labels,
        };
    });
    return {
        lines: sortLogStreamLines(lines, config.newestFirst),
        wrapLines: config.wrapLines,
        newestFirst: config.newestFirst,
        showLabels: config.showLabels,
        levelColors,
    };
};
