/**
 * `platform_explain` (CONTRACTS §7): the estimate-only plan of one Platform Database query, as an Audited Query
 * (§1.1, §1.2, §6).
 *
 * The caller's SQL is never spliced into the statement: the engine runs `SELECT * FROM platform_explain($1)` with the
 * SQL as its only bind parameter. The engine runs `EXPLAIN (FORMAT JSON)` and never `ANALYZE`, and this tool offers
 * no argument to ask for it. The engine requires `attrs.platform_read` or `attrs.platform_explain` and an
 * `audit.description`; the caller's `description` is sent when given, otherwise a generated one (Contract
 * assumption 6).
 *
 * The result is `{ plan, advice, adviceError? }`. Plan advice is a later feature: until an advisor is attached,
 * `advise: false` returns `advice: null`, and `advise: true` (the default) returns `advice: null` with an
 * `adviceError`. Advice never fails the tool.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { EngineClient, EngineResult } from '../engine/client.js';
import { ToolInputError, errorResult, failureResult } from './telemetryArgs.js';

export const PLATFORM_EXPLAIN_TOOL = 'platform_explain';
export const PLATFORM_EXPLAIN_SQL = 'SELECT * FROM platform_explain($1)';
export const GENERATED_EXPLAIN_DESCRIPTION = 'MCP platform_explain: estimate-only plan of one Platform Database query';
export const ADVICE_NOT_CONFIGURED = 'Plan advice is not configured on this server';

export interface PlatformExplainArgs {
    sql?: unknown;
    description?: unknown;
    advise?: unknown;
}

export interface PlatformExplainQuery {
    sql: string;
    params: [string];
    /** The `audit.description` of the identity token: never blank. */
    description: string;
    advise: boolean;
}

export interface PlatformExplainResult {
    [key: string]: unknown;
    plan: unknown;
    advice: null;
    adviceError?: string;
}

const blankString = (value: unknown): boolean => typeof value !== 'string' || value.trim().length === 0;

/** The engine statement, its single bind parameter and audit description, or a `ToolInputError` before any engine call. */
export function buildPlatformExplainQuery(args: PlatformExplainArgs): PlatformExplainQuery {
    if (blankString(args.sql)) throw new ToolInputError('sql is required: the SQL statement to plan');
    if (args.description !== undefined && typeof args.description !== 'string') {
        throw new ToolInputError('description must be a string');
    }
    if (args.advise !== undefined && typeof args.advise !== 'boolean') throw new ToolInputError('advise must be a boolean');
    return {
        sql: PLATFORM_EXPLAIN_SQL,
        params: [args.sql as string],
        description: blankString(args.description) ? GENERATED_EXPLAIN_DESCRIPTION : (args.description as string),
        advise: args.advise ?? true,
    };
}

/**
 * The plan from the engine's single `plan json` cell. A json column arrives parsed; a plan that arrives as JSON text
 * is parsed, and kept as text if it is not JSON.
 */
export function planOf(result: EngineResult): unknown {
    const column = result.columns[0];
    const row = result.rows[0];
    if (column === undefined || row === undefined) throw new Error('platform_explain returned no plan');
    const plan = row[column];
    if (typeof plan !== 'string') return plan;
    try {
        return JSON.parse(plan) as unknown;
    } catch {
        return plan;
    }
}

/** The tool result, or an error when the plan alone is larger than `MCP_MAX_OUTPUT_BYTES`. */
export function platformExplainResult(structured: PlatformExplainResult, maxBytes: number): CallToolResult {
    const text = JSON.stringify(structured);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        return errorResult('The plan is too large to return (MCP_MAX_OUTPUT_BYTES); plan a smaller query');
    }
    return { content: [{ type: 'text', text }], structuredContent: structured };
}

export function registerPlatformExplain(server: McpServer, config: Config, engine: EngineClient): void {
    server.registerTool(
        PLATFORM_EXPLAIN_TOOL,
        {
            title: 'Platform explain',
            description:
                'Returns the estimate-only query plan (EXPLAIN FORMAT JSON, never ANALYZE, so the query is not run) ' +
                'for one SQL statement against the Platform Database, as { plan, advice, adviceError? }. This is an ' +
                'Audited Query: it needs the platform_read or platform_explain attribute and is recorded with your ' +
                'description (a generated one when none is given). Find tables and columns with platform_schema.',
            inputSchema: {
                sql: z
                    .string()
                    .describe('The SQL statement to plan, for example SELECT id FROM orders WHERE status = \'open\'.'),
                description: z
                    .string()
                    .optional()
                    .describe(
                        'Why you are planning this query, recorded in the audit log, for example "Checking why the ' +
                            'backlog query is slow for ENG-123". A generated description is used when omitted.',
                    ),
                advise: z
                    .boolean()
                    .optional()
                    .describe(
                        'Whether to add AI plan advice. Defaults to true. With false, advice is null. Advice never ' +
                            'fails the tool: when it is unavailable, advice is null and adviceError says why.',
                    ),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const query = buildPlatformExplainQuery(args);
                const result = await engine.query(query.sql, query.params, {
                    maxRows: 1,
                    audit: { description: query.description },
                });
                const structured: PlatformExplainResult = { plan: planOf(result), advice: null };
                if (query.advise) structured.adviceError = ADVICE_NOT_CONFIGURED;
                return platformExplainResult(structured, config.maxOutputBytes);
            } catch (err) {
                return failureResult(err, 'The Platform Database explain');
            }
        },
    );
}
