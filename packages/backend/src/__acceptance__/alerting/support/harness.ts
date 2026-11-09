/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// Shared harness for the alerting backend acceptance tests.
//
// It builds a real, migrated Postgres database (createMigratedDatabase), seeds
// an organization with two projects and users of every project role, creates
// the alerting module through its public factory with in-process fakes, and
// mounts the alerting express router on 127.0.0.1:0 behind a test login.
//
// The contract this harness drives (see PROGRESS.md, "Backend contract"):
//   packages/backend/src/alerting/index.ts exports
//     createAlertingModule(deps: AlertingModuleDeps): AlertingModule
//     createAlertingRouter(module: AlertingModule): express.Router
import { defineUserAbility } from '@lightdash/common';
import express from 'express';
import { randomUUID } from 'node:crypto';
import http, { type IncomingHttpHeaders } from 'node:http';
import { type AddressInfo } from 'node:net';
import {
    createMigratedDatabase,
    type MigratedDatabase,
} from '../../../testing/migratedDatabase';

export const T0 = new Date('2026-11-08T09:00:00.000Z');
export const SITE_URL = 'https://lightdash.example.test';
export const ROLES = [
    'viewer',
    'interactive_viewer',
    'editor',
    'developer',
    'admin',
] as const;
export type Role = (typeof ROLES)[number];
export type Actor = Role | 'outsider';

export class FakeClock {
    current: number;

    constructor(start: Date = T0) {
        this.current = start.getTime();
    }

    now = () => new Date(this.current);

    set(date: Date | string) {
        this.current = new Date(date).getTime();
    }

    advance(ms: number) {
        this.current += ms;
        return this.now();
    }

    advanceSeconds(s: number) {
        return this.advance(s * 1000);
    }
}

export type Row = Record<string, unknown>;
export type WarehouseCall = {
    projectUuid: string;
    context: any;
    sql: string;
    tags: Record<string, string>;
};
type Responder = (sql: string, call: WarehouseCall) => Row[] | Promise<Row[]>;

/** In-process stand-in for the project's WarehouseClient. */
export class FakeWarehouse {
    calls: WarehouseCall[] = [];

    responder: Responder = () => [];

    respond(fn: Responder) {
        this.responder = fn;
    }

    /** Respond with fixed rows (or throw `error`). */
    rows(rows: Row[]) {
        this.responder = () => rows;
    }

    fail(message: string) {
        this.responder = () => {
            throw new Error(message);
        };
    }

    getWarehouseClient = async ({
        projectUuid,
        context,
    }: {
        projectUuid: string;
        context: any;
    }) => ({
        runQuery: async (
            sql: string,
            tags: Record<string, string> = {},
        ): Promise<{ fields: Record<string, any>; rows: Row[] }> => {
            const call = { projectUuid, context, sql, tags };
            this.calls.push(call);
            const rows = await this.responder(sql, call);
            const fields: Record<string, any> = {};
            rows.forEach((row) =>
                Object.entries(row).forEach(([key, value]) => {
                    fields[key] = {
                        type: typeof value === 'number' ? 'number' : 'string',
                    };
                }),
            );
            return { fields, rows };
        },
    });
}

export type RecordedRequest = {
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
    body: string;
    json: any;
};

/** A mock HTTP server on 127.0.0.1:0 for webhooks, Slack, incident.io, heartbeats. */
export class MockHttp {
    requests: RecordedRequest[] = [];

    url = '';

    private server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            const body = Buffer.concat(chunks).toString('utf8');
            let json: any;
            try {
                json = body ? JSON.parse(body) : undefined;
            } catch {
                json = undefined;
            }
            const recorded = {
                method: req.method ?? '',
                path: req.url ?? '',
                headers: req.headers,
                body,
                json,
            };
            this.requests.push(recorded);
            const { status, body: out } = await this.handler(recorded);
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(out ?? '{"ok":true}');
        });
    });

    handler: (
        r: RecordedRequest,
    ) =>
        | { status: number; body?: string }
        | Promise<{ status: number; body?: string }> = () => ({ status: 200 });

    /** Answer with these statuses in order, then the last one forever. */
    statuses(...codes: number[]) {
        let i = 0;
        this.handler = () => {
            const status = codes[Math.min(i, codes.length - 1)];
            i += 1;
            return { status };
        };
    }

    to(path: string) {
        return this.requests.filter((r) => r.path.startsWith(path));
    }

    async start() {
        await new Promise<void>((resolve) =>
            this.server.listen(0, '127.0.0.1', () => resolve()),
        );
        const { port } = this.server.address() as AddressInfo;
        this.url = `http://127.0.0.1:${port}`;
        return this;
    }

    async stop() {
        this.server.closeAllConnections?.();
        await new Promise<void>((resolve) =>
            this.server.close(() => resolve()),
        );
    }
}

export type ApiResponse = { status: number; body: any };
export type ApiClient = {
    get: (path: string) => Promise<ApiResponse>;
    post: (path: string, body?: unknown) => Promise<ApiResponse>;
    put: (path: string, body?: unknown) => Promise<ApiResponse>;
    patch: (path: string, body?: unknown) => Promise<ApiResponse>;
    delete: (path: string) => Promise<ApiResponse>;
};

export type HarnessOptions = {
    heartbeat?: { url: string; method: 'GET' | 'POST' } | null;
    secrets?: Record<string, string>;
    retry?: { maxAttempts: number; initialDelayMs: number };
};

export type Harness = Awaited<ReturnType<typeof createHarness>>;

const seedUser = async (
    db: MigratedDatabase['database'],
    organizationId: number,
    name: string,
) => {
    const [user] = await db('users')
        .insert({ first_name: name, last_name: 'Test', is_active: true })
        .returning(['user_id', 'user_uuid']);
    await db('emails').insert({
        user_id: user.user_id,
        email: `${name}@example.test`,
        is_primary: true,
    });
    await db('organization_memberships').insert({
        organization_id: organizationId,
        user_id: user.user_id,
        role: 'member',
    });
    return user as { user_id: number; user_uuid: string };
};

export const createHarness = async (options: HarnessOptions = {}) => {
    const migrated = await createMigratedDatabase(undefined, {
        min: 0,
        max: 10,
    });
    const db = migrated.database;
    const [org] = await db('organizations')
        .insert({ organization_name: 'Alerting acceptance org' })
        .returning(['organization_id', 'organization_uuid']);
    const insertProject = async (name: string) => {
        const [project] = await db('projects')
            .insert({
                name,
                organization_id: org.organization_id,
                project_type: 'DEFAULT',
                dbt_connection: null,
                dbt_connection_type: null,
                copied_from_project_uuid: null,
                organization_warehouse_credentials_uuid: null,
                created_by_user_uuid: null,
            })
            .returning(['project_id', 'project_uuid']);
        return project as { project_id: number; project_uuid: string };
    };
    const project = await insertProject('Operations');
    const otherProject = await insertProject('Other project');
    const insertSpace = async (name: string, slug: string) => {
        const [space] = await db('spaces')
            .insert({
                name,
                slug,
                project_id: project.project_id,
                path: slug.replace(/-/g, '_'),
            })
            .returning(['space_uuid']);
        return { uuid: space.space_uuid as string, name, slug };
    };
    const spaces = {
        platform: await insertSpace('Platform', 'platform'),
        rds: await insertSpace('RDS', 'rds'),
    };

    const users = {} as Record<Actor, any>;
    const makeSessionUser = (
        dbUser: { user_id: number; user_uuid: string },
        name: string,
        profiles: { projectUuid: string; role: string }[],
    ) => {
        const ability = defineUserAbility(
            {
                role: 'member' as any,
                organizationUuid: org.organization_uuid,
                userUuid: dbUser.user_uuid,
                roleUuid: undefined,
            },
            profiles.map((p) => ({ ...p, userUuid: dbUser.user_uuid })) as any,
        );
        return {
            userUuid: dbUser.user_uuid,
            userId: dbUser.user_id,
            email: `${name}@example.test`,
            firstName: name,
            lastName: 'Test',
            organizationUuid: org.organization_uuid,
            organizationName: 'Alerting acceptance org',
            organizationCreatedAt: T0,
            isTrackingAnonymized: false,
            isMarketingOptedIn: false,
            isSetupComplete: true,
            role: 'member',
            isActive: true,
            isPending: false,
            createdAt: T0,
            updatedAt: T0,
            ability,
            abilityRules: ability.rules,
        };
    };
    for (const role of ROLES) {
        const dbUser = await seedUser(db, org.organization_id, role);
        await db('project_memberships').insert({
            project_id: project.project_id,
            user_id: dbUser.user_id,
            role,
        });
        users[role] = makeSessionUser(dbUser, role, [
            { projectUuid: project.project_uuid, role },
        ]);
    }
    const outsider = await seedUser(db, org.organization_id, 'outsider');
    await db('project_memberships').insert({
        project_id: otherProject.project_id,
        user_id: outsider.user_id,
        role: 'admin',
    });
    users.outsider = makeSessionUser(outsider, 'outsider', [
        { projectUuid: otherProject.project_uuid, role: 'admin' },
    ]);

    const clock = new FakeClock();
    const warehouse = new FakeWarehouse();
    const outbound = await new MockHttp().start();
    const emails: any[] = [];
    const slackPosts: any[] = [];
    const slackApp = {
        installed: true,
        postMessage: async (args: any) => {
            if (!slackApp.installed)
                throw new Error(
                    'Slack app is not installed for this organization',
                );
            slackPosts.push(args);
        },
    };
    const jobs = new Map<
        string,
        { taskName: string; payload: any; runAt?: Date }
    >();
    const jobLog: {
        taskName: string;
        payload: any;
        jobKey: string;
        runAt?: Date;
    }[] = [];
    const secrets: Record<string, string> = {
        'slack-infra-alerts-webhook': `${outbound.url}/slack/infra`,
        'incident-io-grafana': 'test-secret-not-real',
        'generic-webhook-token': 'test-webhook-token-not-real',
        ...options.secrets,
    };

    // A non-literal specifier keeps typecheck green before the module exists.
    const alertingModulePath = '../../../alerting';
    const { createAlertingModule, createAlertingRouter } = (await import(
        alertingModulePath
    )) as any;

    const deps = () => ({
        database: db,
        clock: { now: clock.now },
        warehouseClients: { getWarehouseClient: warehouse.getWarehouseClient },
        secrets: { resolve: async (name: string) => secrets[name] },
        email: {
            sendEmail: async (message: any) => {
                emails.push(message);
            },
        },
        slackApp,
        jobQueue: {
            addJob: async (
                taskName: string,
                payload: any,
                opts: { jobKey: string; runAt?: Date },
            ) => {
                jobLog.push({ taskName, payload, ...opts });
                jobs.set(opts.jobKey, { taskName, payload, runAt: opts.runAt });
            },
        },
        heartbeat: options.heartbeat ?? null,
        retry: options.retry ?? { maxAttempts: 3, initialDelayMs: 5 },
        siteUrl: SITE_URL,
    });
    const module = createAlertingModule(deps());
    /** Another worker/scheduler instance sharing the same database. */
    const createModule = () => createAlertingModule(deps());

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, _res, next) => {
        const who = req.header('x-test-user') as Actor | undefined;
        if (who) (req as any).user = users[who];
        next();
    });
    app.use(createAlertingRouter(module));
    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve()),
    );
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const projectBase = `/api/v2/projects/${project.project_uuid}/alerting`;

    const request = async (
        actor: Actor | null,
        method: string,
        path: string,
        body?: unknown,
    ): Promise<ApiResponse> => {
        const url = path.startsWith('/api/') ? path : `${projectBase}${path}`;
        const res = await fetch(`${baseUrl}${url}`, {
            method,
            headers: {
                'content-type': 'application/json',
                ...(actor ? { 'x-test-user': actor } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let parsed: any = text;
        try {
            parsed = text ? JSON.parse(text) : undefined;
        } catch {
            /* keep text */
        }
        return { status: res.status, body: parsed };
    };
    const api = (actor: Actor | null = 'admin'): ApiClient => ({
        get: (p) => request(actor, 'GET', p),
        post: (p, b) => request(actor, 'POST', p, b ?? {}),
        put: (p, b) => request(actor, 'PUT', p, b ?? {}),
        patch: (p, b) => request(actor, 'PATCH', p, b ?? {}),
        delete: (p) => request(actor, 'DELETE', p),
    });

    /** Unwraps `{ status: 'ok', results }`, failing loudly otherwise. */
    const ok = async (response: Promise<ApiResponse> | ApiResponse) => {
        const r = await response;
        if (r.status < 200 || r.status >= 300 || r.body?.status !== 'ok') {
            throw new Error(
                `Expected ok, got ${r.status}: ${JSON.stringify(r.body)}`,
            );
        }
        return r.body.results;
    };

    const createRule = async (overrides: Record<string, unknown> = {}) =>
        ok(api('admin').post('/rules', ruleInput(overrides)));
    const createContactPoint = async (input: Record<string, unknown>) =>
        ok(api('admin').post('/contact-points', input));
    const saveRoutes = async (tree: Record<string, unknown>) =>
        ok(api('admin').put('/notification-routes', tree));
    /** Webhook contact point that points at the mock server path. */
    const webhookContactPoint = async (
        slug: string,
        extra: Record<string, unknown> = {},
    ) =>
        createContactPoint({
            name: slug,
            slug,
            integrations: [
                {
                    type: 'webhook',
                    url: `${outbound.url}/hooks/${slug}`,
                    ...extra,
                },
            ],
        });
    /** Routes everything to one contact point with short timers. */
    const routeAllTo = async (
        contactPoint: string,
        timers: Record<string, unknown> = {},
    ) =>
        saveRoutes({
            contactPoint,
            groupBy: ['alertname'],
            groupWait: '30s',
            groupInterval: '1m',
            repeatInterval: '1h',
            ...timers,
        });
    const evaluate = async (ruleUuid: string, at: Date = clock.now()) =>
        module.evaluator.evaluateRule(ruleUuid, { scheduledAt: at });
    const getRule = async (ruleUuid: string) =>
        ok(api('admin').get(`/rules/${ruleUuid}`));
    const instance = async (
        ruleUuid: string,
        match: Record<string, string>,
    ) => {
        const rule = await getRule(ruleUuid);
        return (rule.instances as any[]).find((i) =>
            Object.entries(match).every(([k, v]) => i.labels?.[k] === v),
        );
    };

    const close = async () => {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await outbound.stop();
        await module.close?.();
        await migrated.destroy();
    };

    return {
        db,
        migrated,
        organizationUuid: org.organization_uuid as string,
        projectUuid: project.project_uuid as string,
        otherProjectUuid: otherProject.project_uuid as string,
        spaces,
        users,
        clock,
        warehouse,
        outbound,
        emails,
        slackApp,
        slackPosts,
        jobs,
        jobLog,
        secrets,
        module,
        createModule,
        baseUrl,
        projectBase,
        api,
        ok,
        createRule,
        createContactPoint,
        saveRoutes,
        webhookContactPoint,
        routeAllTo,
        evaluate,
        getRule,
        instance,
        close,
    };
};

/** A minimal valid Alert Rule input; the defaults are the documented ones. */
export const ruleInput = (overrides: Record<string, unknown> = {}) => ({
    name: 'Disk almost full',
    description: 'Disk usage on a database host is above 90%',
    labels: { team: 'infra' },
    annotations: {
        summary: 'Disk almost full',
        description: 'A database disk is above 90%',
        runbook_url: 'https://runbooks.example.test/disk',
    },
    query: 'SELECT instance, value FROM disk_usage',
    reducer: 'last',
    condition: { operator: '>', threshold: 90 },
    ...overrides,
});

export const disk = (values: Record<string, number>) =>
    Object.entries(values).map(([instance, value]) => ({ instance, value }));

export const minutes = (n: number) => n * 60_000;
export const uuid = () => randomUUID();

/** Runs `fn` against a fresh harness (fresh database) and always cleans up. */
export const withHarness = async <T>(
    fn: (h: Harness) => Promise<T>,
    options: HarnessOptions = {},
): Promise<T> => {
    const h = await createHarness(options);
    try {
        return await fn(h);
    } finally {
        await h.close();
    }
};

export const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

/** Polls `predicate` (real time) until true or `timeoutMs` passes. */
export const waitFor = async (predicate: () => boolean, timeoutMs = 10_000) => {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs)
            throw new Error('waitFor timed out');
        await sleep(10);
    }
};
