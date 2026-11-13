/**
 * `platform_schema` (CONTRACTS §7): the Platform Database catalog, as an Audited Query (§1.2, §6).
 *
 * - No `table_name`: lists tables through `platform_tables()` and returns `{ tables: [{table_schema, table_name}] }`.
 * - With `table_name`: describes one table through `platform_columns($1, $2)` (schema and table as bind parameters,
 *   `table_schema` defaulting to `public`) and returns `{ columns: [{column_name, data_type, is_nullable}] }`.
 *
 * The engine requires `attrs.platform_read` and an `audit.description` for both functions. The caller's
 * `description` is sent when given; otherwise a generated one says what was read (Contract assumption 6).
 * Both results also carry `rowCount` and `truncated`, and stay within `MCP_MAX_ROWS` and `MCP_MAX_OUTPUT_BYTES`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { EngineClient, EngineResult } from '../engine/client.js';
import { ToolInputError, capTableBytes, errorResult, failureResult, tableResult } from './telemetryArgs.js';

export const PLATFORM_SCHEMA_TOOL = 'platform_schema';
export const DEFAULT_TABLE_SCHEMA = 'public';

export interface PlatformSchemaArgs {
    table_schema?: string;
    table_name?: string;
    description?: string;
}

export interface PlatformSchemaQuery {
    /** `tables` for `platform_tables()`, `columns` for `platform_columns($1, $2)`: the result key. */
    kind: 'tables' | 'columns';
    sql: string;
    params: string[];
    /** The `audit.description` of the identity token: never blank. */
    description: string;
}

const blank = (value: string | undefined): boolean => value === undefined || value.trim().length === 0;

/** The engine statement, its bind parameters and audit description, or a `ToolInputError` before any engine call. */
export function buildPlatformSchemaQuery(args: PlatformSchemaArgs): PlatformSchemaQuery {
    for (const key of ['table_schema', 'table_name', 'description'] as const) {
        if (args[key] !== undefined && typeof args[key] !== 'string') throw new ToolInputError(`${key} must be a string`);
    }
    const callerDescription = blank(args.description) ? undefined : args.description;
    if (args.table_name === undefined) {
        if (args.table_schema !== undefined) {
            throw new ToolInputError(
                'table_schema needs table_name: give both to describe one table, or neither to list all tables',
            );
        }
        return {
            kind: 'tables',
            sql: 'SELECT * FROM platform_tables()',
            params: [],
            description: callerDescription ?? 'MCP platform_schema: list Platform Database tables',
        };
    }
    if (blank(args.table_name)) throw new ToolInputError('table_name must not be blank');
    if (args.table_schema !== undefined && blank(args.table_schema)) {
        throw new ToolInputError('table_schema must not be blank; omit it for public');
    }
    const tableSchema = args.table_schema ?? DEFAULT_TABLE_SCHEMA;
    return {
        kind: 'columns',
        sql: 'SELECT * FROM platform_columns($1, $2)',
        params: [tableSchema, args.table_name],
        description: callerDescription ?? 'MCP platform_schema: describe the columns of one Platform Database table',
    };
}

/**
 * The tool result: `{ tables | columns: rows, rowCount, truncated }`, with rows dropped to fit `maxBytes` as the
 * query tools do. The cap is computed on the table with an empty `columns` list; the result swaps
 * `"columns":[],"rows":` for `"<kind>":`, which is never longer, so the JSON stays within `maxBytes`.
 */
export function platformSchemaResult(
    kind: PlatformSchemaQuery['kind'],
    result: EngineResult,
    maxBytes: number,
): CallToolResult {
    const capped = capTableBytes({ ...tableResult(result), columns: [] }, maxBytes);
    if (capped === undefined) {
        return errorResult('The result is too large to return even without rows (MCP_MAX_OUTPUT_BYTES)');
    }
    const structured = { [kind]: capped.rows, rowCount: capped.rowCount, truncated: capped.truncated };
    return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

export function registerPlatformSchema(server: McpServer, config: Config, engine: EngineClient): void {
    server.registerTool(
        PLATFORM_SCHEMA_TOOL,
        {
            title: 'Platform schema',
            description:
                'Lists the tables of the Platform Database, or describes the columns of one table. With no ' +
                'table_name it returns tables [{table_schema, table_name}]; with table_name (and optionally ' +
                'table_schema, default public) it returns columns [{column_name, data_type, is_nullable}]. Both ' +
                'carry rowCount and truncated. This is an Audited Query: it needs the platform_read attribute and is ' +
                'recorded with your description (a generated one when none is given).',
            inputSchema: {
                table_schema: z
                    .string()
                    .optional()
                    .describe('Schema of the table to describe, for example public. Only used with table_name. Defaults to public.'),
                table_name: z
                    .string()
                    .optional()
                    .describe('Table to describe, for example orders. Omit it to list every table.'),
                description: z
                    .string()
                    .optional()
                    .describe(
                        'Why you are reading the catalog, recorded in the audit log, for example "Finding where fills ' +
                            'are stored for ENG-123". A generated description is used when omitted.',
                    ),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const query = buildPlatformSchemaQuery(args);
                const result = await engine.query(query.sql, query.params, {
                    maxRows: config.maxRows,
                    audit: { description: query.description },
                });
                return platformSchemaResult(query.kind, result, config.maxOutputBytes);
            } catch (err) {
                return failureResult(err, 'The Platform Database catalog read');
            }
        },
    );
}
