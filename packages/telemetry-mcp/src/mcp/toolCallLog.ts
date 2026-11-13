/**
 * One structured log line per `tools/call`, written when its JSON-RPC response leaves the transport.
 *
 * Watching the transport (not wrapping each tool handler) also covers calls the SDK answers itself, such as input
 * schema violations and unknown tools, and calls refused because the user is not mapped.
 *
 * A line holds only metadata: the tool name (when it is a plain identifier), the outcome, the duration, the JSON-RPC
 * error code and, for a table result, `rowCount` and `truncated`. Arguments, result rows, SQL and error text are never
 * read into it.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Logger, LogFields } from '../log.js';

/** A tool name that is logged as given; anything else is logged as `(invalid)`. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export type ToolCallOutcome = 'ok' | 'error' | 'rejected';

type RequestId = string | number;

interface PendingCall {
    tool: string;
    start: number;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function isRequestId(v: unknown): v is RequestId {
    return typeof v === 'string' || typeof v === 'number';
}

/** The `tools/call` requests in a JSON-RPC body (one message or a batch), keyed by request id. */
export function pendingToolCalls(parsedBody: unknown, now: () => number): Map<RequestId, PendingCall> {
    const calls = new Map<RequestId, PendingCall>();
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    for (const m of messages) {
        const msg = asObject(m);
        if (!msg || msg.method !== 'tools/call' || !isRequestId(msg.id)) continue;
        const name = asObject(msg.params)?.name;
        calls.set(msg.id, { tool: typeof name === 'string' && TOOL_NAME.test(name) ? name : '(invalid)', start: now() });
    }
    return calls;
}

/** The log fields describing one response: outcome, error code, and row counts of a table result. */
export function describeResponse(message: JSONRPCMessage): LogFields & { outcome: ToolCallOutcome } {
    const msg = message as Record<string, unknown>;
    const error = asObject(msg.error);
    if (error) {
        return { outcome: 'rejected', code: typeof error.code === 'number' ? error.code : undefined };
    }
    const result = asObject(msg.result) ?? {};
    const structured = asObject(result.structuredContent);
    return {
        outcome: result.isError === true ? 'error' : 'ok',
        rowCount: typeof structured?.rowCount === 'number' ? structured.rowCount : undefined,
        truncated: typeof structured?.truncated === 'boolean' ? structured.truncated : undefined,
    };
}

/**
 * Logs every `tools/call` in `parsedBody` when the transport sends its response. `user` is the caller's Okta `sub`.
 */
export function logToolCalls(
    transport: Transport,
    parsedBody: unknown,
    logger: Logger,
    user: string | undefined,
    now: () => number = Date.now,
): void {
    const calls = pendingToolCalls(parsedBody, now);
    if (calls.size === 0) return;
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
        const id = (message as { id?: unknown }).id;
        const call = isRequestId(id) ? calls.get(id) : undefined;
        if (call && isRequestId(id)) {
            calls.delete(id);
            const fields = describeResponse(message);
            const line = { tool: call.tool, user, durationMs: Math.max(0, now() - call.start), ...fields };
            if (fields.outcome === 'ok') logger.info('tool call', line);
            else logger.warn('tool call', line);
        }
        return send(message, options);
    };
}
