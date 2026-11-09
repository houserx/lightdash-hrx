// ENG-1799 demo: the fake Prometheus (served from the telemetry-fakes process on its reserved port).
//
// Metric: hrx_fill_queue_backlog{job="fill-service", queue="fill"|"pack"|"ship"}, scraped every 15 s.
// The value at time t is a pure function of t and the current scenario timeline (PROGRESS.md "Scenario clock
// and data"): the sample used is the latest scrape at or before t, and its jitter is a hash of (series, scrape
// time), never Math.random(), so the same query always gives the same answer.
//
//   queue="fill"  baseline 18..48 (moves); from incidentAt it ramps up over 15 s to 140..175 and stays there
//                 until recoveryAt; then it falls back over 45 s, so every evaluation from
//                 incidentAt+30s until recoveryAt is >= 120 and every one from recoveryAt+60s is baseline.
//   queue="pack"  8..22, queue="ship" 3..12, whatever the phase.
//
// API (GET with query parameters or POST with a form body, as Prometheus accepts both):
//   /api/v1/query_range  query, start, end, step   -> matrix
//   /api/v1/query        query, time (default now) -> vector
//   /api/v1/labels, /api/v1/label/<name>/values, /api/v1/series, /api/v1/metadata, /api/v1/status/buildinfo,
//   /-/healthy, /-/ready
// PromQL understood: a selector `metric{label op "value", ...}` (ops = != =~ !~), optionally wrapped in
// sum|min|max|avg|count [by|without (labels)] (...) with the grouping before or after the parentheses.
// Anything else answers 400 bad_data, like a real Prometheus does for a query it cannot parse.
import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { Timeline } from './clock.js';

export const METRIC = 'hrx_fill_queue_backlog';
const SCRAPE_INTERVAL_S = 15;
/** Prometheus' own limit on points per series in one query_range. */
const MAX_POINTS = 11_000;

type Labels = Record<string, string>;
type Series = { labels: Labels; value: (t: number, tl: Timeline) => number };

/** Deterministic integer in [0, n) from a key. */
function hash(key: string, n: number): number {
    return createHash('sha256').update(key).digest().readUInt32BE(0) % n;
}

// A sample can be one scrape interval old when it is evaluated, so the ramps end 15 s before the pinned bounds
// (at least 120 from incidentAt+30s, at most 60 from recoveryAt+60s).
const RAMP_UP_MS = 15_000;
const RAMP_DOWN_MS = 45_000;

const lerp = (a: number, b: number, f: number) => a + (b - a) * Math.min(1, Math.max(0, f));

function fillBacklog(t: number, tl: Timeline): number {
    const baseline = 18 + hash(`fill|base|${t}`, 31); // 18..48
    const incident = 140 + hash(`fill|incident|${t}`, 36); // 140..175
    const ms = t * 1000;
    if (ms < tl.incidentAt) return baseline;
    if (ms < tl.recoveryAt) return Math.round(lerp(baseline, incident, (ms - tl.incidentAt) / RAMP_UP_MS));
    return Math.round(lerp(incident, baseline, (ms - tl.recoveryAt) / RAMP_DOWN_MS));
}

const SERIES: Series[] = [
    { labels: { __name__: METRIC, job: 'fill-service', queue: 'fill' }, value: fillBacklog },
    { labels: { __name__: METRIC, job: 'fill-service', queue: 'pack' }, value: (t) => 8 + hash(`pack|${t}`, 15) },
    { labels: { __name__: METRIC, job: 'fill-service', queue: 'ship' }, value: (t) => 3 + hash(`ship|${t}`, 10) },
];

/** The value Prometheus would return at evaluation time t (seconds): the latest scrape at or before t. */
function sampleAt(s: Series, t: number, tl: Timeline): number {
    return s.value(Math.floor(t / SCRAPE_INTERVAL_S) * SCRAPE_INTERVAL_S, tl);
}

// ---------------------------------------------------------------- PromQL (the small subset the demo needs)

class BadData extends Error {}

type Matcher = { name: string; op: '=' | '!=' | '=~' | '!~'; value: string; re?: RegExp };
type Selector = { metric: string; matchers: Matcher[] };
type Aggregation = { op: 'sum' | 'min' | 'max' | 'avg' | 'count'; by?: string[]; without?: string[] };
type Query = { selector: Selector; aggregation?: Aggregation };

const IDENT = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;

function parseSelector(src: string): Selector {
    const m = src.match(IDENT);
    const metric = m ? m[0] : '';
    let rest = src.slice(metric.length).trim();
    const matchers: Matcher[] = [];
    if (rest.startsWith('{')) {
        if (!rest.endsWith('}')) throw new BadData(`unclosed label matchers in "${src}"`);
        let body = rest.slice(1, -1).trim();
        while (body) {
            const lm = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(,\s*)?/);
            if (!lm) throw new BadData(`cannot parse label matchers in "${src}"`);
            const value = lm[3].startsWith('"') ? (JSON.parse(lm[3]) as string) : lm[3].slice(1, -1).replace(/\\(.)/g, '$1');
            const op = lm[2] as Matcher['op'];
            const matcher: Matcher = { name: lm[1], op, value };
            if (op === '=~' || op === '!~') {
                try {
                    matcher.re = new RegExp(`^(?:${value})$`);
                } catch {
                    throw new BadData(`invalid regular expression "${value}"`);
                }
            }
            matchers.push(matcher);
            body = body.slice(lm[0].length);
            if (body && !lm[4]) throw new BadData(`expected "," between label matchers in "${src}"`);
        }
        rest = '';
    }
    if (rest) throw new BadData(`unexpected "${rest}" in "${src}"`);
    if (metric) matchers.unshift({ name: '__name__', op: '=', value: metric });
    if (!matchers.some((x) => (x.op === '=' && x.value !== '') || (x.op === '=~' && !x.re!.test('')))) {
        throw new BadData('vector selector must contain at least one non-empty matcher');
    }
    return { metric, matchers };
}

function parseGrouping(src: string): { kind: 'by' | 'without'; labels: string[]; rest: string } | undefined {
    const m = src.match(/^(by|without)\s*\(([^)]*)\)\s*/);
    if (!m) return undefined;
    const labels = m[2].split(',').map((l) => l.trim()).filter(Boolean);
    for (const l of labels) if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(l)) throw new BadData(`invalid label "${l}" in grouping`);
    return { kind: m[1] as 'by' | 'without', labels, rest: src.slice(m[0].length) };
}

export function parseQuery(raw: string): Query {
    let src = raw.trim();
    if (!src) throw new BadData('empty query');
    const agg = src.match(/^(sum|min|max|avg|count)\b\s*/);
    if (!agg) return { selector: parseSelector(src) };
    const aggregation: Aggregation = { op: agg[1] as Aggregation['op'] };
    src = src.slice(agg[0].length);
    const setGrouping = (g: NonNullable<ReturnType<typeof parseGrouping>>) => {
        if (aggregation.by || aggregation.without) throw new BadData('grouping given twice');
        if (g.kind === 'by') aggregation.by = g.labels;
        else aggregation.without = g.labels;
        src = g.rest;
    };
    const before = parseGrouping(src);
    if (before) setGrouping(before);
    if (!src.startsWith('(')) throw new BadData(`expected "(" after ${aggregation.op}`);
    const close = src.lastIndexOf(')');
    if (close < 0) throw new BadData('unclosed parenthesis');
    const inner = src.slice(1, close);
    src = src.slice(close + 1).trim();
    const after = parseGrouping(src);
    if (after) setGrouping(after);
    if (src.trim()) throw new BadData(`unexpected "${src.trim()}" after ${aggregation.op}(...)`);
    return { selector: parseSelector(inner), aggregation };
}

function matches(labels: Labels, ms: Matcher[]): boolean {
    return ms.every((m) => {
        const v = labels[m.name] ?? '';
        switch (m.op) {
            case '=':
                return v === m.value;
            case '!=':
                return v !== m.value;
            case '=~':
                return m.re!.test(v);
            case '!~':
                return !m.re!.test(v);
        }
    });
}

type Result = { metric: Labels; values: (t: number) => number };

/** The series a query yields, each with a function from evaluation time (s) to value. */
function evaluate(q: Query, tl: Timeline): Result[] {
    const selected = SERIES.filter((s) => matches(s.labels, q.selector.matchers));
    if (!q.aggregation) return selected.map((s) => ({ metric: { ...s.labels }, values: (t) => sampleAt(s, t, tl) }));
    const { op, by, without } = q.aggregation;
    const groupLabels = (labels: Labels): Labels => {
        if (by) return Object.fromEntries(by.filter((l) => l in labels).map((l) => [l, labels[l]]));
        const drop = new Set(['__name__', ...(without ?? Object.keys(labels))]);
        return Object.fromEntries(Object.entries(labels).filter(([k]) => !drop.has(k)));
    };
    const groups = new Map<string, { metric: Labels; members: Series[] }>();
    for (const s of selected) {
        const metric = groupLabels(s.labels);
        const key = JSON.stringify(Object.entries(metric).sort());
        const g = groups.get(key) ?? { metric, members: [] };
        g.members.push(s);
        groups.set(key, g);
    }
    return [...groups.values()].map(({ metric, members }) => ({
        metric,
        values: (t: number) => {
            const xs = members.map((s) => sampleAt(s, t, tl));
            switch (op) {
                case 'sum':
                    return xs.reduce((a, b) => a + b, 0);
                case 'min':
                    return Math.min(...xs);
                case 'max':
                    return Math.max(...xs);
                case 'avg':
                    return xs.reduce((a, b) => a + b, 0) / xs.length;
                case 'count':
                    return xs.length;
            }
        },
    }));
}

// ---------------------------------------------------------------- times

/** Prometheus time: decimal Unix seconds or RFC 3339. */
function parseTime(name: string, raw: string | undefined, fallback?: number): number {
    if (raw === undefined || raw === '') {
        if (fallback !== undefined) return fallback;
        throw new BadData(`missing parameter "${name}"`);
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) throw new BadData(`invalid parameter "${name}": cannot parse "${raw}" to a valid timestamp`);
    return ms / 1000;
}

/** Prometheus duration: decimal seconds or e.g. 15s, 1m30s, 500ms. */
function parseStep(raw: string | undefined): number {
    if (raw === undefined || raw === '') throw new BadData('missing parameter "step"');
    let seconds: number;
    if (/^\d+(\.\d+)?$/.test(raw)) seconds = Number(raw);
    else {
        const units: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
        const parts = [...raw.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)];
        if (!parts.length || parts.map((p) => p[0]).join('') !== raw) {
            throw new BadData(`invalid parameter "step": cannot parse "${raw}" to a valid duration`);
        }
        seconds = parts.reduce((acc, p) => acc + Number(p[1]) * units[p[2]], 0);
    }
    if (!(seconds > 0)) throw new BadData('zero or negative query resolution step widths are not accepted');
    return seconds;
}

/** Prometheus prints sample values as Go's strconv.FormatFloat(v, 'f', -1, 64). */
const valueText = (v: number) => String(Number(v.toFixed(6)));
/** Sample timestamps: seconds with at most millisecond precision. */
const timeNumber = (t: number) => Math.round(t * 1000) / 1000;

// ---------------------------------------------------------------- HTTP

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

const ok = (res: http.ServerResponse, data: unknown) => sendJson(res, 200, { status: 'success', data });
const badData = (res: http.ServerResponse, error: string) => sendJson(res, 400, { status: 'error', errorType: 'bad_data', error });

async function params(req: http.IncomingMessage, url: URL): Promise<URLSearchParams> {
    const out = new URLSearchParams(url.searchParams);
    if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > 64 * 1024) throw new BadData('request body too large');
            chunks.push(chunk as Buffer);
        }
        for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) out.append(k, v);
    }
    return out;
}

function queryRange(p: URLSearchParams, tl: Timeline) {
    const q = parseQuery(p.get('query') ?? '');
    const start = parseTime('start', p.get('start') ?? undefined);
    const end = parseTime('end', p.get('end') ?? undefined);
    const step = parseStep(p.get('step') ?? undefined);
    if (end < start) throw new BadData('end timestamp must not be before start time');
    if ((end - start) / step > MAX_POINTS) {
        throw new BadData('exceeded maximum resolution of 11,000 points per timeseries. Try decreasing the query resolution (?step=XX)');
    }
    const result = evaluate(q, tl).map((r) => {
        const values: [number, string][] = [];
        for (let i = 0; start + i * step <= end + 1e-9; i++) {
            const t = start + i * step;
            values.push([timeNumber(t), valueText(r.values(t))]);
        }
        return { metric: r.metric, values };
    });
    return { resultType: 'matrix', result };
}

function queryInstant(p: URLSearchParams, tl: Timeline, now: number) {
    const q = parseQuery(p.get('query') ?? '');
    const t = parseTime('time', p.get('time') ?? undefined, now / 1000);
    return {
        resultType: 'vector',
        result: evaluate(q, tl).map((r) => ({ metric: r.metric, value: [timeNumber(t), valueText(r.values(t))] })),
    };
}

/** Request handler of the fake Prometheus; `timeline` is read per request so restarts apply at once. */
export function prometheusHandler(timeline: () => Timeline, now: () => number = Date.now): http.RequestListener {
    return (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const tl = timeline();
        const handle = async (): Promise<void> => {
            if (path === '/-/healthy' || path === '/-/ready') {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('Prometheus Server is Ready.\n');
                return;
            }
            if (req.method !== 'GET' && req.method !== 'POST') {
                sendJson(res, 405, { status: 'error', errorType: 'bad_data', error: `method ${req.method} not allowed` });
                return;
            }
            const p = await params(req, url);
            switch (path) {
                case '/api/v1/query_range':
                    ok(res, queryRange(p, tl));
                    return;
                case '/api/v1/query':
                    ok(res, queryInstant(p, tl, now()));
                    return;
                case '/api/v1/labels':
                    ok(res, [...new Set(SERIES.flatMap((s) => Object.keys(s.labels)))].sort());
                    return;
                case '/api/v1/series': {
                    const selectors = p.getAll('match[]').map(parseSelector);
                    ok(res, SERIES.filter((s) => selectors.some((sel) => matches(s.labels, sel.matchers))).map((s) => s.labels));
                    return;
                }
                case '/api/v1/metadata':
                    ok(res, { [METRIC]: [{ type: 'gauge', help: 'Prescriptions waiting in a pharmacy work queue (demo).', unit: '' }] });
                    return;
                case '/api/v1/status/buildinfo':
                    ok(res, { version: '2.53.0-demo', revision: 'demo', branch: 'demo' });
                    return;
            }
            const label = path.match(/^\/api\/v1\/label\/([^/]+)\/values$/);
            if (label) {
                const name = decodeURIComponent(label[1]);
                ok(res, [...new Set(SERIES.map((s) => s.labels[name]).filter((v): v is string => v !== undefined))].sort());
                return;
            }
            sendJson(res, 404, { status: 'error', errorType: 'not_found', error: `no route ${req.method} ${path}` });
        };
        handle().catch((e: unknown) => {
            if (e instanceof BadData) badData(res, e.message);
            else sendJson(res, 500, { status: 'error', errorType: 'internal', error: e instanceof Error ? e.message : String(e) });
        });
    };
}
