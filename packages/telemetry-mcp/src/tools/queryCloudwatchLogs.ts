/**
 * `query_cloudwatch_logs` (CONTRACTS §7): a CloudWatch Logs Insights query over one or more log groups through
 * `cloudwatch_logs(log_groups text, query text, start, end[, source])` (§1.1). The log groups travel comma-joined as
 * one bind parameter and the query as another; neither ever becomes SQL text. Results are `timestamp, message, fields`.
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

export const QUERY_CLOUDWATCH_LOGS_TOOL = 'query_cloudwatch_logs';

export interface QueryCloudwatchLogsArgs {
    log_groups: string[];
    query: string;
    start: string;
    end: string;
    source?: string;
}

/**
 * The engine takes the log groups as one comma-separated string, so a group that is empty or contains a comma could
 * not be told apart from its neighbours and is refused rather than split or merged.
 */
export function joinLogGroups(logGroups: unknown): string {
    if (!Array.isArray(logGroups) || logGroups.length === 0) {
        throw new ToolInputError('log_groups must list at least one log group, such as /aws/lambda/orders-worker');
    }
    for (const group of logGroups) {
        if (typeof group !== 'string' || group.trim() === '') {
            throw new ToolInputError('every entry in log_groups must be a non-empty log group name');
        }
        if (group.includes(',')) {
            throw new ToolInputError(
                'a log group name cannot contain a comma; give each log group as its own entry in log_groups',
            );
        }
    }
    return logGroups.join(',');
}

/** The engine statement and its bind parameters, or a `ToolInputError` for arguments that must not be sent. */
export function buildCloudwatchLogsQuery(
    config: Pick<Config, 'sources'>,
    args: QueryCloudwatchLogsArgs,
    now: number,
): { sql: string; params: string[] } {
    const logGroups = joinLogGroups(args.log_groups);
    if (typeof args.query !== 'string' || args.query.trim() === '') {
        throw new ToolInputError('query must be a non-empty Logs Insights query');
    }
    const { start, end } = parseRange(args.start, args.end, now);
    const source = sourceParams(config, 'cloudwatch_logs', args.source);
    const params = [logGroups, args.query, start, end, ...source];
    return { sql: `SELECT * FROM cloudwatch_logs(${placeholders(params.length)})`, params };
}

export function registerQueryCloudwatchLogs(
    server: McpServer,
    config: Config,
    engine: EngineClient,
    now: () => number,
): void {
    server.registerTool(
        QUERY_CLOUDWATCH_LOGS_TOOL,
        {
            title: 'Query CloudWatch Logs (Logs Insights)',
            description:
                'Runs a CloudWatch Logs Insights query over one or more log groups of a CloudWatch Logs Telemetry ' +
                'Source between start and end, for example fields @timestamp, @message | filter @message like ' +
                '/timeout/ | limit 20. Returns one row per result with timestamp, message and fields (a JSON map of ' +
                'the other result fields, such as @logStream), plus rowCount and truncated (true when the result was ' +
                'cut at the server row or size cap; narrow the range or add a limit to the query to see the rest).',
            inputSchema: {
                log_groups: z
                    .array(z.string())
                    .min(1)
                    .describe('The log groups to search, one name per entry, such as ["/aws/lambda/orders-worker"]. ' +
                            'Names cannot contain commas.',),
                query: z
                    .string()
                    .describe('The Logs Insights query, for example fields @timestamp, @message | sort @timestamp desc | limit 50.'),
                start: z
                    .string()
                    .describe('Start of the range: an ISO-8601 time such as 2026-11-08T10:00:00Z, or now or ' +
                            'now-<duration> such as now-1h, resolved against the server clock.',),
                end: z
                    .string()
                    .describe('End of the range, not before start: an ISO-8601 time, now, or now-<duration> such as now-30m.'),
                source: z
                    .string()
                    .optional()
                    .describe('Name of a cloudwatch_logs Telemetry Source from list_sources. Defaults to the default ' +
                            'cloudwatch_logs source.',),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            try {
                const { sql, params } = buildCloudwatchLogsQuery(config, args, now());
                const result = await engine.query(sql, params, { maxRows: config.maxRows });
                return successResult(tableResult(result), config.maxOutputBytes);
            } catch (err) {
                return failureResult(err, 'The CloudWatch Logs query');
            }
        },
    );
}
