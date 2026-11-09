/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Mock Lightdash API + CLI process runner for the alerting CLI acceptance tests.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';

export const PROJECT_UUID = '3f0a4f8e-0000-4000-8000-0000000000aa';
const CLI_ROOT = path.resolve(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CLI_VERSION: string = require(
    path.join(CLI_ROOT, 'package.json'),
).version;

export type Recorded = {
    method: string;
    path: string;
    body: any;
    headers: http.IncomingHttpHeaders;
};
type Handler = (
    r: Recorded,
) => { status?: number; results?: unknown } | undefined;

export const startMockLightdash = async (
    handler: Handler = () => undefined,
) => {
    const requests: Recorded[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: any;
            try {
                body = text ? JSON.parse(text) : undefined;
            } catch {
                body = text;
            }
            const r = {
                method: req.method ?? '',
                path: req.url ?? '',
                body,
                headers: req.headers,
            };
            requests.push(r);
            const custom = handler(r);
            let status = 200;
            let results: unknown = {};
            if (custom) {
                status = custom.status ?? 200;
                results = custom.results;
            } else if (r.path.startsWith('/api/v1/health')) {
                results = {
                    version: CLI_VERSION,
                    mode: 'default',
                    isAuthenticated: true,
                    requiresOrgRegistration: false,
                    latest: { version: CLI_VERSION },
                };
            } else if (
                r.path.startsWith(`/api/v1/projects/${PROJECT_UUID}`) &&
                r.path.split('?')[0] === `/api/v1/projects/${PROJECT_UUID}`
            ) {
                results = {
                    projectUuid: PROJECT_UUID,
                    organizationUuid: '3f0a4f8e-0000-4000-8000-0000000000bb',
                    name: 'Operations',
                    type: 'DEFAULT',
                    dbtVersion: 'v1.9',
                    warehouseConnection: { type: 'postgres' },
                };
            }
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify(
                    status >= 400
                        ? {
                              status: 'error',
                              error: {
                                  statusCode: status,
                                  name: 'Error',
                                  message: String(results),
                              },
                          }
                        : { status: 'ok', results },
                ),
            );
        });
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve()),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        url,
        requests,
        alerting: (suffix: string, method?: string) =>
            requests.filter(
                (r) =>
                    r.path.split('?')[0] ===
                        `/api/v2/projects/${PROJECT_UUID}/alerting${suffix}` &&
                    (!method || r.method === method),
            ),
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            }),
    };
};

export type CliResult = { code: number | null; stdout: string; stderr: string };

export const runCli = (
    args: string[],
    serverUrl: string,
    home: string,
    cwd?: string,
) =>
    new Promise<CliResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: home,
            LIGHTDASH_URL: serverUrl,
            LIGHTDASH_API_KEY: 'test-pat-not-real',
            CI: 'true',
            FORCE_COLOR: '0',
            NO_COLOR: '1',
        };
        delete env.LIGHTDASH_PROJECT;
        delete env.LIGHTDASH_AGENT_CONNECTION;
        delete env.LIGHTDASH_PROXY_AUTHORIZATION;
        const child = spawn(
            process.execPath,
            [
                '--import',
                require.resolve('tsx'),
                path.join(CLI_ROOT, 'src/index.ts'),
                ...args,
            ],
            { cwd: cwd ?? home, env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`CLI timed out: ${args.join(' ')}`));
        }, 90_000);
        child.stdout.on('data', (d) => {
            stdout += String(d);
        });
        child.stderr.on('data', (d) => {
            stderr += String(d);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });

export const tempDir = async () => {
    // Inside the repo's gitignored tmp/, not the system temp dir.
    const base = path.resolve(CLI_ROOT, '../../tmp/alerting-cli');
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, 'run-'));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

export const ruleDoc = {
    version: 1,
    type: 'alert_rule',
    slug: 'rds-free-storage-low',
    name: 'RDS free storage low',
    description: 'Pages when an RDS instance has less than 10% free storage',
    spaceSlug: 'platform',
    labels: { team: 'infra' },
    annotations: { summary: 'RDS free storage low' },
    query: 'SELECT instance, value FROM rds_free_storage',
    valueColumn: 'value',
    reducer: 'last',
    condition: { operator: '<', threshold: 10 },
    for: '5m',
    keepFiringFor: '0s',
    interval: '1m',
    timeRange: '10m',
    noDataState: 'nodata',
    errorState: 'error',
    paused: false,
    shadow: true,
};
export const contactPointDoc = {
    version: 1,
    type: 'contact_point',
    slug: 'incident-io',
    name: 'Grafana Alerts (incident.io)',
    integrations: [
        {
            type: 'incident_io',
            url: 'https://incident.example.test/v2/alert_events/x',
            token: { secretRef: 'incident-io-grafana' },
        },
    ],
};
export const slackDoc = {
    version: 1,
    type: 'contact_point',
    slug: 'slack-infra-alerts',
    name: 'slack-infra-alerts',
    integrations: [
        {
            type: 'slack_webhook',
            url: { secretRef: 'slack-infra-alerts-webhook' },
        },
    ],
};
export const routesDoc = {
    version: 1,
    type: 'notification_routes',
    contactPoint: 'slack-infra-alerts',
    groupBy: ['...'],
    routes: [
        {
            matchers: [{ label: 'team', operator: '=', value: 'infra' }],
            contactPoint: 'incident-io',
        },
    ],
};
