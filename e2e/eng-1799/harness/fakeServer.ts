/**
 * The base of every fake HTTP service in the harness: a node:http server on an ephemeral
 * 127.0.0.1 port that records each request (Harness API `RecordedRequest`) before a handler
 * answers it.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export type RecordedRequest = {
    method: string;
    path: string;
    /** The query string merged with a form body (the body wins on a clash). */
    params: Record<string, string>;
    /** Lower-case keys. */
    headers: Record<string, string>;
    body: string;
    json?: unknown;
};

export type FakeServer = {
    url: string;
    /** Every request received, in arrival order. */
    requests: RecordedRequest[];
    close(): Promise<void>;
};

export type FakeReply = {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
};

/**
 * Answers a recorded request; `res` is there for handlers that must notice a client hang-up,
 * `rawBody` for handlers that decode a binary or byte-framed body (e.g. aws-chunked).
 */
export type FakeHandler = (
    request: RecordedRequest,
    res: http.ServerResponse,
    rawBody: Buffer,
) => FakeReply | undefined | Promise<FakeReply | undefined>;

function headerRecord(raw: http.IncomingHttpHeaders): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (value !== undefined) {
            headers[key.toLowerCase()] = Array.isArray(value)
                ? value.join(', ')
                : value;
        }
    }
    return headers;
}

function record(req: http.IncomingMessage, body: string): RecordedRequest {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const headers = headerRecord(req.headers);
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    const contentType = headers['content-type'] ?? '';
    if (contentType.startsWith('application/x-www-form-urlencoded')) {
        Object.assign(params, Object.fromEntries(new URLSearchParams(body)));
    }
    const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        params,
        headers,
        body,
    };
    if (body) {
        try {
            recorded.json = JSON.parse(body);
        } catch {
            // not JSON
        }
    }
    return recorded;
}

/** A JSON reply. */
export const jsonReply = (value: unknown, status = 200): FakeReply => ({
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
});

/**
 * Starts a fake on a free 127.0.0.1 port. A handler that returns `undefined` sends nothing
 * (for a client that already hung up). A handler that throws answers 500 with the message.
 */
export async function startFakeServer(
    handler: FakeHandler,
): Promise<FakeServer> {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks);
            const recorded = record(req, rawBody.toString('utf8'));
            requests.push(recorded);
            Promise.resolve()
                .then(() => handler(recorded, res, rawBody))
                .catch(
                    (error: unknown): FakeReply => ({
                        status: 500,
                        headers: { 'content-type': 'text/plain' },
                        body: `fake server error: ${String(error)}`,
                    }),
                )
                .then((reply) => {
                    if (!reply || res.writableEnded || res.destroyed) return;
                    res.writeHead(reply.status ?? 200, reply.headers ?? {});
                    res.end(reply.body ?? '');
                });
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    let closing: Promise<void> | undefined;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close() {
            closing ??= new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
            return closing;
        },
    };
}
