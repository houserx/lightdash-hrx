/**
 * `platform_query` (CONTRACTS §7): a read-only Audited Query against the Platform Database (§1.1, §1.2, §6).
 *
 * The caller's SQL is never spliced into the statement: the engine runs `SELECT * FROM platform_query($1)` with the
 * SQL as its only bind parameter, under the Platform Database's read-only role and the engine's guard (§5). The
 * engine requires `attrs.platform_read` and an `audit.description`; this tool also requires the description itself
 * (§7 "needs description"), and an optional Linear ticket key such as `ENG-123`, both sent in the identity token's
 * audit block. Bad input is refused before any engine connection. When the engine cannot write the audit record
 * (SQLSTATE 58000) it withholds the result, and the tool returns an error with no rows.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { EngineClient } from '../engine/client.js';
import { ToolInputError, failureResult, successResult, tableResult } from './telemetryArgs.js';

export const PLATFORM_QUERY_TOOL = 'platform_query';
export const PLATFORM_QUERY_SQL = 'SELECT * FROM platform_query($1)';

/** A Linear issue key: an upper-case team key starting with a letter, a dash and an issue number, e.g. `ENG-123`. */
export const LINEAR_TICKET = /^[A-Z][A-Z0-9]{0,9}-[1-9]\d{0,8}$/;

export interface PlatformQueryArgs {
    sql?: unknown;
    description?: unknown;
    ticket?: unknown;
}

export interface PlatformQuery {
    sql: string;
    params: [string];
    audit: { description: string; ticket: string | null };
}

const blankString = (value: unknown): boolean => typeof value !== 'string' || value.trim().length === 0;

/** The engine statement, its single bind parameter and the audit block, or a `ToolInputError` before any engine call. */
export function buildPlatformQuery(args: PlatformQueryArgs): PlatformQuery {
    if (blankString(args.sql)) throw new ToolInputError('sql is required: the read-only SQL to run');
    if (blankString(args.description)) {
        throw new ToolInputError(
            'description is required: say why you are running this query; it is recorded in the audit log',
        );
    }
    let ticket: string | null = null;
    if (args.ticket !== undefined && args.ticket !== null) {
        if (typeof args.ticket !== 'string' || !LINEAR_TICKET.test(args.ticket)) {
            throw new ToolInputError('ticket must be a Linear issue key such as ENG-123, or omitted');
        }
        ticket = args.ticket;
    }
    return {
        sql: PLATFORM_QUERY_SQL,
        params: [args.sql as string],
        audit: { description: args.description as string, ticket },
    };
}

export function registerPlatformQuery(server: McpServer, config: Config, engine: EngineClient): void {
    server.registerTool(
        PLATFORM_QUERY_TOOL,
        {
            title: 'Platform query',
            description:
                'Runs one read-only SQL query against the Platform Database and returns columns, rows, rowCount and ' +
                'truncated (true when the result was cut at the server row or size cap). This is an Audited Query: ' +
                'it needs the platform_read attribute, and every run is recorded with your description and optional ' +
                'Linear ticket. If the audit record cannot be written, no rows are returned. Find tables and columns ' +
                'with platform_schema.',
            inputSchema: {
                sql: z
                    .string()
                    .describe('One read-only SQL statement (SELECT or WITH), for example SELECT status, count(*) FROM orders GROUP BY 1.'),
                description: z
                    .string()
                    .describe(
                        'Required. Why you are running this query, recorded in the audit log, for example "Checking ' +
                            'the order backlog for ENG-123".',
                    ),
                ticket: z
                    .string()
                    .optional()
                    .describe('Optional Linear issue key this query is for, for example ENG-123.'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const query = buildPlatformQuery(args);
                const result = await engine.query(query.sql, query.params, {
                    maxRows: config.maxRows,
                    audit: query.audit,
                });
                return successResult(tableResult(result), config.maxOutputBytes);
            } catch (err) {
                return failureResult(err, 'The Platform Database query');
            }
        },
    );
}
