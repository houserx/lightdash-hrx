/**
 * `query_cloudwatch` (CONTRACTS §7): one CloudWatch `MetricDataQuery` (a metric stat or a metric-math expression, the
 * shape Grafana's CloudWatch datasource stores) through `cloudwatch(metric_data_query json, start, end[, source])`
 * (§1.1). The query object is sent as one JSON bind parameter, exactly as given; it never becomes SQL text. Results are
 * the Time series long shape `timestamp, value, labels, series`, with the query label as `series`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { EngineClient } from '../engine/client.js';
import {
    ToolInputError,
    failureResult,
    parseRange,
    sourceParams,
    successResult,
    tableResult,
} from './telemetryArgs.js';

export const QUERY_CLOUDWATCH_TOOL = 'query_cloudwatch';

export interface QueryCloudwatchArgs {
    metric_data_query: unknown;
    start: string;
    end: string;
    source?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks the parts of a `MetricDataQuery` the server relies on, as CloudWatch defines them: an object with a non-empty
 * string `Id`, and exactly one of `MetricStat` (an object) or `Expression` (a non-empty string). Everything else in the
 * object is passed through untouched for the engine and CloudWatch to judge.
 */
export function checkMetricDataQuery(value: unknown): Record<string, unknown> {
    if (!isPlainObject(value)) {
        throw new ToolInputError('metric_data_query must be a CloudWatch MetricDataQuery object');
    }
    if (typeof value.Id !== 'string' || value.Id.trim() === '') {
        throw new ToolInputError('metric_data_query needs an Id, a non-empty string such as "m1"');
    }
    const hasStat = value.MetricStat !== undefined;
    const hasExpression = value.Expression !== undefined;
    if (hasStat === hasExpression) {
        throw new ToolInputError('metric_data_query needs exactly one of MetricStat or Expression');
    }
    if (hasStat && !isPlainObject(value.MetricStat)) {
        throw new ToolInputError('metric_data_query.MetricStat must be an object with Metric, Period and Stat');
    }
    if (hasExpression && (typeof value.Expression !== 'string' || value.Expression.trim() === '')) {
        throw new ToolInputError('metric_data_query.Expression must be a non-empty metric math expression');
    }
    return value;
}

/** The engine statement and its bind parameters, or a `ToolInputError` for arguments that must not be sent. */
export function buildCloudwatchQuery(
    config: Pick<Config, 'sources'>,
    args: QueryCloudwatchArgs,
    now: number,
): { sql: string; params: string[] } {
    const query = checkMetricDataQuery(args.metric_data_query);
    const { start, end } = parseRange(args.start, args.end, now);
    const source = sourceParams(config, 'cloudwatch', args.source);
    const params = [JSON.stringify(query), start, end, ...source];
    const sql = `SELECT * FROM cloudwatch($1::json, $2, $3${source.length > 0 ? ', $4' : ''})`;
    return { sql, params };
}

export function registerQueryCloudwatch(
    server: McpServer,
    config: Config,
    engine: EngineClient,
    now: () => number,
): void {
    server.registerTool(
        QUERY_CLOUDWATCH_TOOL,
        {
            title: 'Query CloudWatch metrics',
            description:
                'Runs one CloudWatch MetricDataQuery against a CloudWatch Telemetry Source between start and end. ' +
                'The query is either a metric stat ({"Id": "m1", "MetricStat": {"Metric": {"Namespace": "AWS/SQS", ' +
                '"MetricName": "ApproximateNumberOfMessagesVisible", "Dimensions": [{"Name": "QueueName", "Value": ' +
                '"orders"}]}, "Period": 60, "Stat": "Average"}, "Label": "queue depth"}) or a metric math expression ' +
                '({"Id": "e1", "Expression": "SUM(METRICS())", "Period": 300}). Returns the Time series long shape: ' +
                'timestamp, value, labels and series (the query Label), plus rowCount and truncated (true when the ' +
                'result was cut at the server row or size cap; narrow the range or raise the Period to see the rest).',
            inputSchema: {
                metric_data_query: z
                    .record(z.string(), z.unknown())
                    .describe('A CloudWatch MetricDataQuery object: an Id plus exactly one of MetricStat or ' +
                            'Expression, and optionally Label, Period and ReturnData.',),
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
                    .describe('Name of a cloudwatch Telemetry Source from list_sources. Defaults to the default ' +
                            'cloudwatch source.',),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            try {
                const { sql, params } = buildCloudwatchQuery(config, args, now());
                const result = await engine.query(sql, params, { maxRows: config.maxRows });
                return successResult(tableResult(result), config.maxOutputBytes);
            } catch (err) {
                return failureResult(err, 'The CloudWatch query');
            }
        },
    );
}
