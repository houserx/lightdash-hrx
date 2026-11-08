/**
 * Investigate: turns a telemetry query (PromQL, ...) into the engine's table-function SQL
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

export type TelemetryQuery = PromqlTelemetryQuery;

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
        default: {
            const unknownKind: never = telemetryQuery.kind;
            throw new Error(`Unsupported telemetry query kind: ${unknownKind}`);
        }
    }
};
