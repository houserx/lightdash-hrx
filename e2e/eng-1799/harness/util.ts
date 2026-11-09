import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

export const REPO_ROOT =
    process.env.E2E_REPO_ROOT ?? path.resolve(__dirname, '../../..');

/** Every scratch dir lives under tmp/e2e so init.sh can reap leftovers of killed checks. */
export const E2E_TMP = path.join(REPO_ROOT, 'tmp/e2e');

/** A new empty directory `tmp/e2e/<prefix>-<pid>-<random>`. */
export function scratchDir(prefix: string): string {
    fs.mkdirSync(E2E_TMP, { recursive: true });
    const dir = path.join(
        E2E_TMP,
        `${prefix}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
    );
    fs.mkdirSync(dir);
    return dir;
}

/** A TCP port on 127.0.0.1 that was free a moment ago (the OS picks it). */
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port =
                typeof address === 'object' && address ? address.port : 0;
            server.close(() =>
                port ? resolve(port) : reject(new Error('no free port')),
            );
        });
    });
}

/** `count` distinct free ports. */
export async function freePorts(count: number): Promise<number[]> {
    const ports = new Set<number>();
    while (ports.size < count) {
        // eslint-disable-next-line no-await-in-loop
        ports.add(await freePort());
    }
    return [...ports];
}

/** True when something accepts a TCP connection on 127.0.0.1:`port`. */
export function tcpOpen(port: number, timeoutMs = 1_000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const done = (open: boolean) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

export const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
