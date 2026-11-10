// Investigate picks a renderer from the columns a query returns. The column
// names are the ones the telemetry table functions return (CONTRACTS §1.1).

export type TelemetryResultShape = 'metric' | 'log' | 'trace' | 'table';

/**
 * Recognise a telemetry result shape from its column names.
 * - `metric`: timestamp, value and labels (promql, promql_instant, logql_metric, cloudwatch)
 * - `log`: timestamp with line or message (logql, cloudwatch_logs)
 * - `trace`: trace_id (traceql, trace)
 * - `table`: anything else
 * Names are matched case-insensitively and column order does not matter.
 */
export const getTelemetryResultShape = (
    columnNames: string[],
): TelemetryResultShape => {
    const columns = new Set(columnNames.map((name) => name.toLowerCase()));
    if (columns.has('timestamp')) {
        if (columns.has('value') && columns.has('labels')) {
            return 'metric';
        }
        if (columns.has('line') || columns.has('message')) {
            return 'log';
        }
    }
    if (columns.has('trace_id')) {
        return 'trace';
    }
    return 'table';
};
