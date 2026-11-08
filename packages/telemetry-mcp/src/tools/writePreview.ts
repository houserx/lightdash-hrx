/**
 * `write_preview` (CONTRACTS §7): runs one Write Mode statement against the Platform Database as a Preview only,
 * through the engine's `POST /v1/write` with `mode: "preview"` (see `engine/write.ts`). The engine rolls the
 * transaction back, so nothing is committed; the tool returns `{audit_id, rows_affected, preview, returning}`.
 *
 * There is no mode argument and no commit path: committing a write is a human action in Lightdash. A description is
 * required (it is recorded in the audit log) and a Linear ticket is optional; bad input is refused before any engine
 * call.
 *
 * The caller needs the `platform_write` user attribute. The engine checks it too, but the tool refuses a caller
 * without it (or whose attributes cannot be read) before any engine request, so no Preview is ever attempted for them.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { EngineWriteError, type EngineWriter, type PreviewRequest, type PreviewResult } from '../engine/write.js';
import type { IdentityAttrs } from '../identity/token.js';
import { LINEAR_TICKET } from './platformQuery.js';
import { ToolInputError, errorResult } from './telemetryArgs.js';

export const WRITE_PREVIEW_TOOL = 'write_preview';

/** The caller's §3 attrs, resolved from their Lightdash user; rejects when they cannot be read. */
export type CallerAttrs = () => Promise<Pick<IdentityAttrs, 'platform_write'>>;

/** Shown when the caller lacks `platform_write`. */
export const PLATFORM_WRITE_REQUIRED =
    'write_preview needs the platform_write user attribute, and your Lightdash user does not have it. Ask a ' +
    'Lightdash admin to grant platform_write if you need to preview writes.';

/** Shown when the caller's attributes cannot be read; the tool fails closed. */
export const PLATFORM_WRITE_UNCHECKED =
    'The Preview was not run: your platform_write user attribute could not be checked. Try again later.';

/** Resolves to an error message when the caller may not Preview writes, else `undefined`. */
export async function writeAccessDenial(attrs: CallerAttrs): Promise<string | undefined> {
    let platformWrite: boolean;
    try {
        platformWrite = (await attrs()).platform_write === true;
    } catch {
        return PLATFORM_WRITE_UNCHECKED;
    }
    return platformWrite ? undefined : PLATFORM_WRITE_REQUIRED;
}

export interface WritePreviewArgs {
    statement?: unknown;
    description?: unknown;
    ticket?: unknown;
}

const blankString = (value: unknown): boolean => typeof value !== 'string' || value.trim().length === 0;

/** The Preview request, or a `ToolInputError` before any engine call. */
export function buildPreviewRequest(args: WritePreviewArgs): PreviewRequest {
    if (blankString(args.statement)) {
        throw new ToolInputError('statement is required: the one INSERT, UPDATE or DELETE statement to Preview');
    }
    if (blankString(args.description)) {
        throw new ToolInputError(
            'description is required: say why you are previewing this write; it is recorded in the audit log',
        );
    }
    let ticket: string | null = null;
    if (args.ticket !== undefined && args.ticket !== null) {
        if (typeof args.ticket !== 'string' || !LINEAR_TICKET.test(args.ticket)) {
            throw new ToolInputError('ticket must be a Linear issue key such as ENG-123, or omitted');
        }
        ticket = args.ticket;
    }
    return { statement: args.statement as string, description: args.description as string, ticket };
}

/** The tool result for an engine Preview reply, within `MCP_MAX_OUTPUT_BYTES`. */
export function previewResult(result: PreviewResult, maxBytes: number): CallToolResult {
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        return errorResult(
            `The Preview ran (audit id ${result.audit_id}, ${result.rows_affected} rows affected, nothing committed), ` +
                'but its RETURNING rows are too large to return (MCP_MAX_OUTPUT_BYTES). Return fewer columns or ' +
                'affect fewer rows.',
        );
    }
    return { content: [{ type: 'text', text }], structuredContent: result };
}

export function registerWritePreview(
    server: McpServer,
    config: Config,
    writer: EngineWriter,
    attrs: CallerAttrs,
): void {
    server.registerTool(
        WRITE_PREVIEW_TOOL,
        {
            title: 'Write Preview',
            description:
                'Runs one INSERT, UPDATE or DELETE statement against the Platform Database as a Preview only: the ' +
                'Federation Engine runs it in a transaction and rolls it back, so nothing is committed. Returns ' +
                'audit_id, rows_affected, preview (always true) and the RETURNING rows (null without a RETURNING ' +
                'clause). It needs the platform_write attribute, and every Preview is recorded in the audit log with ' +
                'your description and optional Linear ticket. This tool cannot commit; a person commits the write in ' +
                'Lightdash. Add RETURNING to see the rows the statement would change.',
            inputSchema: {
                statement: z
                    .string()
                    .describe(
                        "One INSERT, UPDATE or DELETE statement, for example UPDATE orders SET status = 'cancelled' " +
                            'WHERE id = 1 RETURNING id, status.',
                    ),
                description: z
                    .string()
                    .describe(
                        'Required. Why you are previewing this write, recorded in the audit log, for example ' +
                            '"Preview cancelling a duplicate order for ENG-123".',
                    ),
                ticket: z
                    .string()
                    .optional()
                    .describe('Optional Linear issue key this write is for, for example ENG-123.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (args) => {
            const denial = await writeAccessDenial(attrs);
            if (denial !== undefined) return errorResult(denial);
            try {
                const result = await writer.preview(buildPreviewRequest(args));
                return previewResult(result, config.maxOutputBytes);
            } catch (err) {
                if (err instanceof ToolInputError || err instanceof EngineWriteError) return errorResult(err.message);
                return errorResult('The Preview failed: unexpected error');
            }
        },
    );
}
