/**
 * Reads the JSON-RPC body of a `/mcp` POST before the MCP transport does, so the server can see which methods the
 * request carries (`tools/list`, `tools/call`) and resolve the caller's Lightdash user only when a tool is involved.
 * The parsed body is handed to the transport (`handleRequest(req, res, parsedBody)`), which validates it as usual.
 */
import type http from 'node:http';

/** Same bound as the SDK transport's own body reader (4 MiB). */
export const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

export type McpBody =
    | { kind: 'none' }
    | { kind: 'tooLarge' }
    /** `parsed` is the JSON value, or the raw text when it is not JSON (the transport then answers a parse error). */
    | { kind: 'read'; parsed: unknown };

/** Reads a POST body up to `maxBytes`; other methods carry no JSON-RPC body and are left to the transport. */
export async function readMcpBody(req: http.IncomingMessage, maxBytes = MAX_MCP_BODY_BYTES): Promise<McpBody> {
    if (req.method !== 'POST') return { kind: 'none' };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) return { kind: 'tooLarge' };
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
        size += buf.length;
        if (size > maxBytes) return { kind: 'tooLarge' };
        chunks.push(buf);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
        return { kind: 'read', parsed: JSON.parse(text) as unknown };
    } catch {
        return { kind: 'read', parsed: text };
    }
}

/** Does the JSON-RPC message (or batch) contain a request for one of `methods`? */
export function carriesMethod(parsed: unknown, methods: readonly string[]): boolean {
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some(
        (m) =>
            typeof m === 'object' &&
            m !== null &&
            typeof (m as { method?: unknown }).method === 'string' &&
            methods.includes((m as { method: string }).method),
    );
}
