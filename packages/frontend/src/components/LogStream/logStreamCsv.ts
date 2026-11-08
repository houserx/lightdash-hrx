import { type LogStreamLine } from '@lightdash/visualization';

const CSV_HEADER = ['timestamp', 'level', 'line', 'labels'];

/** RFC 4180: quote a field holding a comma, quote or line break, doubling its quotes. */
const csvField = (value: string): string =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** The ISO time when the line has one, else the data's own formatting. */
const csvTimestamp = (line: LogStreamLine): string =>
    line.timestamp === null
        ? line.formattedTimestamp
        : new Date(line.timestamp).toISOString();

/**
 * The lines as CSV, one row each in the given order: timestamp, level, line
 * text and labels as a JSON object. CRLF row ends, as RFC 4180 asks.
 */
export const logLinesToCsv = (lines: LogStreamLine[]): string =>
    [
        CSV_HEADER,
        ...lines.map((line) => [
            csvTimestamp(line),
            line.level,
            line.line,
            JSON.stringify(line.labels),
        ]),
    ]
        .map((row) => row.map(csvField).join(','))
        .join('\r\n')
        .concat('\r\n');

/**
 * Saves the lines as a CSV file through a temporary download link. The file
 * starts with a byte-order mark so spreadsheet apps read it as UTF-8.
 */
export const downloadLogLinesCsv = (
    lines: LogStreamLine[],
    fileName = 'log-stream.csv',
): void => {
    const blob = new Blob(['﻿', logLinesToCsv(lines)], {
        type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
};
