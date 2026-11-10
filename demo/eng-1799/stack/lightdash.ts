// ENG-1799 demo: the Lightdash backend's throwaway Postgres, its migrations and its environment.
//
//   node --import tsx stack/lightdash.ts prepare --dir <.state/lightdash> --s3-url <url> --ready-file <file>
//       Creates a fresh cluster in <dir>/pgdata (any earlier one is removed: every up.sh starts from an empty
//       Lightdash), listening on 127.0.0.1 only at a free port with no unix socket; picks a free port for the
//       backend; writes <dir>/lightdash.env (mode 0600), the backend's whole environment (KEY=value lines, see
//       backendEnv below, so nothing of up.sh's environment leaks in); then writes the ready file atomically:
//       {"lightdash": {url, port}, "lightdashDb": {host, port, user, password, database}}.
//   node --import tsx stack/lightdash.ts migrate --env-file <dir>/lightdash.env --pid <postgres pid>
//       Waits until that cluster accepts connections (exits 1 if the pid dies first), creates the lightdash
//       database and applies every non-ee knex migration and graphile-worker's (stack/lightdash-migrate.ts, run in
//       packages/backend with the backend's env). About 10 s.
//
// up.sh runs `postgres -D <dir>/pgdata` between the two steps and then the backend (stack/lightdash-server.ts in
// packages/backend, with exactly the env file), each in its own process group with its pid in stack.json. The backend runs the scheduler worker in-process (SCHEDULER_ENABLED=true), and with it the alerting
// module's self-rescheduling `alertingTick`, so GET /api/v1/alerting/health turns "ok" after the first cycle.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { RESULTS_BUCKET } from './results-s3.js';

const HOST = '127.0.0.1';
const ROOT = path.resolve(__dirname, '../../..');
const BACKEND = path.join(ROOT, 'packages/backend');
const MIGRATE_ENTRY = path.join(__dirname, 'lightdash-migrate.ts');
const MIGRATE_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 30_000;

const DATABASE = 'lightdash';
/** Superuser of a throwaway local cluster; not a real credential. */
const ADMIN = { user: 'lightdash', password: 'demo-lightdash-db-password-not-real' } as const;
/** Fixed, non-secret demo value: it only encrypts the throwaway database's stored credentials. */
const LIGHTDASH_SECRET = 'eng-1799-demo-lightdash-secret-not-real';
/**
 * The incident.io Contact Point's bearer token (demo/eng-1799/alerting/contact-points/incident-io.yml refers to it as
 * `secretRef: demo-incident-io-token`; the alerting module reads ALERTING_SECRET_<NAME>). The fake receiver accepts any
 * non-empty token, so this is a fixed, non-secret demo value.
 */
const ALERTING_SECRETS = { ALERTING_SECRET_DEMO_INCIDENT_IO_TOKEN: 'demo-incident-io-token-not-real' } as const;
const S3 = { bucket: RESULTS_BUCKET, region: 'us-east-1', accessKey: 'AKIDDEMOLIGHTDASHNOTREAL', secretKey: 'demo-s3-secret-not-real' };

const PG_BIN = process.env.DEMO_PG_BIN ?? (existsSync('/opt/homebrew/bin/initdb') ? '/opt/homebrew/bin' : '');
const pgBin = (name: string) => (PG_BIN ? path.join(PG_BIN, name) : name);

const connectionUri = (port: number, database = DATABASE) =>
    `postgres://${ADMIN.user}:${encodeURIComponent(ADMIN.password)}@${HOST}:${port}/${database}`;

/** n distinct free ports: all listeners are open at once, so no two can be the same. */
async function freePorts(n: number): Promise<number[]> {
    const servers = await Promise.all(
        Array.from(
            { length: n },
            () =>
                new Promise<net.Server>((resolve, reject) => {
                    const srv = net.createServer();
                    srv.once('error', reject);
                    srv.listen(0, HOST, () => resolve(srv));
                }),
        ),
    );
    const ports = servers.map((s) => (s.address() as net.AddressInfo).port);
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    return ports;
}

/**
 * The backend's whole environment. Phone-home features are off: no Rudderstack analytics, no Docker Hub update
 * check, no chart-registry fetch, no Headway changelog widget in the UI; Sentry, Intercom, Pylon and PostHog stay
 * unconfigured (they are off unless their keys are set). AWS calls without an explicit endpoint cannot reach the
 * instance metadata service.
 */
function backendEnv(extra: Record<string, string>): Record<string, string> {
    return {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TZ: 'UTC',
        NODE_ENV: 'development',
        LIGHTDASH_SECRET,
        LIGHTDASH_LOG_LEVEL: 'info',
        RUDDERSTACK_ANALYTICS_DISABLED: 'true',
        LIGHTDASH_DISABLE_UPDATE_CHECK: 'true',
        LIGHTDASH_CHART_REGISTRY_URL: '',
        HEADWAY_ENABLED: 'false',
        AWS_EC2_METADATA_DISABLED: 'true',
        ...extra,
    };
}

function s3Env(url: string): Record<string, string> {
    const common = {
        ENDPOINT: url,
        BUCKET: S3.bucket,
        REGION: S3.region,
        ACCESS_KEY: S3.accessKey,
        SECRET_KEY: S3.secretKey,
        FORCE_PATH_STYLE: 'true',
    };
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(common)) {
        env[`S3_${name}`] = value;
        env[`RESULTS_S3_${name}`] = value;
    }
    return env;
}

const envFileText = (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) {
        if (/[\r\n]/.test(v)) throw new Error(`env value of ${k} has a line break`);
    }
    return `${Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')}\n`;
};

function writeAtomic(file: string, text: string, mode = 0o600): void {
    writeFileSync(`${file}.tmp`, text, { mode });
    renameSync(`${file}.tmp`, file);
}

function initCluster(data: string, port: number): void {
    const dir = path.dirname(data);
    const pwfile = path.join(dir, 'pwfile');
    writeFileSync(pwfile, ADMIN.password, { mode: 0o600 });
    try {
        execFileSync(
            pgBin('initdb'),
            ['-D', data, '-U', ADMIN.user, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C', '--no-sync', `--pwfile=${pwfile}`],
            { stdio: ['ignore', 'ignore', 'inherit'] },
        );
    } finally {
        rmSync(pwfile, { force: true });
    }
    appendFileSync(
        path.join(data, 'postgresql.conf'),
        [
            '',
            '# ENG-1799 demo Lightdash database (throwaway)',
            `listen_addresses = '${HOST}'`,
            "unix_socket_directories = ''",
            'fsync = off',
            'synchronous_commit = off',
            'full_page_writes = off',
            'max_connections = 100',
            `port = ${port}`,
            '',
        ].join('\n'),
    );
}

async function waitForDatabase(port: number, database: string, alive: () => boolean): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
        const client = new pg.Client({ connectionString: connectionUri(port, database) });
        client.on('error', () => undefined);
        try {
            await client.connect();
            await client.end();
            return;
        } catch (e) {
            await client.end().catch(() => undefined);
            if (!alive()) throw new Error('postgres exited before it accepted connections');
            if (Date.now() > deadline) throw e;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

async function prepare(dir: string, s3Url: string, readyFile: string): Promise<void> {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const [dbPort, port] = await freePorts(2);
    initCluster(path.join(dir, 'pgdata'), dbPort);
    const url = `http://127.0.0.1:${port}`;
    const home = path.join(dir, 'home');
    mkdirSync(home);
    writeAtomic(
        path.join(dir, 'lightdash.env'),
        envFileText(
            backendEnv({
                HOME: home,
                PORT: String(port),
                SITE_URL: url,
                PGCONNECTIONURI: connectionUri(dbPort),
                SCHEDULER_ENABLED: 'true',
                ...ALERTING_SECRETS,
                ...s3Env(s3Url),
            }),
        ),
    );
    writeAtomic(
        readyFile,
        `${JSON.stringify(
            {
                lightdash: { url, port },
                lightdashDb: { host: HOST, port: dbPort, user: ADMIN.user, password: ADMIN.password, database: DATABASE },
            },
            null,
            2,
        )}\n`,
    );
}

function readEnvFile(file: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (m) env[m[1]] = m[2];
    }
    return env;
}

async function migrate(envFile: string, pid: number): Promise<void> {
    const env = readEnvFile(envFile);
    const port = Number(new URL(env.PGCONNECTIONURI ?? '').port);
    await waitForDatabase(port, 'postgres', () => pidAlive(pid));
    const admin = new pg.Client({ connectionString: connectionUri(port, 'postgres') });
    await admin.connect();
    try {
        await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
        await admin.end();
    }
    const result = spawnSync(process.execPath, ['--import', 'tsx', MIGRATE_ENTRY], {
        cwd: BACKEND,
        env: { ...env, LIGHTDASH_LOG_LEVEL: 'warn' },
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: MIGRATE_TIMEOUT_MS,
    });
    if (result.status !== 0) {
        throw new Error(`the Lightdash migrations failed (${result.signal ?? `exit ${result.status}`})`);
    }
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

const [command, ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
    args: rest,
    options: {
        dir: { type: 'string' },
        's3-url': { type: 'string' },
        'ready-file': { type: 'string' },
        'env-file': { type: 'string' },
        pid: { type: 'string' },
    },
});

async function main(): Promise<void> {
    if (command === 'prepare') {
        if (!args.dir || !args['s3-url'] || !args['ready-file']) throw new Error('prepare needs --dir, --s3-url and --ready-file');
        await prepare(path.resolve(args.dir), args['s3-url'], path.resolve(args['ready-file']));
    } else if (command === 'migrate') {
        const pid = Number(args.pid);
        if (!args['env-file'] || !Number.isInteger(pid)) throw new Error('migrate needs --env-file and --pid');
        await migrate(path.resolve(args['env-file']), pid);
    } else {
        throw new Error(`unknown command '${command ?? ''}' (prepare | migrate)`);
    }
}

main().catch((e: unknown) => {
    console.error(`lightdash: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
