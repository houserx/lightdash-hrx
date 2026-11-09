// ENG-1799 demo line: shared acceptance helpers. PROTECTED (demo/eng-1799/acceptance/**).
//
// Everything here talks to the demo through its public surfaces only:
//   - demo/eng-1799/.state/stack.json, written by up.sh (shape: `Stack` below);
//   - HTTP: the Lightdash API, the scenario clock, the fake incident.io receiver, the engine's HTTP side port;
//   - the Postgres wire protocol: the Federation Engine and the synthetic Platform Database;
//   - the demo's own commands (up.sh, down.sh, walkthrough/run.sh, `pnpm -F eng-1799-demo ...`).
import { expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';

// run.sh exports DEMO_ACCEPTANCE_DEMO_DIR; `pnpm -F eng-1799-demo exec` also runs in the package directory.
export const DEMO = path.resolve(process.env.DEMO_ACCEPTANCE_DEMO_DIR ?? process.cwd());
export const ROOT = path.resolve(DEMO, '..', '..');
export const STATE = path.join(DEMO, '.state');
export const STACK_JSON = path.join(STATE, 'stack.json');
export const OUT = path.join(DEMO, 'out');
export const LOGDIR = process.env.DEMO_ACCEPTANCE_LOGDIR ?? path.join(ROOT, 'tmp', 'demo-acceptance');

/** The eight walkthrough scenes, in order. Each writes out/scenes/<id>/video.webm and key-moment.png. */
export const SCENES = [
    '01-sign-in',
    '02-incident',
    '03-alert-fires',
    '04-service-health',
    '05-investigate',
    '06-ai-question',
    '07-write-mode',
    '08-recovery',
] as const;
export type SceneId = (typeof SCENES)[number];

/** Rule and dashboard names the seed must use (pinned in PROGRESS.md). */
export const NAMES = {
    backlogRule: 'Fill queue backlog high',
    errorLogRule: 'Fill service error log rate',
    pharmacyOps: 'Pharmacy Ops overview',
    serviceHealth: 'Service health',
    platformDb: 'Platform DB',
    backlogThreshold: 100,
} as const;

export type Stack = {
    lightdash: { url: string; projectUuid: string };
    demoUser: { email: string; password: string };
    scenario: { url: string };
    prometheus: { url: string };
    loki: { url: string };
    tempo: { url: string };
    cloudwatch: { url: string };
    engine: {
        host: string;
        pgPort: number;
        httpUrl: string;
        user: string;
        password: string;
        database: string;
        identitySecret: string;
    };
    platformDb: { host: string; port: number; user: string; password: string; database: string };
    incidentIo: { url: string };
    mcp: { url: string };
    /** Fake Okta for the demo: POST {issuer}/v1/token with JSON {email} returns {access_token} for that user. */
    okta: { issuer: string };
    processes: { name: string; pid: number }[];
};

export function readStack(): Stack {
    expect(existsSync(STACK_JSON), `${STACK_JSON} must exist after up.sh`).toBe(true);
    return JSON.parse(readFileSync(STACK_JSON, 'utf8')) as Stack;
}

// ---------------------------------------------------------------- plain HTTP

export async function getJson<T = any>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
}

export async function postJson<T = any>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    return getJson<T>(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

export async function poll<T>(
    what: string,
    fn: () => Promise<T | undefined | null | false>,
    { timeoutMs, intervalMs = 2_000 }: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (;;) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (e) {
            lastError = e;
        }
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}${lastError ? ` (last error: ${String(lastError)})` : ''}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

// ---------------------------------------------------------------- scenario clock

export type Scenario = {
    startedAt: string;
    incidentAt: string;
    recoveryAt: string;
    now: string;
    phase: 'baseline' | 'incident' | 'recovered';
};

export const getScenario = (s: Stack) => getJson<Scenario>(`${s.scenario.url}/scenario`);

/** Restart the scenario at "now". Offsets are seconds from now and may be negative (timeline shifted into the past). */
export const restartScenario = (s: Stack, incidentAfterSeconds: number, recoveryAfterSeconds: number) =>
    postJson<Scenario>(`${s.scenario.url}/scenario/restart`, { incidentAfterSeconds, recoveryAfterSeconds });

// ---------------------------------------------------------------- Federation Engine and Platform Database (pg-wire)

export async function withEngine<T>(s: Stack, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({
        host: s.engine.host,
        port: s.engine.pgPort,
        user: s.engine.user,
        password: s.engine.password,
        database: s.engine.database,
        ssl: false,
    });
    await c.connect();
    try {
        return await fn(c);
    } finally {
        await c.end().catch(() => undefined);
    }
}

export async function withPlatformDb<T>(s: Stack, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ ...s.platformDb, ssl: false });
    await c.connect();
    try {
        return await fn(c);
    } finally {
        await c.end().catch(() => undefined);
    }
}

export const sqlString = (v: string) => `'${v.replace(/'/g, "''")}'`;
export const iso = (d: Date) => d.toISOString();
export const secondsAgo = (n: number) => new Date(Date.now() - n * 1000);

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** CONTRACTS §3 identity token. */
export function mintIdentityToken(
    secret: string,
    opts: {
        attrs?: Partial<Record<'telemetry_restricted' | 'platform_read' | 'platform_write' | 'platform_explain', boolean>>;
        description?: string | null;
        ticket?: string | null;
        source?: string;
        agent?: boolean;
    } = {},
): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        v: 1,
        iss: 'lightdash',
        sub: 'demo-acceptance-check',
        email: 'acceptance.check@example.com',
        org: '00000000-0000-0000-0000-000000000000',
        project: '00000000-0000-0000-0000-000000000000',
        agent: opts.agent ?? false,
        sys: false,
        attrs: {
            telemetry_restricted: false,
            platform_read: false,
            platform_write: false,
            platform_explain: false,
            ...opts.attrs,
        },
        audit: {
            description: opts.description ?? null,
            ticket: opts.ticket ?? null,
            source: opts.source ?? 'investigate',
            resource_uuid: null,
        },
        iat: now,
        exp: now + 240,
        nonce: b64url(randomBytes(16)),
    };
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(createHmac('sha256', secret).update(body).digest());
    return `${body}.${sig}`;
}

// ---------------------------------------------------------------- Lightdash API (session login as the demo user)

export async function lightdashApi(s: Stack): Promise<APIRequestContext> {
    const ctx = await playwrightRequest.newContext({ baseURL: s.lightdash.url });
    const res = await ctx.post('/api/v1/login', {
        data: { email: s.demoUser.email, password: s.demoUser.password },
    });
    expect(res.ok(), `demo user login: ${res.status()} ${await res.text()}`).toBe(true);
    return ctx;
}

export async function ld<T = any>(ctx: APIRequestContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, data?: unknown): Promise<T> {
    const res = await ctx.fetch(url, { method, data: data as any });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()}: ${text.slice(0, 800)}`);
    const body = text ? JSON.parse(text) : null;
    return (body && typeof body === 'object' && 'results' in body ? body.results : body) as T;
}

/** Run SQL on the Operations Project through Lightdash's async query API; returns raw row values. */
export async function lightdashSql(
    ctx: APIRequestContext,
    projectUuid: string,
    sql: string,
    { timeoutMs = 60_000, audit }: { timeoutMs?: number; audit?: { description: string; ticket?: string } } = {},
): Promise<Record<string, unknown>[]> {
    const started = await ld<{ queryUuid: string }>(ctx, 'POST', `/api/v2/projects/${projectUuid}/query/sql`, {
        sql,
        context: 'sqlRunner',
        invalidateCache: true,
        ...(audit ? { audit } : {}),
    });
    const result = await poll(
        `async query ${started.queryUuid}`,
        async () => {
            const r = await ld<any>(ctx, 'GET', `/api/v2/projects/${projectUuid}/query/${started.queryUuid}`);
            if (r.status === 'error' || r.status === 'cancelled' || r.status === 'expired') {
                throw new Error(`query ${r.status}: ${r.error ?? ''}`);
            }
            return r.status === 'ready' ? r : undefined;
        },
        { timeoutMs, intervalMs: 500 },
    );
    return (result.rows as any[]).map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]: [string, any]) => [k, v && typeof v === 'object' && 'value' in v ? v.value.raw : v])),
    );
}

export async function listContent(ctx: APIRequestContext, projectUuid: string, contentType: 'chart' | 'dashboard'): Promise<any[]> {
    const r = await ld<any>(ctx, 'GET', `/api/v2/content?projectUuids=${projectUuid}&contentTypes=${contentType}&pageSize=200`);
    return Array.isArray(r) ? r : (r.data ?? []);
}

export async function findDashboard(ctx: APIRequestContext, projectUuid: string, name: string): Promise<any> {
    const items = await listContent(ctx, projectUuid, 'dashboard');
    const hit = items.find((d) => d.name === name);
    expect(hit, `dashboard "${name}" in the Operations Project (found: ${items.map((d) => d.name).join(', ')})`).toBeTruthy();
    return ld(ctx, 'GET', `/api/v1/dashboards/${hit.uuid}`);
}

export type TileInfo = { title: string; type: string; json: string };

/** Each tile of a dashboard with its title and the JSON of the tile plus the chart behind it (for content checks). */
export async function dashboardTiles(ctx: APIRequestContext, projectUuid: string, dashboard: any): Promise<TileInfo[]> {
    const out: TileInfo[] = [];
    for (const tile of dashboard.tiles ?? []) {
        const p = tile.properties ?? {};
        let chart: unknown = null;
        if (p.savedChartUuid) chart = await ld(ctx, 'GET', `/api/v1/saved/${p.savedChartUuid}`).catch((e) => ({ error: String(e) }));
        else if (p.savedSqlUuid) chart = await ld(ctx, 'GET', `/api/v1/projects/${projectUuid}/sqlRunner/saved/${p.savedSqlUuid}`).catch((e) => ({ error: String(e) }));
        const title = String(p.title || p.chartName || (chart as any)?.name || '');
        out.push({ title, type: String(tile.type), json: JSON.stringify({ tile, chart }) });
    }
    return out;
}

export const tileByTitle = (tiles: TileInfo[], re: RegExp) => tiles.find((t) => re.test(t.title));

// ---------------------------------------------------------------- browser

/** Sign the browser in as the demo user (API login shares the context's cookies). */
export async function browserLogin(page: Page, s: Stack): Promise<void> {
    const res = await page.request.post(`${s.lightdash.url}/api/v1/login`, {
        data: { email: s.demoUser.email, password: s.demoUser.password },
    });
    expect(res.ok(), `demo user login: ${res.status()}`).toBe(true);
}

/** Open a dashboard by name in the browser and wait until no tile is loading. */
export async function openDashboard(page: Page, s: Stack, ctx: APIRequestContext, name: string, search = ''): Promise<any> {
    const dashboard = await findDashboard(ctx, s.lightdash.projectUuid, name);
    await page.goto(`${s.lightdash.url}/projects/${s.lightdash.projectUuid}/dashboards/${dashboard.uuid}/view${search}`);
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 });
    return dashboard;
}

/**
 * True when the element (or anything inside it, including same-origin iframes) shows a red mark: a text colour,
 * background, fill or stroke whose RGB is clearly red (r >= 180, g <= 120, b <= 130).
 */
export async function hasRedMark(page: Page, tileTitle: RegExp): Promise<boolean> {
    const isRedIn = async (frame: import('@playwright/test').Frame, rootSelector: string | null) =>
        frame.evaluate(
            ({ rootSelector, src, flags }) => {
                const re = new RegExp(src, flags);
                const parse = (c: string | null) => {
                    const m = c && c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
                    if (!m) return false;
                    const [r, g, b, a] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
                    return a > 0.3 && r >= 180 && g <= 120 && b <= 130;
                };
                let roots: Element[] = [document.body];
                if (rootSelector) {
                    // the dashboard grid item (react-grid-layout) holding the tile title; the smallest if several match
                    const all = Array.from(document.querySelectorAll('.react-grid-item')).filter((el) => re.test(el.textContent ?? ''));
                    all.sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length);
                    roots = all.slice(0, 1);
                    if (roots.length === 0) return false;
                }
                for (const root of roots) {
                    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
                        const cs = getComputedStyle(el);
                        if (parse(cs.color) && (el.textContent ?? '').trim().length > 0 && el.children.length === 0) return true;
                        if (parse(cs.backgroundColor)) return true;
                        if (el instanceof SVGElement && (parse(cs.fill) || parse(cs.stroke))) return true;
                        const dc = el.getAttribute('data-color');
                        if (dc && /^#/.test(dc)) {
                            const n = parseInt(dc.slice(1, 7), 16);
                            if (parse(`rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`)) return true;
                        }
                    }
                }
                return false;
            },
            { rootSelector, src: tileTitle.source, flags: tileTitle.flags },
        );
    if (await isRedIn(page.mainFrame(), 'tile')) return true;
    // registry charts render inside iframes within the tile
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const owner = await frame.frameElement().catch(() => null);
        if (!owner) continue;
        const inTile = await owner.evaluate((el, args) => {
            const re = new RegExp(args.src, args.flags);
            let p: Element | null = el as Element;
            for (let i = 0; i < 15 && p; i++, p = p.parentElement) if (re.test(p.textContent ?? '')) return true;
            return false;
        }, { src: tileTitle.source, flags: tileTitle.flags });
        if (inTile && (await isRedIn(frame, null).catch(() => false))) return true;
    }
    return false;
}

// ---------------------------------------------------------------- fake incident.io receiver

export type Received = { receivedAt: string; payload: any };

export async function incidentNotifications(s: Stack): Promise<Received[]> {
    const r = await getJson<{ notifications: Received[] }>(`${s.incidentIo.url}/api/received`);
    return r.notifications;
}

/** Notifications whose alerts include `alertname` with the given alert status ('firing' | 'resolved'). */
export function notificationsFor(all: Received[], alertname: string, status: 'firing' | 'resolved'): Received[] {
    return all.filter((n) =>
        (n.payload?.alerts ?? []).some((a: any) => a?.labels?.alertname === alertname && (a.status ?? n.payload.status) === status),
    );
}

// ---------------------------------------------------------------- alert rules

export async function alertRules(ctx: APIRequestContext, projectUuid: string): Promise<any[]> {
    return ld<any[]>(ctx, 'GET', `/api/v2/projects/${projectUuid}/alerting/rules`);
}

export async function ruleByName(ctx: APIRequestContext, projectUuid: string, name: string): Promise<any> {
    const rules = await alertRules(ctx, projectUuid);
    const hit = rules.find((r) => r.name === name);
    expect(hit, `Alert Rule "${name}" (found: ${rules.map((r) => r.name).join(', ')})`).toBeTruthy();
    return hit;
}

// ---------------------------------------------------------------- processes, ports, commands

export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e?.code === 'EPERM';
    }
}

export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host });
        const done = (v: boolean) => {
            sock.destroy();
            resolve(v);
        };
        sock.setTimeout(1_000, () => done(false));
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
    });
}

/** Every port in stack.json: `*.url` hosts and the pg ports. */
export function stackPorts(s: Stack): number[] {
    const ports = new Set<number>();
    const walk = (v: unknown, key = '') => {
        if (typeof v === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(v)) {
            const u = new URL(v);
            if (u.port) ports.add(Number(u.port));
        } else if (typeof v === 'number' && /port$/i.test(key)) ports.add(v);
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(s);
    return [...ports];
}

/** `pgrep -lf <pattern>` lines ("<pid> <command line>"); `ps` is not available in the factory sandbox. */
export function pgrepLines(pattern: string): string[] {
    const r = spawnSync('pgrep', ['-lf', pattern], { encoding: 'utf8' });
    if (r.error) throw r.error;
    return (r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Command lines of running processes that mention the demo's state directory. */
export function processesUsingState(): string[] {
    return pgrepLines(STATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

export function sh(cmd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {}) {
    const r = spawnSync(cmd, args, {
        cwd: opts.cwd ?? ROOT,
        env: { ...process.env, ...opts.env },
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? 300_000,
        maxBuffer: 64 * 1024 * 1024,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** Run walkthrough scenes against the running stack: `bash demo/eng-1799/walkthrough/run.sh <scene>...`. */
export function runWalkthrough(scenes: SceneId[], timeoutMs = 280_000) {
    const r = sh('bash', [path.join(DEMO, 'walkthrough', 'run.sh'), ...scenes], { timeoutMs });
    expect(r.status, `walkthrough ${scenes.join(' ')} failed:\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`).toBe(0);
    return r;
}

// ---------------------------------------------------------------- media (ffmpeg-static from the demo package)

export function ffmpegPath(): string {
    const p = createRequire(path.join(DEMO, 'package.json'))('ffmpeg-static') as string | null;
    expect(p && existsSync(p), 'ffmpeg-static must provide a binary').toBeTruthy();
    return p as string;
}

export type MediaInfo = {
    durationS: number | null;
    video: { codec: string; width: number; height: number; fps: number | null } | null;
    hasAudio: boolean;
    raw: string;
};

/** Parse `ffmpeg -i <file>` (ffmpeg-static ships no ffprobe). */
export function probe(file: string): MediaInfo {
    expect(existsSync(file), `${file} must exist`).toBe(true);
    const r = sh(ffmpegPath(), ['-hide_banner', '-i', file]);
    const raw = r.stderr;
    const d = raw.match(/Duration: (\d+):(\d+):([\d.]+)/);
    const v = raw.match(/Stream #\S+.*?Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*/);
    const fps = v ? v[0].match(/([\d.]+) fps/) : null;
    let durationS = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
    if (durationS === null && /Video:|Audio:/.test(raw) && !/Video: (png|mjpeg)/.test(raw)) {
        // webm recordings often carry no duration in the header: decode and read the last progress time
        const dec = sh(ffmpegPath(), ['-hide_banner', '-i', file, '-f', 'null', '-']);
        const times = [...dec.stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
        const last = times[times.length - 1];
        if (last) durationS = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
    }
    return {
        durationS,
        video: v ? { codec: v[1], width: Number(v[2]), height: Number(v[3]), fps: fps ? Number(fps[1]) : null } : null,
        hasAudio: /Stream #\S+.*?Audio:/.test(raw),
        raw,
    };
}

/** Mean volume (dB) of the audio between `from` and `from + len` seconds. */
export function meanVolumeDb(file: string, from: number, len: number): number {
    const r = sh(ffmpegPath(), ['-hide_banner', '-ss', String(from), '-t', String(len), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    const m = r.stderr.match(/mean_volume: (-?[\d.]+|-inf) dB/);
    expect(m, `volumedetect output for ${file}`).toBeTruthy();
    return m![1] === '-inf' ? -200 : Number(m![1]);
}

/** Check one scene's artifacts: a 1920x1080 video of at least `minSeconds` and a 1920x1080 key-moment screenshot. */
export function expectSceneArtifacts(scene: SceneId, minSeconds = 3) {
    const dir = path.join(OUT, 'scenes', scene);
    const video = probe(path.join(dir, 'video.webm'));
    expect(video.video, `${scene} video stream`).toBeTruthy();
    expect([video.video!.width, video.video!.height], `${scene} video size`).toEqual([1920, 1080]);
    expect(video.durationS ?? 0, `${scene} video duration`).toBeGreaterThanOrEqual(minSeconds);
    const shot = probe(path.join(dir, 'key-moment.png'));
    expect([shot.video?.width, shot.video?.height], `${scene} key-moment.png size`).toEqual([1920, 1080]);
}

// ---------------------------------------------------------------- telemetry-mcp (streamable HTTP, JSON-RPC)

export async function oktaToken(s: Stack, email = s.demoUser.email): Promise<string> {
    const r = await postJson<{ access_token: string }>(`${s.okta.issuer}/v1/token`, { email });
    expect(r.access_token).toBeTruthy();
    return r.access_token;
}

export async function mcpCall(s: Stack, token: string, method: string, params: unknown = {}): Promise<any> {
    const send = async (m: string, p: unknown, id: number | null) => {
        const res = await fetch(`${s.mcp.url}/mcp`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'mcp-protocol-version': '2025-06-18',
            },
            body: JSON.stringify(id === null ? { jsonrpc: '2.0', method: m, params: p } : { jsonrpc: '2.0', id, method: m, params: p }),
        });
        const text = await res.text();
        if (!res.ok && res.status !== 202) throw new Error(`MCP ${m} -> ${res.status}: ${text.slice(0, 300)}`);
        if (id === null) return null;
        const json = (res.headers.get('content-type') ?? '').includes('text/event-stream')
            ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).find((m2) => m2.id === id)
            : JSON.parse(text);
        if (json?.error) throw new Error(`MCP ${m} error: ${JSON.stringify(json.error)}`);
        return json?.result;
    };
    await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-acceptance', version: '0' } }, 1);
    await send('notifications/initialized', {}, null);
    return send(method, params, 2);
}

// ---------------------------------------------------------------- walkthrough scene guard

/** The scene's own spec exists and asserts what it shows (at least `min` expect calls). */
export function expectSceneSpecAsserts(scene: SceneId, min = 3) {
    const file = path.join(DEMO, 'walkthrough', `${scene}.spec.ts`);
    expect(existsSync(file), `${file} exists`).toBe(true);
    const n = (readFileSync(file, 'utf8').match(/\bexpect(\.poll)?\(/g) ?? []).length;
    expect(n, `${scene}.spec.ts asserts what the scene shows`).toBeGreaterThanOrEqual(min);
}

/** Fingerprint of the synthetic Platform Database tables (changes when Write Mode commits). */
export async function platformFingerprint(s: Stack): Promise<string> {
    return withPlatformDb(s, async (c) => {
        const parts: string[] = [];
        for (const t of ['orders', 'fills', 'queues', 'shipments']) {
            const r = await c.query(`select coalesce(md5(string_agg(x::text, ',' order by x::text)), '') as h from public.${t} x`);
            parts.push(String(r.rows[0].h));
        }
        return parts.join(':');
    });
}

export async function auditItems(ctx: APIRequestContext, s: Stack): Promise<any[]> {
    const month = new Date().toISOString().slice(0, 7);
    const r = await ld<any>(ctx, 'GET', `/api/v2/projects/${s.lightdash.projectUuid}/federation/audit?month=${month}`);
    return r.items ?? [];
}
