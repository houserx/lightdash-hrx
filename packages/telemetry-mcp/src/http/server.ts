import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../config.js';

export interface RunningServer {
    /** Base URL, e.g. `http://127.0.0.1:8080` (no path). */
    url: string;
    close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.setHeader('Allow', 'GET, HEAD');
            sendJson(res, 405, { error: 'method_not_allowed' });
            return;
        }
        sendJson(res, 200, { status: 'ok' });
        return;
    }
    sendJson(res, 404, { error: 'not_found' });
}

export async function startServer({ config }: { config: Config }): Promise<RunningServer> {
    const server = http.createServer((req, res) => {
        handle(req, res).catch(() => {
            if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
            else res.end();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}
