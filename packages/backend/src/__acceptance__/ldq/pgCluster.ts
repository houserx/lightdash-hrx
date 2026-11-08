/**
 * Throwaway Postgres cluster for ldq acceptance tests. Lives in the repo's tmp/ (gitignored),
 * listens on 127.0.0.1 on a free port with no unix socket (macOS socket paths here are too
 * long), and logs every statement so tests can see what a client sent.
 * Always call stop() in the same test file that started it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const PG_BIN = process.env.LDQ_PG_BIN ?? '/opt/homebrew/bin';
const repoRoot = path.resolve(__dirname, '../../../../..');

export type PgCluster = {
    port: number;
    url: string;
    dir: string;
    readLog: () => string;
    stop: () => void;
};

const freePort = () =>
    new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });

export const startPgCluster = async (): Promise<PgCluster> => {
    const tmpRoot = path.join(repoRoot, 'tmp');
    mkdirSync(tmpRoot, { recursive: true });
    const dir = mkdtempSync(path.join(tmpRoot, 'ldq-pg-'));
    const data = path.join(dir, 'data');
    const logFile = path.join(dir, 'server.log');
    execFileSync(
        path.join(PG_BIN, 'initdb'),
        ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync'],
        { stdio: 'ignore' },
    );
    const port = await freePort();
    const options = [
        `-p ${port}`,
        '-h 127.0.0.1',
        "-c unix_socket_directories=''",
        '-c fsync=off',
        '-c synchronous_commit=off',
        '-c full_page_writes=off',
        '-c log_statement=all',
    ].join(' ');
    execFileSync(
        path.join(PG_BIN, 'pg_ctl'),
        ['-D', data, '-l', logFile, '-o', options, '-w', '-t', '60', 'start'],
        { stdio: 'ignore' },
    );
    return {
        port,
        url: `postgres://postgres:not-a-real-password@127.0.0.1:${port}/postgres`,
        dir,
        readLog: () => readFileSync(logFile, 'utf8'),
        stop: () => {
            spawnSync(
                path.join(PG_BIN, 'pg_ctl'),
                ['-D', data, '-m', 'immediate', '-w', 'stop'],
                { stdio: 'ignore' },
            );
            rmSync(dir, { recursive: true, force: true });
        },
    };
};

/** Statements the server logged, in order (simple and extended protocol). */
export const loggedStatements = (log: string): string[] =>
    log
        .split('\n')
        .map((line) => {
            const match = line.match(
                /LOG:\s+(?:statement|execute [^:]*):\s+(.*)$/,
            );
            return match ? match[1].trim() : null;
        })
        .filter((statement): statement is string => statement !== null);
