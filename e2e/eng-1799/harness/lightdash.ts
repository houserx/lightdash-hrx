/**
 * `startLightdash({ engine, env? })` (Harness API): the real Lightdash backend, fully booted.
 *
 * Each call:
 *   1. clones the migrated template cluster (lightdashDatabase.ts) into `tmp/e2e/lightdash-…`
 *      and starts it on a free port;
 *   2. starts a fake S3 (s3.ts) for results and exports storage;
 *   3. forks lightdashServer.ts (`node --import tsx`, cwd packages/backend) with a minimal env
 *      plus `env`. The child seeds one organization, an admin user with a personal access token,
 *      the **Operations Project** (no dbt; federation-flavour Postgres connection to `engine`,
 *      `identitySigningSecret` = the engine's secret, `httpBaseUrl` = `engine.httpUrl`) and a
 *      space, then starts the App on a free 127.0.0.1 port and reports over IPC.
 *
 * The scheduler worker is off (`SCHEDULER_ENABLED=false`): later checks drive alerting cycles
 * explicitly. A fresh process per boot means each boot parses its own config from its own env.
 */
import { fork, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Engine } from './engine';
import { IDENTITY_SECRET } from './engine';
import {
    BACKEND_DIR,
    SERVER_ENTRY,
    migratedTemplate,
    startLightdashCluster,
    type LightdashCluster,
} from './lightdashDatabase';
import { startFakeS3, type FakeS3 } from './s3';
import { REPO_ROOT, freePort } from './util';

const HOST = '127.0.0.1';
const BOOT_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 15_000;

/** A fixed, non-secret test value: it only encrypts the throwaway database's credentials. */
const LIGHTDASH_SECRET = 'eng-1799-e2e-lightdash-secret-not-real';
const S3_BUCKET = 'eng-1799-e2e-lightdash';
const S3_REGION = 'us-east-1';
const USER_EMAIL = 'e2e.admin@example.test';

export type StartLightdashOptions = {
    engine: Pick<
        Engine,
        'host' | 'pgPort' | 'httpUrl' | 'user' | 'password' | 'database'
    >;
    /** Extra backend env (wins over the harness's). */
    env?: Record<string, string>;
};

export type Lightdash = {
    /** `http://127.0.0.1:<port>` */
    baseUrl: string;
    mode: 'full-boot' | 'service-layer';
    /** The backend process. */
    pid: number;
    projectUuid: string;
    organizationUuid: string;
    userUuid: string;
    userEmail: string;
    spaceUuid: string;
    /** A personal access token: `Authorization: ApiKey <apiKey>`. */
    apiKey: string;
    s3: FakeS3;
    /**
     * Sets the admin user's own value of each named user attribute through the backend's
     * `/api/v1/org/attributes` API (creating the attribute when the org has none by that name).
     * Other users' values and group values are kept.
     */
    setUserAttributes(attributes: Record<string, string>): Promise<void>;
    /** Stops the backend (SIGTERM, SIGKILL after a grace period), its Postgres and the fake S3. Idempotent. */
    close(): Promise<void>;
};

/** The env the backend runs with: nothing inherited but PATH, so no real credentials leak in. */
function backendEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    return {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: path.join(REPO_ROOT, 'tmp'),
        TZ: 'UTC',
        NODE_ENV: 'development',
        LIGHTDASH_SECRET,
        LIGHTDASH_LOG_LEVEL: 'warn',
        LIGHTDASH_DISABLE_UPDATE_CHECK: 'true',
        RUDDERSTACK_ANALYTICS_DISABLED: 'true',
        SCHEDULER_ENABLED: 'false',
        AWS_EC2_METADATA_DISABLED: 'true',
        ...extra,
    };
}

function s3Env(s3: FakeS3): Record<string, string> {
    const common = {
        ENDPOINT: s3.url,
        BUCKET: S3_BUCKET,
        REGION: S3_REGION,
        ACCESS_KEY: 'AKIDLIGHTDASHS3NOTREAL',
        SECRET_KEY: 'test-s3-secret-not-real',
        FORCE_PATH_STYLE: 'true',
    };
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(common)) {
        env[`S3_${name}`] = value;
        env[`RESULTS_S3_${name}`] = value;
    }
    return env;
}

const tail = (file: string) => {
    try {
        return fs.readFileSync(file, 'utf8').slice(-6_000);
    } catch {
        return '';
    }
};

type ApiUserAttribute = {
    uuid: string;
    name: string;
    description?: string;
    attributeDefaults: string[] | null;
    users: { userUuid: string; values: string[] }[];
    groups: { groupUuid: string; values: string[] }[];
};

/** Calls the backend's API with the personal access token; throws on a non-2xx reply. */
async function callApi<T>(
    baseUrl: string,
    apiKey: string,
    method: string,
    route: string,
    body?: unknown,
): Promise<T> {
    const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
            Authorization: `ApiKey ${apiKey}`,
            ...(body === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(
            `${method} ${route}: HTTP ${response.status}: ${text.slice(0, 500)}`,
        );
    }
    return (JSON.parse(text) as { results: T }).results;
}

async function setUserAttributes(
    baseUrl: string,
    apiKey: string,
    userUuid: string,
    attributes: Record<string, string>,
): Promise<void> {
    const route = '/api/v1/org/attributes';
    const existing = await callApi<ApiUserAttribute[]>(
        baseUrl,
        apiKey,
        'GET',
        route,
    );
    for (const [name, value] of Object.entries(attributes)) {
        const current = existing.find((attribute) => attribute.name === name);
        const users = [
            ...(current?.users ?? [])
                .filter((user) => user.userUuid !== userUuid)
                .map((user) => ({
                    userUuid: user.userUuid,
                    values: user.values,
                })),
            { userUuid, values: [value] },
        ];
        const payload = {
            name,
            description: current?.description,
            attributeDefaults: current?.attributeDefaults ?? null,
            users,
            groups: (current?.groups ?? []).map((group) => ({
                groupUuid: group.groupUuid,
                values: group.values,
            })),
        };
        if (current) {
            await callApi(
                baseUrl,
                apiKey,
                'PUT',
                `${route}/${current.uuid}`,
                payload,
            );
        } else {
            await callApi(baseUrl, apiKey, 'POST', route, payload);
        }
    }
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}

export async function startLightdash(
    opts: StartLightdashOptions,
): Promise<Lightdash> {
    const { engine } = opts;
    // The migrate step needs a config that parses; it never contacts S3.
    const templateData = await migratedTemplate(
        backendEnv({
            S3_ENDPOINT: 'http://127.0.0.1:9',
            S3_BUCKET,
            S3_REGION,
        }),
    );

    let cluster: LightdashCluster | undefined;
    let s3: FakeS3 | undefined;
    let child: ChildProcess | undefined;
    let logFile = '';
    let closing: Promise<void> | undefined;
    const close = () => {
        closing ??= (async () => {
            if (child && child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
                if (!(await waitForExit(child, STOP_GRACE_MS))) {
                    child.kill('SIGKILL');
                    await waitForExit(child, STOP_GRACE_MS);
                }
            }
            await s3?.close();
            await cluster?.stop();
        })();
        return closing;
    };

    try {
        cluster = await startLightdashCluster(templateData);
        s3 = await startFakeS3();
        const port = await freePort();
        const baseUrl = `http://${HOST}:${port}`;
        const apiKey = `ldpat_${crypto.randomBytes(16).toString('hex')}`;
        const seed = {
            organizationName: 'Operations (e2e)',
            userEmail: USER_EMAIL,
            projectName: 'Operations',
            spaceName: 'Operations',
            apiKey,
            warehouseCredentials: {
                type: 'postgres',
                flavor: 'federation',
                host: engine.host ?? HOST,
                port: engine.pgPort,
                user: engine.user,
                password: engine.password,
                dbname: engine.database ?? 'operations',
                schema: 'public',
                sslmode: 'disable',
                identitySigningSecret: IDENTITY_SECRET,
                httpBaseUrl: engine.httpUrl,
            },
        };

        logFile = path.join(cluster.dir, 'lightdash.log');
        const out = fs.openSync(logFile, 'a');
        child = fork(SERVER_ENTRY, ['serve'], {
            cwd: BACKEND_DIR,
            env: backendEnv({
                ...s3Env(s3),
                PGCONNECTIONURI: cluster.connectionUri,
                PORT: String(port),
                SITE_URL: baseUrl,
                E2E_SEED: JSON.stringify(seed),
                ...(opts.env ?? {}),
            }),
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', out, out, 'ipc'],
        });
        fs.closeSync(out);
        const started = child;

        const seeded = await new Promise<{
            organizationUuid: string;
            userUuid: string;
            projectUuid: string;
            spaceUuid: string;
        }>((resolve, reject) => {
            const timer = setTimeout(
                () =>
                    reject(
                        new Error(`no ready message in ${BOOT_TIMEOUT_MS} ms`),
                    ),
                BOOT_TIMEOUT_MS,
            );
            started.on('message', (message: any) => {
                if (message?.type === 'ready') {
                    clearTimeout(timer);
                    resolve(message.seeded);
                } else if (message?.type === 'error') {
                    clearTimeout(timer);
                    reject(new Error(message.message));
                }
            });
            started.once('exit', (code, signal) => {
                clearTimeout(timer);
                reject(
                    new Error(`backend exited (${signal ?? `exit ${code}`})`),
                );
            });
        });

        return {
            baseUrl,
            mode: 'full-boot',
            pid: started.pid!,
            ...seeded,
            userEmail: USER_EMAIL,
            apiKey,
            s3,
            setUserAttributes: (attributes) =>
                setUserAttributes(baseUrl, apiKey, seeded.userUuid, attributes),
            close,
        };
    } catch (error) {
        const log = logFile ? tail(logFile) : '';
        await close();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `startLightdash: ${message}${log ? `\n--- lightdash.log ---\n${log}` : ''}`,
        );
    }
}
