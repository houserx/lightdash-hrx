// ENG-1799 demo: seed a fresh Lightdash through its public HTTP API (run by up.sh once /api/v1/health answers).
//
//   node --import tsx stack/seed.ts --lightdash-url <url> --engine-file <.state/run/engine-config.json> \
//       --ready-file <.state/run/seed.json>
//
// Every up.sh starts Lightdash on an empty database, so the seed always runs against a new instance:
//   1. registers the demo user (POST /api/v1/user; the first user of an instance with no organization),
//      creates the organization (PUT /api/v1/org) and completes the user's setup (PATCH /api/v1/user/me/complete),
//      all on the session cookie that registration returns;
//   2. creates the Operations Project (POST /api/v1/org/projects): no dbt (`dbtConnection: none`), a Postgres
//      connection of the Federation Engine flavour to the demo engine, with the engine's identity signing secret
//      and HTTP side port (CONTRACTS §4.1);
//   3. grants the demo user the user attributes platform_read and platform_write = "true" (POST
//      /api/v1/org/attributes), which the engine reads from the identity token for the Platform Database;
//   4. checks the result as the user sees it: GET /api/v2/projects/<uuid>/federation/access.
// Then it writes the ready file atomically (mode 0600):
//   {"lightdash": {"projectUuid"}, "demoUser": {email, password, userUuid}, "organizationUuid"}.
// All values are synthetic: the email is @example.com and the password a fake `test-...-not-real` value.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const DEMO_USER = {
    firstName: 'Demo',
    lastName: 'Operator',
    email: 'demo.operator@example.com',
    password: 'test-demo-password-1-not-real',
} as const;
const ORGANIZATION_NAME = 'HouseRx Demo (synthetic)';
const PROJECT_NAME = 'Operations Project';
const PLATFORM_ATTRIBUTES = ['platform_read', 'platform_write'] as const;

type Engine = {
    host: string;
    pgPort: number;
    httpUrl: string;
    user: string;
    password: string;
    database: string;
    identitySecret: string;
};

/** A tiny session client: keeps the cookies Lightdash sets and unwraps `{status: 'ok', results}`. */
class Session {
    private readonly cookies = new Map<string, string>();

    constructor(private readonly baseUrl: string) {}

    async call<T = unknown>(method: string, route: string, body?: unknown): Promise<T> {
        const headers: Record<string, string> = {};
        if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetch(`${this.baseUrl}${route}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        for (const c of res.headers.getSetCookie()) {
            const [pair] = c.split(';');
            const eq = pair.indexOf('=');
            if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        const text = await res.text();
        if (!res.ok) throw new Error(`${method} ${route} -> HTTP ${res.status}: ${text.slice(0, 600)}`);
        const json = text ? JSON.parse(text) : null;
        return (json && typeof json === 'object' && 'results' in json ? json.results : json) as T;
    }
}

async function seed(lightdashUrl: string, engine: Engine) {
    const session = new Session(lightdashUrl);

    const health = await session.call<{ requiresOrgRegistration: boolean }>('GET', '/api/v1/health');
    if (!health.requiresOrgRegistration) {
        throw new Error('Lightdash already has an organization; the seed expects the fresh instance up.sh starts');
    }

    // 1. The demo user and its organization.
    const user = await session.call<{ userUuid: string }>('POST', '/api/v1/user', {
        firstName: DEMO_USER.firstName,
        lastName: DEMO_USER.lastName,
        email: DEMO_USER.email,
        password: DEMO_USER.password,
    });
    await session.call('PUT', '/api/v1/org', { name: ORGANIZATION_NAME });
    await session.call('PATCH', '/api/v1/user/me/complete', {
        jobTitle: 'Operations',
        isMarketingOptedIn: false,
        isTrackingAnonymized: true,
        enableEmailDomainAccess: false,
    });
    const org = await session.call<{ organizationUuid: string }>('GET', '/api/v1/org');

    // 2. The Operations Project on the Federation Engine flavour (no dbt).
    const created = await session.call<{ project: { projectUuid: string } }>('POST', '/api/v1/org/projects', {
        name: PROJECT_NAME,
        type: 'DEFAULT',
        dbtVersion: 'latest',
        dbtConnection: { type: 'none' },
        warehouseConnection: {
            type: 'postgres',
            flavor: 'federation',
            host: engine.host,
            port: engine.pgPort,
            user: engine.user,
            password: engine.password,
            dbname: engine.database,
            schema: 'public',
            sslmode: 'disable',
            identitySigningSecret: engine.identitySecret,
            httpBaseUrl: engine.httpUrl,
        },
    });
    const { projectUuid } = created.project;

    // 3. Platform Database grants through user attributes.
    for (const name of PLATFORM_ATTRIBUTES) {
        await session.call('POST', '/api/v1/org/attributes', {
            name,
            description: `Federation Engine identity attribute ${name} (ENG-1799 demo)`,
            attributeDefaults: null,
            users: [{ userUuid: user.userUuid, values: ['true'] }],
            groups: [],
        });
    }

    // 4. What the demo user now sees.
    const access = await session.call<{ isFederation: boolean; attrs: Record<string, boolean> }>(
        'GET',
        `/api/v2/projects/${projectUuid}/federation/access`,
    );
    if (!access.isFederation || !PLATFORM_ATTRIBUTES.every((a) => access.attrs[a] === true)) {
        throw new Error(`federation access is not as seeded: ${JSON.stringify(access)}`);
    }

    return {
        lightdash: { projectUuid },
        demoUser: { email: DEMO_USER.email, password: DEMO_USER.password, userUuid: user.userUuid },
        organizationUuid: org.organizationUuid,
    };
}

const { values: args } = parseArgs({
    options: {
        'lightdash-url': { type: 'string' },
        'engine-file': { type: 'string' },
        'ready-file': { type: 'string' },
    },
});
const lightdashUrl = args['lightdash-url'];
const engineFile = args['engine-file'];
const readyFile = args['ready-file'];
if (!lightdashUrl || !engineFile || !readyFile) {
    console.error('usage: seed.ts --lightdash-url <url> --engine-file <engine-config.json> --ready-file <file>');
    process.exit(2);
}

seed(lightdashUrl, (JSON.parse(readFileSync(engineFile, 'utf8')) as { engine: Engine }).engine)
    .then((result) => {
        writeFileSync(`${readyFile}.tmp`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
        renameSync(`${readyFile}.tmp`, readyFile);
        console.log(`seed: ${PROJECT_NAME} ${result.lightdash.projectUuid} for ${DEMO_USER.email}`);
    })
    .catch((e: unknown) => {
        console.error('seed: failed:', e instanceof Error ? e.message : e);
        process.exit(1);
    });
