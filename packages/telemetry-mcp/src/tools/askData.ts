/**
 * `ask_data` (CONTRACTS §7): answers a natural-language question about the Platform Database with the ported portal
 * data assistant (`src/ask/data-assistant.service.ts`).
 *
 * The model explores the catalog from `platform_tables()` / `platform_columns()` and runs read-only Audited Queries,
 * each as `SELECT * FROM platform_query($1)` with the model SQL as the only bind parameter, on the caller's engine
 * client, so every statement is audited as the caller (an agent identity) with the portal's audit description, which
 * names the model and the question. The result is the portal's `AskResult`.
 *
 * The question must be 1..1000 characters (the portal's `MAX_QUESTION_CHARS`) and not blank; it is checked before any
 * model call or engine connection. `history` holds earlier turns of the conversation, used as context only (the
 * service keeps the last 3 and truncates long answers). Failures of the ask (`AskError`: not configured, catalog or
 * model failure, audit write failure, cancelled) are tool errors with the service's message, with configured secrets
 * redacted.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AskMemoryService, AskMemoryUser } from '../ask/ask-memory.service.js';
import {
    AskError,
    MAX_QUESTION_CHARS,
    createDataAssistant,
    type AskHistoryTurn,
    type AskResult,
} from '../ask/data-assistant.service.js';
import type { ExampleQueries } from '../ask/example-queries.service.js';
import type { LlmClient } from '../ask/llm.js';
import type { Config } from '../config.js';
import type { EngineClient } from '../engine/client.js';
import { redactSecrets } from '../engine/errors.js';
import { configSecrets } from '../log.js';
import { ToolInputError, errorResult, failureResult } from './telemetryArgs.js';

export const ASK_DATA_TOOL = 'ask_data';
export const ASK_DATA_TOO_LARGE =
    'The answer is too large to return (MCP_MAX_OUTPUT_BYTES); ask a narrower question';

export interface AskDataDeps {
    engine: EngineClient;
    /** The model client; absent means Ask is not configured. */
    llm?: LlmClient;
    /** Team memory, shared by every caller of this server. */
    memory: AskMemoryService;
    /** Teammates' past queries, read through the engine audit browser as the caller. */
    examples: ExampleQueries;
    /** The caller, as recorded in team memory: the Lightdash user uuid and email. */
    user: () => Promise<AskMemoryUser>;
    now: () => number;
    /** Unexpected failures inside the assistant. Never given row data. */
    onError?: (err: unknown, where: string) => void;
}

export interface AskDataArgs {
    question?: unknown;
    history?: unknown;
}

/** The validated question and history, or a `ToolInputError` before any model call or engine connection. */
export function parseAskDataArgs(args: AskDataArgs): { question: string; history: AskHistoryTurn[] } {
    const { question, history } = args;
    if (typeof question !== 'string' || question.trim().length === 0) {
        throw new ToolInputError('question is required: a question about the Platform Database');
    }
    if (question.length > MAX_QUESTION_CHARS) {
        throw new ToolInputError(`question must be at most ${MAX_QUESTION_CHARS} characters`);
    }
    if (history === undefined) return { question, history: [] };
    if (
        !Array.isArray(history) ||
        !history.every(
            (t: unknown) =>
                typeof t === 'object' &&
                t !== null &&
                typeof (t as AskHistoryTurn).question === 'string' &&
                typeof (t as AskHistoryTurn).answer === 'string',
        )
    ) {
        throw new ToolInputError('history must be a list of { question, answer } turns');
    }
    return { question, history: history as AskHistoryTurn[] };
}

/**
 * The tool result. When the result is larger than `MCP_MAX_OUTPUT_BYTES`, the query rows are dropped (each query
 * keeps its SQL and columns, with `moreRowsAvailable: true`) so the answer still arrives; an answer that is still too
 * large is an error.
 */
export function askDataResult(result: AskResult, maxBytes: number): CallToolResult {
    let out = result;
    let text = JSON.stringify(out);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        out = { ...out, queries: out.queries.map((q) => ({ ...q, rows: [], moreRowsAvailable: true })) };
        text = JSON.stringify(out);
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return errorResult(ASK_DATA_TOO_LARGE);
    return { content: [{ type: 'text', text }], structuredContent: out as unknown as Record<string, unknown> };
}

export function registerAskData(server: McpServer, config: Config, deps: AskDataDeps): void {
    server.registerTool(
        ASK_DATA_TOOL,
        {
            title: 'Ask data',
            description:
                'Answers a natural-language question about the Platform Database. An AI model explores the schema ' +
                'and runs read-only Audited Queries as you (each recorded with the question), then either gives an ' +
                'answer grounded in the query results or abstains with the reason. Returns { askId, question, ' +
                'database, model, answer, queries, memory, rowsSharedWithModel, usage }: answer.evidenceQueries ' +
                'points into queries, which carry the SQL and the rows the model saw. Needs the platform_read ' +
                'attribute. Grounded answers may add lessons to a shared team memory.',
            inputSchema: {
                question: z
                    .string()
                    .min(1)
                    .max(MAX_QUESTION_CHARS)
                    .describe(
                        `The question, 1 to ${MAX_QUESTION_CHARS} characters, for example "How many orders were ` +
                            'shipped last week?".',
                    ),
                history: z
                    .array(
                        z.object({
                            question: z.string().describe('An earlier question in this conversation.'),
                            answer: z.string().describe('The answer that was given to it.'),
                        }),
                    )
                    .optional()
                    .describe(
                        'Earlier turns of this conversation, oldest first, so a follow-up such as "and last month?" ' +
                            'can be understood. Used as context only, never as evidence.',
                    ),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        async (args, extra) => {
            try {
                const { question, history } = parseAskDataArgs(args);
                const assistant = createDataAssistant({
                    llm: deps.llm ?? null,
                    engine: deps.engine,
                    memory: deps.memory,
                    examples: deps.examples,
                    maxSteps: config.askMaxSteps,
                    queryTimeoutMs: config.statementTimeoutMs,
                    now: deps.now,
                    onError: deps.onError,
                });
                const result = await assistant.askData({
                    question,
                    database: config.platformSource,
                    user: await deps.user(),
                    history,
                    signal: extra.signal,
                });
                return askDataResult(result, config.maxOutputBytes);
            } catch (err) {
                if (err instanceof AskError) return errorResult(redactSecrets(err.message, configSecrets(config)));
                return failureResult(err, 'The Platform Database ask');
            }
        },
    );
}
