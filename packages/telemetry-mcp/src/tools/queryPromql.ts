/**
 * `query_promql` (CONTRACTS §7): a PromQL range query through `promql(query, start, end, step[, source])`, or an
 * instant query through `promql_instant(query, at[, source])` (§1.1). Every argument is a bind parameter. The result
 * is the Time series long shape: `timestamp, value, labels, series`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { EngineClient } from '../engine/client.js';
import {
    ToolInputError,
    failureResult,
    isoParam,
    parseDuration,
    parseInstant,
    parseRange,
    placeholders,
    sourceParams,
    successResult,
    tableResult,
} from './telemetryArgs.js';

export const QUERY_PROMQL_TOOL = 'query_promql';

export interface QueryPromqlArgs {
    query: string;
    start?: string;
    end?: string;
    step?: string;
    at?: string;
    source?: string;
}

/** The engine statement and its bind parameters, or a `ToolInputError` for arguments that must not be sent. */
export function buildPromqlQuery(
    config: Pick<Config, 'sources'>,
    args: QueryPromqlArgs,
    now: number,
): { sql: string; params: string[] } {
    if (args.query.trim() === '') throw new ToolInputError('query must be a non-empty PromQL expression');
    const source = sourceParams(config, 'prometheus', args.source);
    const range = [args.start, args.end, args.step];
    if (args.at !== undefined) {
        if (range.some((v) => v !== undefined)) {
            throw new ToolInputError('give either at (an instant query) or start, end and step (a range query), not both');
        }
        const params = [args.query, isoParam(parseInstant('at', args.at, now)), ...source];
        return { sql: `SELECT * FROM promql_instant(${placeholders(params.length)})`, params };
    }
    if (args.start === undefined || args.end === undefined || args.step === undefined) {
        throw new ToolInputError('a range query needs start, end and step; an instant query needs at');
    }
    const { start, end } = parseRange(args.start, args.end, now);
    const params = [args.query, start, end, parseDuration('step', args.step), ...source];
    return { sql: `SELECT * FROM promql(${placeholders(params.length)})`, params };
}

export function registerQueryPromql(
    server: McpServer,
    config: Config,
    engine: EngineClient,
    now: () => number,
): void {
    server.registerTool(
        QUERY_PROMQL_TOOL,
        {
            title: 'Query Prometheus (PromQL)',
            description:
                'Runs a PromQL query against a Prometheus Telemetry Source. For a range query give start, end and ' +
                'step; for an instant query give at instead. Returns the Time series long shape: one row per ' +
                'sample with timestamp, value, labels (a JSON label map) and series (the canonical series name), ' +
                'plus rowCount and truncated (true when the result was cut at the server row cap; narrow the range or ' +
                'coarsen the step to see the rest).',
            inputSchema: {
                query: z.string().describe('The PromQL expression, for example sum by (job) (rate(http_requests_total[5m])).'),
                start: z
                    .string()
                    .optional()
                    .describe('Range query start: an ISO-8601 time such as 2026-11-08T10:00:00Z, or now or now-<duration> such as ' +
                            'now-1h, resolved against the server clock. Needs end and step.',),
                end: z
                    .string()
                    .optional()
                    .describe('Range query end, not before start: an ISO-8601 time, now, or now-<duration> such as now-30m. ' +
                            'Needs start and step.',),
                step: z
                    .string()
                    .optional()
                    .describe('Range query resolution, a Prometheus duration such as 30s, 1m or 1h.'),
                at: z
                    .string()
                    .optional()
                    .describe('Instant query time: an ISO-8601 time, now, or now-<duration>. Use instead of start, end and step.'),
                source: z
                    .string()
                    .optional()
                    .describe(
                        'Name of a prometheus Telemetry Source from list_sources. Defaults to the default prometheus source.',
                    ),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            try {
                const { sql, params } = buildPromqlQuery(config, args, now());
                return successResult(tableResult(await engine.query(sql, params, { maxRows: config.maxRows })));
            } catch (err) {
                return failureResult(err, 'The PromQL query');
            }
        },
    );
}
