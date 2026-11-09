/**
 * Starts the real Federation Engine binary (built by init.sh into tmp/cargo-target) with a
 * generated config on ephemeral 127.0.0.1 ports, and stops it without leftovers.
 *
 * Mirrors the engine line's Rust harness (federation-engine/tests/acceptance/harness/engine.rs):
 * a cleared environment with only PATH, a private HOME, fake AWS credentials and the test secrets,
 * and `AWS_ENDPOINT_URL` at a dead port so nothing can reach real AWS.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    AUDIT_BUCKET,
    AUDIT_TABLE,
    type FakeAuditStore,
    startFakeAuditStore,
} from './auditStore';
import { freePorts, REPO_ROOT, scratchDir, sleep, tcpOpen } from './util';

export const ENGINE_BINARY =
    process.env.E2E_ENGINE_BINARY ??
    path.join(REPO_ROOT, 'tmp/cargo-target/debug/engine');

export const ENGINE_HOST = '127.0.0.1';
export const ENGINE_USER = 'lightdash-operations';
export const ENGINE_DATABASE = 'operations';
export const ENGINE_PASSWORD = 'test-password-not-real';
export const IDENTITY_SECRET = 'test-identity-secret-not-real';
export const AUDIT_INTEGRITY_KEY = 'test-integrity-key-not-real';

const START_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 10_000;

export type StartEngineOptions = {
    /** Top-level `max_rows`. */
    maxRows?: number;
    /** `test_mode` (default true). */
    testMode?: boolean;
    /** A fake Prometheus: the default `prometheus` source points at its `url`. */
    prometheus?: { url: string };
    /** A fake Loki: the `loki` source points at its `url`. */
    loki?: { url: string };
    /** A fake Tempo: the `tempo` source points at its `url`. */
    tempo?: { url: string };
    /**
     * A fake CloudWatch: the `cloudwatch` source (region `us-east-2`) points `endpoint_url` at
     * its `url`; the engine signs with the fake AWS credentials of the environment.
     */
    cloudwatch?: { url: string };
    /**
     * A Platform Database: the `platform` source reads through `readUrl` and writes through
     * `writeUrl` (Write Mode is off without it), passed as `HRX_PLATFORM_READ_URL` /
     * `HRX_PLATFORM_WRITE_URL`.
     */
    platform?: { readUrl: string; writeUrl?: string };
    /**
     * The `[audit]` store's endpoints. `[audit]` is always configured: without this option the
     * harness starts its own fake store, returns it as `engine.auditStore` and closes it on
     * `stop()`.
     */
    auditStore?: { dynamodbUrl: string; s3Url: string };
};

/** Options the Harness API names that later harness features implement. */
const NOT_YET_SUPPORTED = [
    'cloudwatchLogs',
    'bigquery',
    'restrictedLokiSelectors',
    'restrictedLogGroups',
];

export type Engine = {
    host: string;
    pgPort: number;
    httpUrl: string;
    user: string;
    password: string;
    database: string;
    pid: number;
    binary: string;
    configToml: string;
    /** The `[audit]` store: `opts.auditStore` when given, else the harness's own fake. */
    auditStore: { dynamodbUrl: string; s3Url: string } | FakeAuditStore;
    /** SIGTERM, wait for exit (SIGKILL after a grace period), remove the scratch dir. Idempotent. */
    stop(): Promise<void>;
};

function engineEnv(dir: string, opts: StartEngineOptions): NodeJS.ProcessEnv {
    const platform: NodeJS.ProcessEnv = {};
    if (opts.platform) {
        platform.HRX_PLATFORM_READ_URL = opts.platform.readUrl;
        if (opts.platform.writeUrl) {
            platform.HRX_PLATFORM_WRITE_URL = opts.platform.writeUrl;
        }
    }
    return {
        ...platform,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: dir,
        TMPDIR: dir,
        HRX_IDENTITY_SECRET: IDENTITY_SECRET,
        HRX_PG_PASSWORD_OPERATIONS: ENGINE_PASSWORD,
        AUDIT_INTEGRITY_KEY,
        AWS_ACCESS_KEY_ID: 'AKIDTESTNOTREAL00001',
        AWS_SECRET_ACCESS_KEY: 'test-aws-secret-key-not-real',
        AWS_REGION: 'us-east-2',
        AWS_EC2_METADATA_DISABLED: 'true',
        // Paths that do not exist: the SDK must not read the user's AWS config.
        AWS_CONFIG_FILE: path.join(dir, 'no-aws-config'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'no-aws-credentials'),
        AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
        RUST_BACKTRACE: '1',
    };
}

/** A TOML basic string. */
const tomlString = (value: string) => JSON.stringify(value);

function renderConfig(
    pgPort: number,
    httpPort: number,
    opts: StartEngineOptions,
    audit: { dynamodbUrl: string; s3Url: string },
): string {
    const top = [
        `listen_pg = "${ENGINE_HOST}:${pgPort}"`,
        `listen_http = "${ENGINE_HOST}:${httpPort}"`,
        'identity_secret_env = "HRX_IDENTITY_SECRET"',
        `test_mode = ${opts.testMode === false ? 'false' : 'true'}`,
    ];
    if (opts.maxRows !== undefined) {
        if (!Number.isInteger(opts.maxRows) || opts.maxRows < 0) {
            throw new Error(`startEngine: bad maxRows ${opts.maxRows}`);
        }
        top.push(`max_rows = ${opts.maxRows}`);
    }
    const tables = [
        `[[users]]\nname = "${ENGINE_USER}"\npassword_env = "HRX_PG_PASSWORD_OPERATIONS"\n`,
    ];
    if (opts.prometheus) {
        // `prometheus-restricted` is Restricted Telemetry at the same fake: every query on it is
        // an Audited Query (the engine needs `[audit]` for it, which is always configured).
        const url = tomlString(opts.prometheus.url);
        tables.push(
            `[[sources]]\nname = "prometheus"\nkind = "prometheus"\ndefault = true\nurl = ${url}\n`,
            `[[sources]]\nname = "prometheus-restricted"\nkind = "prometheus"\nrestricted = true\nurl = ${url}\n`,
        );
    }
    if (opts.loki) {
        tables.push(
            `[[sources]]\nname = "loki"\nkind = "loki"\nurl = ${tomlString(opts.loki.url)}\n`,
        );
    }
    if (opts.tempo) {
        tables.push(
            `[[sources]]\nname = "tempo"\nkind = "tempo"\nurl = ${tomlString(opts.tempo.url)}\n`,
        );
    }
    if (opts.cloudwatch) {
        tables.push(
            `[[sources]]\nname = "cloudwatch"\nkind = "cloudwatch"\nregion = "us-east-2"\nendpoint_url = ${tomlString(opts.cloudwatch.url)}\n`,
        );
    }
    if (opts.platform) {
        const write = opts.platform.writeUrl
            ? 'write_url_env = "HRX_PLATFORM_WRITE_URL"\n'
            : '';
        tables.push(
            `[[sources]]\nname = "platform"\nkind = "platform_postgres"\nread_url_env = "HRX_PLATFORM_READ_URL"\n${write}`,
        );
    }
    // Always on: the engine refuses every Audited Query without a working store.
    tables.push(
        [
            '[audit]',
            `dynamodb_table = ${tomlString(AUDIT_TABLE)}`,
            `s3_bucket = ${tomlString(AUDIT_BUCKET)}`,
            'integrity_key_env = "AUDIT_INTEGRITY_KEY"',
            'region = "us-east-2"',
            `dynamodb_endpoint_url = ${tomlString(audit.dynamodbUrl)}`,
            `s3_endpoint_url = ${tomlString(audit.s3Url)}`,
            '',
        ].join('\n'),
    );
    return `${top.join('\n')}\n\n${tables.join('\n')}`;
}

const readLog = (file: string) => {
    try {
        return fs.readFileSync(file, 'utf8').slice(-4_000);
    } catch {
        return '';
    }
};

function exited(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        child.once('exit', () => resolve());
    });
}

async function healthzAnswers(httpUrl: string): Promise<boolean> {
    try {
        const res = await fetch(`${httpUrl}/healthz`, {
            signal: AbortSignal.timeout(5_000),
        });
        await res.arrayBuffer();
        return true;
    } catch {
        return false;
    }
}

export async function startEngine(
    opts: StartEngineOptions = {},
): Promise<Engine> {
    const unsupported = Object.keys(opts).filter(
        (key) =>
            NOT_YET_SUPPORTED.includes(key) &&
            (opts as Record<string, unknown>)[key] !== undefined,
    );
    if (unsupported.length) {
        throw new Error(
            `startEngine: option(s) ${unsupported.join(', ')} not supported yet`,
        );
    }
    if (!fs.existsSync(ENGINE_BINARY)) {
        throw new Error(
            `startEngine: no engine binary at ${ENGINE_BINARY}; run bash ./init.sh`,
        );
    }

    const [pgPort, httpPort] = await freePorts(2);
    const httpUrl = `http://${ENGINE_HOST}:${httpPort}`;
    const ownAuditStore = opts.auditStore
        ? undefined
        : await startFakeAuditStore();
    const auditStore = opts.auditStore ?? ownAuditStore!;
    let configToml: string;
    try {
        configToml = renderConfig(pgPort, httpPort, opts, auditStore);
    } catch (error) {
        await ownAuditStore?.close();
        throw error;
    }
    const dir = scratchDir('engine');
    const configPath = path.join(dir, 'federation-engine.toml');
    fs.writeFileSync(configPath, configToml);

    const stdoutPath = path.join(dir, 'stdout.log');
    const stderrPath = path.join(dir, 'stderr.log');
    const stdout = fs.openSync(stdoutPath, 'w');
    const stderr = fs.openSync(stderrPath, 'w');
    const child = spawn(ENGINE_BINARY, ['--config', configPath], {
        cwd: dir,
        env: engineEnv(dir, opts),
        stdio: ['ignore', stdout, stderr],
    });
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    const exit = exited(child);
    let spawnError: Error | undefined;
    child.once('error', (error) => {
        spawnError = error;
    });

    let stopping: Promise<void> | undefined;
    const stop = () => {
        stopping ??= (async () => {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
                const graceful = await Promise.race([
                    exit.then(() => true),
                    sleep(STOP_GRACE_MS).then(() => false),
                ]);
                if (!graceful) {
                    child.kill('SIGKILL');
                    await exit;
                }
            }
            await ownAuditStore?.close();
            fs.rmSync(dir, { recursive: true, force: true });
        })();
        return stopping;
    };

    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
        if (
            spawnError ||
            child.exitCode !== null ||
            child.signalCode !== null
        ) {
            const why = spawnError
                ? `could not spawn: ${spawnError.message}`
                : `exited early (code ${child.exitCode}, signal ${child.signalCode})`;
            const logs = `--- stderr ---\n${readLog(stderrPath)}\n--- stdout ---\n${readLog(stdoutPath)}`;
            // eslint-disable-next-line no-await-in-loop
            await stop();
            throw new Error(`startEngine: engine ${why}\n${logs}`);
        }
        // eslint-disable-next-line no-await-in-loop
        if ((await tcpOpen(pgPort)) && (await healthzAnswers(httpUrl))) break;
        if (Date.now() > deadline) {
            const logs = readLog(stderrPath);
            // eslint-disable-next-line no-await-in-loop
            await stop();
            throw new Error(
                `startEngine: engine not answering on pg ${pgPort} and http ${httpPort} after ${START_TIMEOUT_MS / 1000}s\n--- stderr ---\n${logs}`,
            );
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
    }

    return {
        host: ENGINE_HOST,
        pgPort,
        httpUrl,
        user: ENGINE_USER,
        password: ENGINE_PASSWORD,
        database: ENGINE_DATABASE,
        pid: child.pid!,
        binary: ENGINE_BINARY,
        configToml,
        auditStore,
        stop,
    };
}
