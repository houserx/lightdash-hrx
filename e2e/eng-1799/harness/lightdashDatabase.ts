/**
 * Throwaway Postgres clusters for the booted Lightdash backend (lightdash.ts).
 *
 * Migrating Lightdash's database (500+ knex migrations plus graphile-worker's) is the slow part of
 * a boot, so it happens once: a migrated **template cluster** is kept in
 * `tmp/lightdash-template/<key>/pgdata`, where `<key>` hashes everything the migrated schema
 * depends on (the migration files, graphile-worker's version, the Postgres version). Every boot
 * clones that directory (APFS clone, so near-instant) into its own `tmp/e2e/lightdash-…/pgdata`
 * and starts it on a free port. A changed migration gives a new key and a fresh template; older
 * templates are removed then. A template being built lives under `tmp/e2e/` until it is complete,
 * so init.sh reaps one left behind by a killed run.
 */
import { execFile, fork } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { REPO_ROOT, freePort, scratchDir, sleep } from './util';

const run = promisify(execFile);

const PG_BIN = process.env.E2E_PG_BIN ?? '/opt/homebrew/bin';
const HOST = '127.0.0.1';
const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'test-superuser-password-not-real';
export const LIGHTDASH_DATABASE = 'lightdash';

export const BACKEND_DIR = path.join(REPO_ROOT, 'packages/backend');
const MIGRATIONS_DIR = path.join(BACKEND_DIR, 'src/database/migrations');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'tmp/lightdash-template');
export const SERVER_ENTRY = path.join(__dirname, 'lightdashServer.ts');

/** Bump when the template's layout or the migrate step changes. */
const TEMPLATE_FORMAT = 1;
const MIGRATE_TIMEOUT_MS = 600_000;

export type LightdashCluster = {
    port: number;
    /** `postgres://postgres:…@127.0.0.1:<port>/lightdash` */
    connectionUri: string;
    dir: string;
    /** Fast shutdown (immediate as a fallback); removes the directory. Idempotent. */
    stop(): Promise<void>;
};

const pgCtl = path.join(PG_BIN, 'pg_ctl');

const connectionUri = (port: number, database: string) =>
    `postgres://${SUPERUSER}:${SUPERUSER_PASSWORD}@${HOST}:${port}/${database}`;

const tail = (file: string) => {
    try {
        return fs.readFileSync(file, 'utf8').slice(-6_000);
    } catch {
        return '';
    }
};

async function stopCluster(data: string): Promise<void> {
    if (!fs.existsSync(path.join(data, 'postmaster.pid'))) return;
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
        run(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop']).catch(
            () => undefined,
        ),
    );
}

async function startCluster(data: string, logFile: string): Promise<number> {
    const port = await freePort();
    fs.appendFileSync(path.join(data, 'postgresql.conf'), `\nport = ${port}\n`);
    await run(pgCtl, ['-D', data, '-l', logFile, '-w', '-t', '60', 'start']);
    const deadline = Date.now() + 30_000;
    for (;;) {
        const client = new pg.Client({
            connectionString: connectionUri(port, 'postgres'),
        });
        client.on('error', () => undefined);
        try {
            // eslint-disable-next-line no-await-in-loop
            await client.connect();
            // eslint-disable-next-line no-await-in-loop
            await client.end();
            return port;
        } catch (error) {
            // eslint-disable-next-line no-await-in-loop
            await client.end().catch(() => undefined);
            if (Date.now() > deadline) throw error;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
    }
}

function templateKey(pgVersion: string): string {
    const hash = crypto.createHash('sha256');
    hash.update(`format ${TEMPLATE_FORMAT}\n${pgVersion}\n`);
    const graphile = JSON.parse(
        fs.readFileSync(
            path.join(BACKEND_DIR, 'node_modules/graphile-worker/package.json'),
            'utf8',
        ),
    ).version;
    hash.update(`graphile-worker ${graphile}\n`);
    // Recursive: migrations may import helpers from subfolders.
    const files = (
        fs.readdirSync(MIGRATIONS_DIR, { recursive: true }) as string[]
    )
        .filter((file) => fs.statSync(path.join(MIGRATIONS_DIR, file)).isFile())
        .sort();
    for (const file of files) {
        hash.update(`${file}\n`);
        hash.update(fs.readFileSync(path.join(MIGRATIONS_DIR, file)));
    }
    return hash.digest('hex').slice(0, 16);
}

/** Runs lightdashServer.ts `migrate` against `uri` with `env`. */
function runMigrate(
    env: NodeJS.ProcessEnv,
    uri: string,
    logFile: string,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const out = fs.openSync(logFile, 'a');
        const child = fork(SERVER_ENTRY, ['migrate'], {
            cwd: BACKEND_DIR,
            env: { ...env, PGCONNECTIONURI: uri },
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', out, out, 'ipc'],
        });
        const timer = setTimeout(
            () => child.kill('SIGKILL'),
            MIGRATE_TIMEOUT_MS,
        );
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            fs.closeSync(out);
            if (code === 0) resolve();
            else
                reject(
                    new Error(
                        `Lightdash migrations failed (${signal ?? `exit ${code}`})\n${tail(logFile)}`,
                    ),
                );
        });
    });
}

async function buildTemplate(
    target: string,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    const dir = scratchDir('lightdash-template-build');
    const data = path.join(dir, 'pgdata');
    const logFile = path.join(dir, 'build.log');
    const pwfile = path.join(dir, 'pwfile');
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
        fs.appendFileSync(
            path.join(data, 'postgresql.conf'),
            `\nlisten_addresses = '${HOST}'\nunix_socket_directories = ''\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\nmax_connections = 100\n`,
        );
        const port = await startCluster(data, logFile);
        const admin = new pg.Client({
            connectionString: connectionUri(port, 'postgres'),
        });
        await admin.connect();
        try {
            await admin.query(`CREATE DATABASE ${LIGHTDASH_DATABASE}`);
        } finally {
            await admin.end();
        }
        await runMigrate(env, connectionUri(port, LIGHTDASH_DATABASE), logFile);
        await stopCluster(data);
        fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
        try {
            fs.renameSync(dir, target);
        } catch (error) {
            // Another run finished the same template first: use theirs.
            if (!fs.existsSync(path.join(target, 'pgdata'))) throw error;
        }
    } finally {
        await stopCluster(data);
        fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const other of fs.readdirSync(TEMPLATES_DIR)) {
        const otherDir = path.join(TEMPLATES_DIR, other);
        if (otherDir !== target) {
            fs.rmSync(otherDir, { recursive: true, force: true });
        }
    }
}

let template: Promise<string> | undefined;

/**
 * The migrated template's pgdata, built on first use (once per test process, and reused by
 * later runs while the migrations are unchanged). `env` is the backend env the migrate step
 * runs with (its config must parse).
 */
export function migratedTemplate(env: NodeJS.ProcessEnv): Promise<string> {
    template ??= (async () => {
        const { stdout } = await run(path.join(PG_BIN, 'postgres'), [
            '--version',
        ]);
        const target = path.join(TEMPLATES_DIR, templateKey(stdout.trim()));
        if (!fs.existsSync(path.join(target, 'pgdata', 'PG_VERSION'))) {
            await buildTemplate(target, env);
        }
        return path.join(target, 'pgdata');
    })();
    template.catch(() => {
        template = undefined;
    });
    return template;
}

/** A new cluster cloned from the migrated template, started on a free port. */
export async function startLightdashCluster(
    templateData: string,
): Promise<LightdashCluster> {
    if (!fs.existsSync(pgCtl)) {
        throw new Error(
            `startLightdash: no pg_ctl at ${pgCtl} (set E2E_PG_BIN)`,
        );
    }
    const dir = scratchDir('lightdash');
    const data = path.join(dir, 'pgdata');
    const logFile = path.join(dir, 'postgres.log');
    let stopping: Promise<void> | undefined;
    const stop = () => {
        stopping ??= (async () => {
            await stopCluster(data);
            fs.rmSync(dir, { recursive: true, force: true });
        })();
        return stopping;
    };
    try {
        // -c: clonefile(2) on APFS; plain copy where cloning is unsupported.
        await run('cp', ['-cR', templateData, data]).catch(() =>
            run('cp', ['-R', templateData, data]),
        );
        const port = await startCluster(data, logFile);
        return {
            port,
            connectionUri: connectionUri(port, LIGHTDASH_DATABASE),
            dir,
            stop,
        };
    } catch (error) {
        const log = tail(logFile);
        await stop();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `startLightdash: Postgres did not start: ${message}${log ? `\n--- postgres.log ---\n${log}` : ''}`,
        );
    }
}
