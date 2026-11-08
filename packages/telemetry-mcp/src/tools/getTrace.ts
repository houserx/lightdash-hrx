/**
 * `get_trace` (CONTRACTS §7): every span of one trace through `trace(trace_id[, source])` (§1.1). The trace id is a
 * bind parameter and is checked to be 16-32 hex characters before any engine connection. Results are one row per span:
 * `trace_id, span_id, parent_span_id, service, name, start, duration_ms, status, attributes`; the root span has a null
 * `parent_span_id`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { EngineClient } from '../engine/client.js';
import {
    ToolInputError,
    failureResult,
    placeholders,
    sourceParams,
    successResult,
    tableResult,
} from './telemetryArgs.js';

export const GET_TRACE_TOOL = 'get_trace';

/** A W3C/OpenTelemetry trace id (32 hex) or a legacy 64-bit one (16 hex), as Tempo accepts. */
export const TRACE_ID_PATTERN = /^[0-9a-fA-F]{16,32}$/;

export interface GetTraceArgs {
    trace_id: string;
    source?: string;
}

/** The engine statement and its bind parameters, or a `ToolInputError` for arguments that must not be sent. */
export function buildTraceQuery(
    config: Pick<Config, 'sources'>,
    args: GetTraceArgs,
): { sql: string; params: string[] } {
    if (typeof args.trace_id !== 'string' || !TRACE_ID_PATTERN.test(args.trace_id)) {
        throw new ToolInputError('trace_id must be 16 to 32 hex characters, such as a trace_id from search_traces');
    }
    const params = [args.trace_id, ...sourceParams(config, 'tempo', args.source)];
    return { sql: `SELECT * FROM trace(${placeholders(params.length)})`, params };
}

export function registerGetTrace(server: McpServer, config: Config, engine: EngineClient): void {
    server.registerTool(
        GET_TRACE_TOOL,
        {
            title: 'Get trace',
            description:
                'Returns every span of one trace from a Tempo Telemetry Source. Returns one row per span with ' +
                'trace_id, span_id, parent_span_id (null for the root span), service, name, start, duration_ms, ' +
                'status and attributes, plus rowCount and truncated (true when the result was cut at the server row ' +
                'or size cap). Find trace ids with search_traces.',
            inputSchema: {
                trace_id: z
                    .string()
                    .describe('The trace id: 16 to 32 hex characters, for example 4bf92f3577b34da6a3ce929d0e0e4736.'),
                source: z
                    .string()
                    .optional()
                    .describe('Name of a tempo Telemetry Source from list_sources. Defaults to the default tempo source.'),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (args) => {
            try {
                const { sql, params } = buildTraceQuery(config, args);
                const result = await engine.query(sql, params, { maxRows: config.maxRows });
                return successResult(tableResult(result), config.maxOutputBytes);
            } catch (err) {
                return failureResult(err, 'The trace lookup');
            }
        },
    );
}
