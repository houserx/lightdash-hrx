/**
 * Investigate: turns a telemetry query (PromQL, LogQL, ...) into the engine's table-function SQL
 * (CONTRACTS §1.1). Time arguments are always the reserved Lightdash parameters (CONTRACTS
 * §2), so the generated SQL follows the chosen time range and stays editable as plain SQL.
 */

/** A PromQL range query: `promql(query, start, end, step[, source])`. */
export type PromqlTelemetryQuery = {
    kind: 'promql';
    query: string;
    /** Engine source name; omitted means the engine's default source for the kind. */
    source?: string;
};

export type LogqlDirection = 'forward' | 'backward';

/** Engine default line limit for a LogQL log query (CONTRACTS §1.1). */
export const LOGQL_DEFAULT_LIMIT = 1000;
/** Engine default direction for a LogQL log query: newest lines first. */
export const LOGQL_DEFAULT_DIRECTION: LogqlDirection = 'backward';

/**
 * A LogQL log query: `logql(query, start, end, limit, direction[, source])`. Limit and
 * direction are always written out, so the defaults are visible and editable in the SQL.
 */
export type LogqlTelemetryQuery = {
    kind: 'logql';
    query: string;
    /** Maximum lines returned; defaults to 1000. */
    limit?: number;
    /** Defaults to 'backward' (newest first). */
    direction?: LogqlDirection;
    source?: string;
};

/** A LogQL metric query: `logql_metric(query, start, end, step[, source])`. */
export type LogqlMetricTelemetryQuery = {
    kind: 'logql_metric';
    query: string;
    source?: string;
};

export type TelemetryQuery =
    | PromqlTelemetryQuery
    | LogqlTelemetryQuery
    | LogqlMetricTelemetryQuery;

/** Reserved time parameter references, substituted before the query runs. */
export const TELEMETRY_SQL_FROM = '${ld.parameters.__from}';
export const TELEMETRY_SQL_TO = '${ld.parameters.__to}';
export const TELEMETRY_SQL_INTERVAL = '${ld.parameters.__interval}';

/** A SQL string literal, with single quotes doubled. */
const toSqlStringLiteral = (value: string): string =>
    `'${value.replace(/'/g, "''")}'`;

const tableFunctionSql = (
    name: string,
    args: string[],
    source: string | undefined,
): string => {
    const allArgs =
        source === undefined || source === ''
            ? args
            : [...args, toSqlStringLiteral(source)];
    return `SELECT * FROM ${name}(${allArgs.join(', ')})`;
};

export const buildTelemetrySql = (telemetryQuery: TelemetryQuery): string => {
    switch (telemetryQuery.kind) {
        case 'promql':
            return tableFunctionSql(
                'promql',
                [
                    toSqlStringLiteral(telemetryQuery.query),
                    TELEMETRY_SQL_FROM,
                    TELEMETRY_SQL_TO,
                    TELEMETRY_SQL_INTERVAL,
                ],
                telemetryQuery.source,
            );
        case 'logql': {
            const limit = telemetryQuery.limit ?? LOGQL_DEFAULT_LIMIT;
            if (!Number.isInteger(limit) || limit <= 0) {
                throw new Error(
                    `LogQL limit must be a positive integer, got ${limit}`,
                );
            }
            const direction =
                telemetryQuery.direction ?? LOGQL_DEFAULT_DIRECTION;
            if (direction !== 'forward' && direction !== 'backward') {
                throw new Error(
                    `LogQL direction must be 'forward' or 'backward', got ${direction}`,
                );
            }
            return tableFunctionSql(
                'logql',
                [
                    toSqlStringLiteral(telemetryQuery.query),
                    TELEMETRY_SQL_FROM,
                    TELEMETRY_SQL_TO,
                    String(limit),
                    toSqlStringLiteral(direction),
                ],
                telemetryQuery.source,
            );
        }
        case 'logql_metric':
            return tableFunctionSql(
                'logql_metric',
                [
                    toSqlStringLiteral(telemetryQuery.query),
                    TELEMETRY_SQL_FROM,
                    TELEMETRY_SQL_TO,
                    TELEMETRY_SQL_INTERVAL,
                ],
                telemetryQuery.source,
            );
        default: {
            const unknownKind: never = telemetryQuery;
            throw new Error(
                `Unsupported telemetry query kind: ${(unknownKind as TelemetryQuery).kind}`,
            );
        }
    }
};
