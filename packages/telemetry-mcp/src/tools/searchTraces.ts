/**
 * `search_traces` (CONTRACTS §7): a TraceQL search through `traceql(query, start, end[, limit int = 20, source])`
 * (§1.1). Every argument is a bind parameter; the query never becomes SQL text. Results are one summary row per trace:
 * `trace_id, root_service, root_name, start, duration_ms, span_count`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { EngineClient } from '../engine/client.js';
import {
    ToolInputError,
    failureResult,
    parseRange,
    placeholders,
    sourceParams,
    successResult,
    tableResult,
} from './telemetryArgs.js';

export const SEARCH_TRACES_TOOL = 'search_traces';

/** The engine's default for `traceql`'s optional `limit` (CONTRACTS §1.1). */
export const TRACEQL_DEFAULT_LIMIT = 20;
/** The most traces one search may ask for. Each summary row is cheap, but a search is not a bulk export. */
export const TRACEQL_MAX_LIMIT = 1000;

export interface SearchTracesArgs {
    query: string;
    start: string;
    end: string;
    limit?: number;
    source?: string;
}

/** The engine statement and its bind parameters, or a `ToolInputError` for arguments that must not be sent. */
export function buildTraceqlQuery(
    config: Pick<Config, 'sources'>,
    args: SearchTracesArgs,
    now: number,
): { sql: string; params: string[] } {
    if (typeof args.query !== 'string' || args.query.trim() === '') {
        throw new ToolInputError('query must be a non-empty TraceQL expression');
    }
    if (
        args.limit !== undefined &&
        (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > TRACEQL_MAX_LIMIT)
    ) {
        throw new ToolInputError(`limit must be a whole number from 1 to ${TRACEQL_MAX_LIMIT}`);
    }
    const { start, end } = parseRange(args.start, args.end, now);
    const source = sourceParams(config, 'tempo', args.source);

    // `limit` is positional before `source`: a source needs a limit, so the contract default fills the gap. A limit the
    // caller did not give and nothing after it is left to the engine's own default.
    const params = [args.query, start, end];
    if (args.limit !== undefined || source.length > 0) {
        params.push(String(args.limit ?? TRACEQL_DEFAULT_LIMIT), ...source);
    }
    // `limit` ($4) is an int in the engine signature; parameters arrive as text.
    return { sql: `SELECT * FROM traceql(${placeholders(params.length, { 4: 'int' })})`, params };
}

export function registerSearchTraces(
    server: McpServer,
    config: Config,
    engine: EngineClient,
    now: () => number,
): void {
    server.registerTool(
        SEARCH_TRACES_TOOL,
        {
            title: 'Search traces (TraceQL)',
            description:
                'Finds traces in a Tempo Telemetry Source between start and end with a TraceQL query, for example ' +
                '{ resource.service.name = "api" && duration > 1s }. Returns one summary row per trace with trace_id, ' +
                'root_service, root_name, start, duration_ms and span_count, plus rowCount and truncated (true when the ' +
                'result was cut at the server row or size cap). Use get_trace with a trace_id to see its spans.',
            inputSchema: {
                query: z
                    .string()
                    .describe('The TraceQL expression, for example { resource.service.name = "api" && status = error }.'),
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
                    .max(TRACEQL_MAX_LIMIT)
                    .optional()
                    .describe(`The most traces to return, from 1 to ${TRACEQL_MAX_LIMIT}. Defaults to ${TRACEQL_DEFAULT_LIMIT}.`),
                source: z
                    .string()
                    .optional()
                    .describe('Name of a tempo Telemetry Source from list_sources. Defaults to the default tempo source.'),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            try {
                const { sql, params } = buildTraceqlQuery(config, args, now());
                const result = await engine.query(sql, params, { maxRows: config.maxRows });
                return successResult(tableResult(result), config.maxOutputBytes);
            } catch (err) {
                return failureResult(err, 'The TraceQL search');
            }
        },
    );
}
