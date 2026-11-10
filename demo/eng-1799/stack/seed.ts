// ENG-1799 demo: seed a fresh Lightdash through its public HTTP API (run by up.sh once /api/v1/health answers).
//
//   node --import tsx stack/seed.ts --lightdash-url <url> --engine-file <.state/run/engine-config.json> \
//       --content-dir <demo/eng-1799/content> --cli-home <.state/cli-home> --cli-node <node> \
//       --ready-file <.state/run/seed.json> --alerting-dir <demo/eng-1799/alerting> \
//       --alerting-out <.state/run/alerting> --incident-io-url <fake incident.io receiver url>
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
//   4. checks the result as the user sees it: GET /api/v2/projects/<uuid>/federation/access;
//   5. defines the project parameters the content references (PROJECT_PARAMETERS: trace_id), then
//      uploads the demo's content as code (--content-dir: up.sh passes a copy of demo/eng-1799/content, virtual
//      views, charts and dashboards, plus the SQL charts `lightdash import portal-scripts` wrote) with the
//      Lightdash CLI from source (`lightdash upload`, on the Node given by --cli-node: the workspace's pinned Node),
//      on a personal access token of the demo user, then checks that every dashboard in CONTENT_DASHBOARDS is
//      there with each chart Tile resolving to its saved chart and each SQL chart Tile to its saved SQL chart.
//      The CLI runs with HOME=<cli-home> (it writes ~/.config/lightdash) and stack/no-network.mjs preloaded (it
//      would post usage analytics and check GitHub for upgrades).
//   6. uploads the demo's alerting code (--alerting-dir: the Alert Rules "Fill queue backlog high" and "Fill service
//      error log rate", the incident.io Contact Point and the Notification Route tree) with `lightdash upload
//      --alerting-only`, from a copy under --alerting-out in which the Contact Point's URL placeholder is the fake
//      incident.io receiver's (--incident-io-url, ephemeral port); its token stays a `secretRef` that the backend
//      resolves from its environment (stack/lightdash.ts). Then it checks both rules are unpaused and not in
//      Shadow Run, the Contact Point points at the receiver and the route tree routes to it.
// Then it writes the ready file atomically (mode 0600):
//   {"lightdash": {"projectUuid", "apiToken"}, "demoUser": {email, password, userUuid}, "organizationUuid"}.
// `apiToken` is the demo user's personal access token on this throwaway instance, for later seed steps.
// All values are synthetic: the email is @example.com and the password a fake `test-...-not-real` value.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PINNED_TRACE_ID } from './tempo.js';

const DEMO_USER = {
    firstName: 'Demo',
    lastName: 'Operator',
    email: 'demo.operator@example.com',
    password: 'test-demo-password-1-not-real',
} as const;
const ORGANIZATION_NAME = 'HouseRx Demo (synthetic)';
const PROJECT_NAME = 'Operations Project';
const PLATFORM_ATTRIBUTES = ['platform_read', 'platform_write'] as const;
/** Dashboards the content upload must produce (names pinned in PROGRESS.md), with their chart Tile count. */
const CONTENT_DASHBOARDS = [
    { name: 'Pharmacy Ops overview', chartTiles: 4, sqlChartTiles: 0 },
    { name: 'Platform DB', chartTiles: 0, sqlChartTiles: 3 },
    { name: 'Service health', chartTiles: 3, sqlChartTiles: 0 },
] as const;
/** Alert Rules the alerting upload must produce (names pinned in PROGRESS.md). */
const ALERT_RULES = ['Fill queue backlog high', 'Fill service error log rate'] as const;
/** Stands for the fake incident.io receiver's URL (an ephemeral port) in demo/eng-1799/alerting/contact-points. */
const INCIDENT_IO_URL_PLACEHOLDER = '__DEMO_INCIDENT_IO_URL__';
/**
 * Project parameters (PUT /api/v2/projects/<uuid>/parameters, as lightdash.config.yml would declare them). They must
 * exist before the upload: a virtual view may only reference defined parameters. `trace_id` picks the trace the
 * Service health waterfall shows; it defaults to the fake Tempo's pinned example trace and takes any pasted id.
 */
const PROJECT_PARAMETERS = {
    trace_id: {
        label: 'Trace ID',
        description: 'Tempo trace id for the trace waterfall (defaults to the pinned example trace of the incident)',
        type: 'string',
        default: PINNED_TRACE_ID,
        options: [PINNED_TRACE_ID],
        allow_custom_values: true,
    },
} as const;
const CLI_DIR = path.resolve(__dirname, '..', '..', '..', 'packages', 'cli');
const CLI_TSX = path.join(CLI_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const NO_NETWORK = path.join(__dirname, 'no-network.mjs');

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

type Content = { dir: string; cliHome: string; node: string };
/** Alerting code: the templates in `dir`, rendered to `out` with the fake incident.io receiver's URL. */
type Alerting = { dir: string; out: string; incidentIoUrl: string };

/** The Lightdash CLI from source, as a user would run it, against the demo's Lightdash. */
function runCli(lightdashUrl: string, apiToken: string, content: Content, args: string[]) {
    mkdirSync(content.cliHome, { recursive: true, mode: 0o700 });
    const nodeOptions = [process.env.NODE_OPTIONS, `--import ${NO_NETWORK}`].filter(Boolean).join(' ');
    // `pnpm -F @lightdash/cli exec tsx src/index.ts` without pnpm: pnpm itself reads HOME (its pinned version), so
    // the CLI's own tsx runs on the workspace's pinned Node, from packages/cli, with HOME moved under .state.
    const r = spawnSync(content.node, [CLI_TSX, 'src/index.ts', ...args], {
        cwd: CLI_DIR,
        env: {
            ...process.env,
            HOME: content.cliHome,
            LIGHTDASH_URL: lightdashUrl,
            LIGHTDASH_API_KEY: apiToken,
            CI: 'true',
            NODE_OPTIONS: nodeOptions,
        },
        encoding: 'utf8',
        timeout: 180_000,
    });
    // the CLI prints progress and per-file warnings; keep them in seed.log
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    if (r.error || r.status !== 0) {
        throw new Error(`lightdash ${args[0]} failed (exit ${r.status}${r.error ? `, ${r.error.message}` : ''})`);
    }
}

/**
 * Writes the alerting code of --alerting-dir to --alerting-out with the fake incident.io receiver's URL filled in
 * (INCIDENT_IO_URL_PLACEHOLDER), for `lightdash upload --alerting-only`.
 */
function renderAlerting(alerting: Alerting) {
    rmSync(alerting.out, { recursive: true, force: true });
    cpSync(alerting.dir, alerting.out, { recursive: true });
    const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
        );
    for (const file of walk(alerting.out)) {
        const text = readFileSync(file, 'utf8');
        if (text.includes(INCIDENT_IO_URL_PLACEHOLDER)) {
            writeFileSync(file, text.split(INCIDENT_IO_URL_PLACEHOLDER).join(alerting.incidentIoUrl));
        }
    }
}

/** The Alert Rules, the incident.io Contact Point and the Notification Route tree are there as uploaded. */
async function checkAlerting(session: Session, projectUuid: string, incidentIoUrl: string) {
    const base = `/api/v2/projects/${projectUuid}/alerting`;
    const rules = await session.call<{ name: string; paused: boolean; shadow: boolean }[]>('GET', `${base}/rules`);
    for (const name of ALERT_RULES) {
        const rule = rules.find((r) => r.name === name);
        if (!rule) throw new Error(`alerting upload: no Alert Rule "${name}"`);
        if (rule.paused || rule.shadow) throw new Error(`alerting upload: Alert Rule "${name}" is paused or in Shadow Run`);
    }
    const contactPoints = await session.call<{ slug: string; integrations: { type: string; url?: unknown }[] }[]>(
        'GET',
        `${base}/contact-points`,
    );
    const incidentIo = contactPoints.find((c) =>
        c.integrations.some((i) => i.type === 'incident_io' && i.url === `${incidentIoUrl}/webhook`),
    );
    if (!incidentIo) throw new Error('alerting upload: no incident_io Contact Point on the fake receiver');
    const tree = await session.call<{ contactPoint: string } | null>('GET', `${base}/notification-routes`);
    if (!tree || !JSON.stringify(tree).includes(`"contactPoint":"${incidentIo.slug}"`)) {
        throw new Error('alerting upload: the Notification Route tree does not route to the incident.io Contact Point');
    }
}

/** Every dashboard of CONTENT_DASHBOARDS exists in the project and its (SQL) chart Tiles open their saved charts. */
async function checkContent(session: Session, projectUuid: string) {
    const listed = await session.call<{ data: { uuid: string; name: string }[] }>(
        'GET',
        `/api/v2/content?projectUuids=${projectUuid}&contentTypes=dashboard&pageSize=200`,
    );
    for (const expected of CONTENT_DASHBOARDS) {
        const hit = listed.data.find((d) => d.name === expected.name);
        if (!hit) throw new Error(`content upload: no dashboard "${expected.name}"`);
        const dashboard = await session.call<{
            tiles: { type: string; properties: { savedChartUuid?: string | null; savedSqlUuid?: string | null } }[];
        }>(
            'GET',
            `/api/v1/dashboards/${hit.uuid}`,
        );
        const charts = dashboard.tiles.filter((t) => t.type === 'saved_chart');
        if (charts.length !== expected.chartTiles) {
            throw new Error(`content upload: "${expected.name}" has ${charts.length} chart Tiles, expected ${expected.chartTiles}`);
        }
        for (const tile of charts) {
            if (!tile.properties.savedChartUuid) throw new Error(`content upload: a Tile of "${expected.name}" has no chart`);
            await session.call('GET', `/api/v1/saved/${tile.properties.savedChartUuid}`);
        }
        const sqlCharts = dashboard.tiles.filter((t) => t.type === 'sql_chart');
        if (sqlCharts.length !== expected.sqlChartTiles) {
            throw new Error(
                `content upload: "${expected.name}" has ${sqlCharts.length} SQL chart Tiles, expected ${expected.sqlChartTiles}`,
            );
        }
        for (const tile of sqlCharts) {
            if (!tile.properties.savedSqlUuid) throw new Error(`content upload: a SQL Tile of "${expected.name}" has no chart`);
            await session.call('GET', `/api/v1/projects/${projectUuid}/sqlRunner/saved/${tile.properties.savedSqlUuid}`);
        }
    }
}

async function seed(lightdashUrl: string, engine: Engine, content: Content, alerting: Alerting) {
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

    // 5. The demo's dashboards, through the real upload path, after the parameters their views reference.
    await session.call('PUT', `/api/v2/projects/${projectUuid}/parameters`, PROJECT_PARAMETERS);
    const pat = await session.call<{ token: string }>('POST', '/api/v1/user/me/personal-access-tokens', {
        description: 'ENG-1799 demo seed (lightdash upload)',
        expiresAt: null,
        autoGenerated: false,
    });
    runCli(lightdashUrl, pat.token, content, ['upload', '--project', projectUuid, '--path', content.dir]);
    await checkContent(session, projectUuid);

    // 6. Alerting as code: the Alert Rules, the incident.io Contact Point and the Notification Route tree.
    renderAlerting(alerting);
    runCli(lightdashUrl, pat.token, content, ['upload', '--alerting-only', '--project', projectUuid, '--path', alerting.out]);
    await checkAlerting(session, projectUuid, alerting.incidentIoUrl);

    return {
        lightdash: { projectUuid, apiToken: pat.token },
        demoUser: { email: DEMO_USER.email, password: DEMO_USER.password, userUuid: user.userUuid },
        organizationUuid: org.organizationUuid,
    };
}

const { values: args } = parseArgs({
    options: {
        'lightdash-url': { type: 'string' },
        'engine-file': { type: 'string' },
        'content-dir': { type: 'string' },
        'cli-home': { type: 'string' },
        'cli-node': { type: 'string' },
        'ready-file': { type: 'string' },
        'alerting-dir': { type: 'string' },
        'alerting-out': { type: 'string' },
        'incident-io-url': { type: 'string' },
    },
});
const lightdashUrl = args['lightdash-url'];
const engineFile = args['engine-file'];
const contentDir = args['content-dir'];
const cliHome = args['cli-home'];
const cliNode = args['cli-node'] ?? process.execPath;
const readyFile = args['ready-file'];
const alertingDir = args['alerting-dir'];
const alertingOut = args['alerting-out'];
const incidentIoUrl = args['incident-io-url'];
if (!lightdashUrl || !engineFile || !contentDir || !cliHome || !readyFile || !alertingDir || !alertingOut || !incidentIoUrl) {
    console.error(
        'usage: seed.ts --lightdash-url <url> --engine-file <engine-config.json> --content-dir <dir> --cli-home <dir> [--cli-node <node>] --ready-file <file> ' +
            '--alerting-dir <dir> --alerting-out <dir> --incident-io-url <url>',
    );
    process.exit(2);
}

seed(lightdashUrl, (JSON.parse(readFileSync(engineFile, 'utf8')) as { engine: Engine }).engine, {
    dir: path.resolve(contentDir),
    cliHome: path.resolve(cliHome),
    node: cliNode,
}, {
    dir: path.resolve(alertingDir),
    out: path.resolve(alertingOut),
    incidentIoUrl: incidentIoUrl.replace(/\/+$/, ''),
})
    .then((result) => {
        writeFileSync(`${readyFile}.tmp`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
        renameSync(`${readyFile}.tmp`, readyFile);
        console.log(`seed: ${PROJECT_NAME} ${result.lightdash.projectUuid} for ${DEMO_USER.email}`);
    })
    .catch((e: unknown) => {
        console.error('seed: failed:', e instanceof Error ? e.message : e);
        process.exit(1);
    });
