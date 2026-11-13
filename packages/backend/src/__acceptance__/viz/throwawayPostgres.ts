/**
 * Throwaway Postgres cluster for the viz line's backend acceptance checks.
 *
 * Rules from specs/goal-common.md: the cluster lives in the repo's `tmp/`
 * (gitignored), listens on 127.0.0.1 on a free ephemeral port with
 * `unix_socket_directories=''`, and is stopped by the same check that
 * started it. No psql (blocked), no Docker.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

const PG_BIN_CANDIDATES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

const findBinary = (name: string): string => {
    const found = PG_BIN_CANDIDATES.map((dir) => path.join(dir, name)).find(
        (candidate) => existsSync(candidate),
    );
    if (!found) throw new Error(`${name} not found in ${PG_BIN_CANDIDATES}`);
    return found;
};

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (typeof address === 'object' && address) {
                const { port } = address;
                server.close(() => resolve(port));
            } else {
                reject(new Error('could not allocate a port'));
            }
        });
    });

export type ThrowawayPostgres = {
    host: string;
    port: number;
    user: string;
    password: string;
    adminDatabase: string;
    stop: () => void;
};

// packages/backend/src/__acceptance__/viz -> repo root
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

export const startThrowawayPostgres = async (): Promise<ThrowawayPostgres> => {
    const initdb = findBinary('initdb');
    const pgCtl = findBinary('pg_ctl');
    const baseDir = path.join(
        REPO_ROOT,
        'tmp',
        `viz-pg-${randomUUID().slice(0, 8)}`,
    );
    const dataDir = path.join(baseDir, 'data');
    mkdirSync(baseDir, { recursive: true });
    const password = 'test-secret-not-real';
    const pwFile = path.join(baseDir, 'pw');
    writeFileSync(pwFile, password);
    const init = spawnSync(
        initdb,
        [
            '-D',
            dataDir,
            '-U',
            'postgres',
            '--auth=password',
            `--pwfile=${pwFile}`,
            '--encoding=UTF8',
            '--no-instructions',
        ],
        { encoding: 'utf-8' },
    );
    if (init.status !== 0) {
        rmSync(baseDir, { recursive: true, force: true });
        throw new Error(`initdb failed: ${init.stderr}`);
    }
    const port = await freePort();
    const start = spawnSync(
        pgCtl,
        [
            '-D',
            dataDir,
            '-l',
            path.join(baseDir, 'postgres.log'),
            '-w',
            '-t',
            '60',
            '-o',
            `-h 127.0.0.1 -p ${port} -c unix_socket_directories='' -c fsync=off -c full_page_writes=off`,
            'start',
        ],
        { encoding: 'utf-8' },
    );
    if (start.status !== 0) {
        rmSync(baseDir, { recursive: true, force: true });
        throw new Error(`pg_ctl start failed: ${start.stderr}${start.stdout}`);
    }
    return {
        host: '127.0.0.1',
        port,
        user: 'postgres',
        password,
        adminDatabase: 'postgres',
        stop: () => {
            spawnSync(pgCtl, ['-D', dataDir, '-m', 'immediate', 'stop'], {
                encoding: 'utf-8',
            });
            rmSync(baseDir, { recursive: true, force: true });
        },
    };
};
