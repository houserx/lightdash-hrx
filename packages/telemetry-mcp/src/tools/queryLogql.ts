/**
 * `query_logql` (CONTRACTS §7): a LogQL log query through `logql(query, start, end[, limit, direction, source])`, or a
 * LogQL metric query through `logql_metric(query, start, end, step[, source])` when a `step` is given (§1.1). Every
 * argument is a bind parameter. Log queries return `timestamp, line, labels, stream`; metric queries return the Time
 * series long shape `timestamp, value, labels, series`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { EngineClient } from '../engine/client.js';
import {
    ToolInputError,
    failureResult,
    parseDuration,
    parseRange,
    placeholders,
    sourceParams,
    successResult,
    tableResult,
} from './telemetryArgs.js';

export const QUERY_LOGQL_TOOL = 'query_logql';

/** The engine's defaults for `logql`'s optional `limit` and `direction` (CONTRACTS §1.1). */
export const LOGQL_DEFAULT_LIMIT = 1000;
export const LOGQL_DEFAULT_DIRECTION = 'backward';
export const LOGQL_DIRECTIONS = ['forward', 'backward'] as const;
/** `limit` is a Postgres `int` in the engine signature. */
const MAX_INT4 = 2_147_483_647;

export interface QueryLogqlArgs {
    query: string;
    start: string;
    end: string;
    limit?: number;
    direction?: string;
    step?: string;
    source?: string;
}

/** The engine statement and its bind parameters, or a `ToolInputError` for arguments that must not be sent. */
export function buildLogqlQuery(
    config: Pick<Config, 'sources'>,
    args: QueryLogqlArgs,
    now: number,
): { sql: string; params: string[] } {
    if (typeof args.query !== 'string' || args.query.trim() === '') {
        throw new ToolInputError('query must be a non-empty LogQL expression');
    }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_INT4)) {
        throw new ToolInputError(`limit must be a whole number from 1 to ${MAX_INT4}`);
    }
    if (args.direction !== undefined && !(LOGQL_DIRECTIONS as readonly string[]).includes(args.direction)) {
        throw new ToolInputError('direction must be forward (oldest first) or backward (newest first)');
    }
    const step = args.step === undefined ? undefined : parseDuration('step', args.step);
    if (step !== undefined && (args.limit !== undefined || args.direction !== undefined)) {
        throw new ToolInputError(
            'limit and direction apply to log queries only; a metric query (with step) returns every step',
        );
    }
    const { start, end } = parseRange(args.start, args.end, now);
    const source = sourceParams(config, 'loki', args.source);

    if (step !== undefined) {
        const params = [args.query, start, end, step, ...source];
        return { sql: `SELECT * FROM logql_metric(${placeholders(params.length)})`, params };
    }

    // `limit` and `direction` are positional: a later argument needs every earlier one, so the contract defaults fill
    // the gaps. Trailing arguments the caller did not give are left to the engine's own defaults.
    const optional: (string | undefined)[] = [
        args.limit === undefined ? undefined : String(args.limit),
        args.direction,
        source[0],
    ];
    const lastGiven = optional.reduce<number>((last, v, i) => (v === undefined ? last : i), -1);
    const defaults = [String(LOGQL_DEFAULT_LIMIT), LOGQL_DEFAULT_DIRECTION];
    const tail = optional.slice(0, lastGiven + 1).map((v, i) => v ?? defaults[i]);
    const params = [args.query, start, end, ...tail];
    return { sql: `SELECT * FROM logql(${placeholders(params.length)})`, params };
}

export function registerQueryLogql(
    server: McpServer,
    config: Config,
    engine: EngineClient,
    now: () => number,
): void {
    server.registerTool(
        QUERY_LOGQL_TOOL,
        {
            title: 'Query Loki (LogQL)',
            description:
                'Runs a LogQL query against a Loki Telemetry Source between start and end. Without step it is a log ' +
                'query and returns one row per log line with timestamp, line, labels (a JSON label map) and stream ' +
                '(the stream selector); limit and direction control how many lines and from which end. With step it ' +
                'is a metric query (such as sum(count_over_time({app="api"}[5m]))) and returns the Time series long ' +
                'shape: timestamp, value, labels and series. Both include rowCount and truncated (true when the result ' +
                'was cut at the server row cap; narrow the range, lower the limit or coarsen the step to see the rest).',
            inputSchema: {
                query: z
                    .string()
                    .describe('The LogQL expression, for example {app="api"} |= "timeout" | json.'),
                start: z
                    .string()
                    .describe('Start of the range: an ISO-8601 time such as 2026-11-08T10:00:00Z, or now or ' +
                            'now-<duration> such as now-1h, resolved against the server clock.',),
                end: z
                    .string()
                    .describe('End of the range, not before start: an ISO-8601 time, now, or now-<duration> such as now-30m.'),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_INT4)
                    .optional()
                    .describe(`Log queries only: the most log lines to return. Defaults to ${LOGQL_DEFAULT_LIMIT}.`),
                direction: z
                    .enum(LOGQL_DIRECTIONS)
                    .optional()
                    .describe('Log queries only: forward returns the oldest lines first, backward the newest first. ' +
                            `Defaults to ${LOGQL_DEFAULT_DIRECTION}.`,),
                step: z
                    .string()
                    .optional()
                    .describe('Makes this a metric query at this resolution, a duration such as 30s, 1m or 5m. ' +
                            'Leave it out for a log query.',),
                source: z
                    .string()
                    .optional()
                    .describe('Name of a loki Telemetry Source from list_sources. Defaults to the default loki source.'),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            try {
                const { sql, params } = buildLogqlQuery(config, args, now());
                return successResult(tableResult(await engine.query(sql, params, { maxRows: config.maxRows })));
            } catch (err) {
                return failureResult(err, 'The LogQL query');
            }
        },
    );
}
