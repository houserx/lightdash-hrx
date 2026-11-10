/**
 * Fake Federation Engine HTTP side port (CONTRACTS §1.3) on 127.0.0.1, ephemeral port.
 * Records every request and answers with whatever the test configures.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RecordedRequest = {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: IncomingMessage['headers'];
    body: any;
};

export type EngineReply = { status: number; body: unknown };

export type FakeEngine = {
    baseUrl: string;
    requests: RecordedRequest[];
    reply: (method: string, path: string, reply: EngineReply) => void;
    close: () => Promise<void>;
};

export const startFakeEngine = async (): Promise<FakeEngine> => {
    const requests: RecordedRequest[] = [];
    const replies = new Map<string, EngineReply>();
    const server: Server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: unknown = raw;
            try {
                body = raw ? JSON.parse(raw) : undefined;
            } catch {
                body = raw;
            }
            requests.push({
                method: request.method ?? 'GET',
                path: url.pathname,
                query: Object.fromEntries(url.searchParams.entries()),
                headers: request.headers,
                body,
            });
            const reply = replies.get(`${request.method} ${url.pathname}`) ?? {
                status: 404,
                body: { error: 'not configured in fake engine' },
            };
            response.writeHead(reply.status, {
                'content-type': 'application/json',
            });
            response.end(JSON.stringify(reply.body));
        });
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        reply: (method, path, reply) => {
            replies.set(`${method} ${path}`, reply);
        },
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
    };
};
