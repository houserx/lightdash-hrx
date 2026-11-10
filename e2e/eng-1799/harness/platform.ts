/**
 * A throwaway Postgres playing the Platform Database (Harness API `startPlatformDatabase`).
 *
 * The cluster lives in `tmp/e2e/platform-…/pgdata` (init.sh reaps it if a check is killed),
 * listens on 127.0.0.1 at a free port with no unix socket (macOS's socket path limit), and has
 * roles `engine_read` (SELECT) and `engine_write` (SELECT/INSERT/UPDATE/DELETE) and the
 * synthetic `public.widgets` table: ids 1..200, `name = 'widget-<id>'`, `qty = id % 7`.
 * Mirrors the engine line's `federation-engine/tests/acceptance/harness/pg_cluster.rs`.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { freePort, scratchDir, sleep } from './util';

const run = promisify(execFile);

const PG_BIN = process.env.E2E_PG_BIN ?? '/opt/homebrew/bin';
const HOST = '127.0.0.1';
const DATABASE = 'postgres';
const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'test-superuser-password-not-real';
export const PLATFORM_READ_ROLE = 'engine_read';
const READ_PASSWORD = 'test-read-password-not-real';
export const PLATFORM_WRITE_ROLE = 'engine_write';
const WRITE_PASSWORD = 'test-write-password-not-real';
export const PLATFORM_WIDGET_COUNT = 200;

const READY_TIMEOUT_MS = 30_000;

export type PlatformDatabase = {
    port: number;
    /** `postgres://engine_read:…@127.0.0.1:<port>/postgres` */
    readUrl: string;
    /** `postgres://engine_write:…@127.0.0.1:<port>/postgres` */
    writeUrl: string;
    /** Runs `sql` as the superuser on a new connection and returns its rows. */
    query<T = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
    ): Promise<T[]>;
    /** Stops the server (fast shutdown) and removes its directory. Idempotent. */
    stop(): Promise<void>;
};

const url = (user: string, password: string, port: number) =>
    `postgres://${user}:${password}@${HOST}:${port}/${DATABASE}`;

const SEED = `
CREATE ROLE ${PLATFORM_READ_ROLE} LOGIN PASSWORD '${READ_PASSWORD}';
CREATE ROLE ${PLATFORM_WRITE_ROLE} LOGIN PASSWORD '${WRITE_PASSWORD}';
CREATE TABLE public.widgets (
    id int PRIMARY KEY,
    name text NOT NULL,
    qty int NOT NULL
);
INSERT INTO public.widgets (id, name, qty)
SELECT g, 'widget-' || g, g % 7 FROM generate_series(1, ${PLATFORM_WIDGET_COUNT}) AS g;
GRANT USAGE ON SCHEMA public TO ${PLATFORM_READ_ROLE}, ${PLATFORM_WRITE_ROLE};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PLATFORM_READ_ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_WRITE_ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${PLATFORM_WRITE_ROLE};
`;

async function superuserQuery<T>(
    port: number,
    sql: string,
    params?: unknown[],
): Promise<T[]> {
    const client = new pg.Client({
        host: HOST,
        port,
        user: SUPERUSER,
        password: SUPERUSER_PASSWORD,
        database: DATABASE,
    });
    // A connection the server drops (e.g. on stop) must not crash the test process.
    client.on('error', () => undefined);
    try {
        await client.connect();
        const result = await client.query(sql, params);
        return result.rows as T[];
    } finally {
        await client.end().catch(() => undefined);
    }
}

const readLog = (file: string) => {
    try {
        return fs.readFileSync(file, 'utf8').slice(-4_000);
    } catch {
        return '';
    }
};

export async function startPlatformDatabase(): Promise<PlatformDatabase> {
    const pgCtl = path.join(PG_BIN, 'pg_ctl');
    if (!fs.existsSync(pgCtl)) {
        throw new Error(
            `startPlatformDatabase: no pg_ctl at ${pgCtl} (set E2E_PG_BIN)`,
        );
    }
    const dir = scratchDir('platform');
    const data = path.join(dir, 'pgdata');
    const logFile = path.join(dir, 'postgres.log');
    const pwfile = path.join(dir, 'pwfile');

    let started = false;
    let stopping: Promise<void> | undefined;
    const stop = () => {
        stopping ??= (async () => {
            if (started || fs.existsSync(path.join(data, 'postmaster.pid'))) {
                await run(pgCtl, [
                    '-D',
                    data,
                    '-m',
                    'fast',
                    '-w',
                    '-t',
                    '30',
                    'stop',
                ]).catch(() =>
                    run(pgCtl, [
                        '-D',
                        data,
                        '-m',
                        'immediate',
                        '-w',
                        'stop',
                    ]).catch(() => undefined),
                );
            }
            fs.rmSync(dir, { recursive: true, force: true });
        })();
        return stopping;
    };

    try {
        fs.writeFileSync(pwfile, SUPERUSER_PASSWORD);
        await run(path.join(PG_BIN, 'initdb'), [
            '-D',
            data,
            '-U',
            SUPERUSER,
            '-A',
            'scram-sha-256',
            '-E',
            'UTF8',
            '--locale=C',
            '--no-sync',
            `--pwfile=${pwfile}`,
        ]);
        const port = await freePort();
        fs.appendFileSync(
            path.join(data, 'postgresql.conf'),
            `\nport = ${port}\nlisten_addresses = '${HOST}'\nunix_socket_directories = ''\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\nmax_connections = 60\n`,
        );
        started = true;
        await run(pgCtl, [
            '-D',
            data,
            '-l',
            logFile,
            '-w',
            '-t',
            '60',
            'start',
        ]);

        const deadline = Date.now() + READY_TIMEOUT_MS;
        for (;;) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await superuserQuery(port, 'SELECT 1');
                break;
            } catch (error) {
                if (Date.now() > deadline) throw error;
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(50);
        }
        await superuserQuery(port, SEED);

        return {
            port,
            readUrl: url(PLATFORM_READ_ROLE, READ_PASSWORD, port),
            writeUrl: url(PLATFORM_WRITE_ROLE, WRITE_PASSWORD, port),
            query: (sql, params) => superuserQuery(port, sql, params),
            stop,
        };
    } catch (error) {
        const log = readLog(logFile);
        await stop();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `startPlatformDatabase: ${message}${log ? `\n--- postgres.log ---\n${log}` : ''}`,
        );
    }
}
