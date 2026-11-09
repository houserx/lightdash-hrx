// ENG-1799 demo: write the Federation Engine's config under .state (run by up.sh before it starts the engine).
//
//   node --import tsx stack/engine-config.ts --dir <.state/engine> --platform-file <.state/run/platform-db.json> \
//       --ready-file <.state/run/engine-config.json>
//
// Picks free 127.0.0.1 ports for the engine (pg-wire, HTTP) and for every endpoint the engine is pointed at,
// then writes into --dir:
//   federation-engine.toml  one source per demo Telemetry Source (prometheus, loki, tempo, cloudwatch,
//                           cloudwatch-logs) plus the Platform Database (platform_postgres, read + write
//                           roles), and the [audit] block (fake DynamoDB + S3) that platform_postgres requires;
//   engine.env              the engine's whole environment (mode 0600): fake secrets, fake AWS credentials,
//                           the Platform Database URLs; up.sh starts the engine with exactly this environment;
//   home/                   the engine's HOME and TMPDIR (nothing of the user's leaks in).
// and the ready file: {"engine": {host, pgPort, httpUrl, user, password, database, identitySecret},
//                      "endpoints": {prometheus, loki, tempo, cloudwatch, cloudwatchLogs, auditDynamodb, auditS3}}.
//
// The endpoint ports are reservations: the fakes that serve them (later demo features) must listen exactly
// there. Until they do, /healthz reports those sources unreachable (503) and the engine still runs.
// Every secret here is a fake (`...-not-real`); nothing reaches a real service.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';

const HOST = '127.0.0.1';

/** pg-wire login of the demo (the Operations Project's connection). */
const ENGINE_USER = 'lightdash-operations';
const ENGINE_DATABASE = 'operations';
const ENGINE_PASSWORD = 'demo-engine-password-not-real';
const IDENTITY_SECRET = 'demo-identity-secret-not-real';
const AUDIT_INTEGRITY_KEY = 'demo-audit-integrity-key-not-real';
const AUDIT_TABLE = 'demo-federation-audit';
const AUDIT_BUCKET = 'demo-federation-audit';
const AWS_REGION = 'us-east-2';

const ENDPOINTS = ['prometheus', 'loki', 'tempo', 'cloudwatch', 'cloudwatchLogs', 'auditDynamodb', 'auditS3'] as const;
type EndpointName = (typeof ENDPOINTS)[number];

type PlatformDb = {
    host: string;
    port: number;
    database: string;
    roles: { read: { user: string; password: string }; write: { user: string; password: string } };
};

const { values: args } = parseArgs({
    options: {
        dir: { type: 'string' },
        'platform-file': { type: 'string' },
        'ready-file': { type: 'string' },
    },
});
const dir = args.dir;
const platformFile = args['platform-file'];
const readyFile = args['ready-file'];
if (!dir || !platformFile || !readyFile) {
    console.error('engine-config: --dir, --platform-file and --ready-file are required');
    process.exit(2);
}

/** n distinct free ports: all listeners are open at once, so no two can be the same. */
async function freePorts(n: number): Promise<number[]> {
    const servers = await Promise.all(
        Array.from(
            { length: n },
            () =>
                new Promise<net.Server>((resolve, reject) => {
                    const s = net.createServer();
                    s.once('error', reject);
                    s.listen(0, HOST, () => resolve(s));
                }),
        ),
    );
    const ports = servers.map((s) => (s.address() as net.AddressInfo).port);
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    return ports;
}

const toml = (value: string) => JSON.stringify(value);

const pgUrl = (p: PlatformDb, role: { user: string; password: string }) =>
    `postgres://${encodeURIComponent(role.user)}:${encodeURIComponent(role.password)}@${p.host}:${p.port}/${encodeURIComponent(p.database)}`;

function renderConfig(pgPort: number, httpPort: number, urls: Record<EndpointName, string>): string {
    return `# Written by demo/eng-1799/stack/engine-config.ts on every fresh up.sh; edits are overwritten.
listen_pg = "${HOST}:${pgPort}"
listen_http = "${HOST}:${httpPort}"
identity_secret_env = "HRX_IDENTITY_SECRET"

[[users]]
name = ${toml(ENGINE_USER)}
password_env = "HRX_PG_PASSWORD_OPERATIONS"

[[sources]]
name = "prometheus"
kind = "prometheus"
url = ${toml(urls.prometheus)}

[[sources]]
name = "loki"
kind = "loki"
url = ${toml(urls.loki)}

[[sources]]
name = "tempo"
kind = "tempo"
url = ${toml(urls.tempo)}

[[sources]]
name = "cloudwatch"
kind = "cloudwatch"
region = ${toml(AWS_REGION)}
endpoint_url = ${toml(urls.cloudwatch)}

[[sources]]
name = "cloudwatch-logs"
kind = "cloudwatch_logs"
region = ${toml(AWS_REGION)}
endpoint_url = ${toml(urls.cloudwatchLogs)}

# The Platform Database: Audited Queries read as engine_read, Write Mode writes as engine_write.
[[sources]]
name = "platform"
kind = "platform_postgres"
read_url_env = "HRX_PLATFORM_READ_URL"
write_url_env = "HRX_PLATFORM_WRITE_URL"

# platform_postgres is audited: the engine refuses the config without [audit], and fails every Audited
# Query closed while this store does not answer. The demo's fake DynamoDB + S3 serve these endpoints.
[audit]
dynamodb_table = ${toml(AUDIT_TABLE)}
s3_bucket = ${toml(AUDIT_BUCKET)}
integrity_key_env = "AUDIT_INTEGRITY_KEY"
region = ${toml(AWS_REGION)}
dynamodb_endpoint_url = ${toml(urls.auditDynamodb)}
s3_endpoint_url = ${toml(urls.auditS3)}
`;
}

async function main(stateDir: string, platformPath: string, readyPath: string): Promise<void> {
    const platform = (JSON.parse(readFileSync(platformPath, 'utf8')) as { platformDb: PlatformDb }).platformDb;
    const home = path.join(stateDir, 'home');
    mkdirSync(home, { recursive: true });

    const [pgPort, httpPort, ...endpointPorts] = await freePorts(2 + ENDPOINTS.length);
    const urls = Object.fromEntries(ENDPOINTS.map((name, i) => [name, `http://${HOST}:${endpointPorts[i]}`])) as Record<
        EndpointName,
        string
    >;

    const env: Record<string, string> = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: home,
        TMPDIR: home,
        HRX_IDENTITY_SECRET: IDENTITY_SECRET,
        HRX_PG_PASSWORD_OPERATIONS: ENGINE_PASSWORD,
        AUDIT_INTEGRITY_KEY,
        HRX_PLATFORM_READ_URL: pgUrl(platform, platform.roles.read),
        HRX_PLATFORM_WRITE_URL: pgUrl(platform, platform.roles.write),
        AWS_ACCESS_KEY_ID: 'AKIDDEMONOTREAL00001',
        AWS_SECRET_ACCESS_KEY: 'demo-aws-secret-key-not-real',
        AWS_REGION,
        AWS_EC2_METADATA_DISABLED: 'true',
        // Paths that do not exist: the AWS SDK must not read the user's AWS config.
        AWS_CONFIG_FILE: path.join(home, 'no-aws-config'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(home, 'no-aws-credentials'),
        // A dead port: any AWS call without an explicit endpoint fails locally instead of reaching AWS.
        AWS_ENDPOINT_URL: `http://${HOST}:9`,
        RUST_LOG: 'info',
    };
    for (const [key, value] of Object.entries(env)) {
        if (/[\n\r]/.test(value)) throw new Error(`engine-config: ${key} contains a newline`);
    }

    const write = (file: string, text: string, mode = 0o644) => {
        writeFileSync(`${file}.tmp`, text, { mode });
        renameSync(`${file}.tmp`, file);
    };
    write(path.join(stateDir, 'federation-engine.toml'), renderConfig(pgPort, httpPort, urls));
    write(
        path.join(stateDir, 'engine.env'),
        Object.entries(env)
            .map(([k, v]) => `${k}=${v}\n`)
            .join(''),
        0o600,
    );
    const ready = {
        engine: {
            host: HOST,
            pgPort,
            httpUrl: `http://${HOST}:${httpPort}`,
            user: ENGINE_USER,
            password: ENGINE_PASSWORD,
            database: ENGINE_DATABASE,
            identitySecret: IDENTITY_SECRET,
        },
        endpoints: urls,
    };
    write(readyPath, `${JSON.stringify(ready, null, 2)}\n`, 0o600);
}

main(dir, platformFile, readyFile).catch((e: unknown) => {
    console.error('engine-config: failed:', e instanceof Error ? e.message : e);
    process.exit(1);
});
