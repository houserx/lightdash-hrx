// ENG-1799 demo: the fake Loki (served from the telemetry-fakes process on its reserved port).
//
// Logs: the fill-service, logfmt lines in two streams {app="fill-service", env="demo", level="info"|"error"}.
// Like the fake Prometheus, the lines at time t are a pure function of t and the current scenario timeline
// (PROGRESS.md "Scenario clock and data"); every whole second is a slot that holds at most one line, and the
// line's millisecond offset, level and wording come from a hash of the second, never Math.random().
//
//   baseline/recovered  about 20 info lines a minute, and one ordinary error line every 40 s (so every 1 m
//                       window holds 1 or 2 error lines, never 0: an error-rate alert sees data, not NoData).
//   incident            from incidentAt until recoveryAt also an error line every 3 s plus some more (20..30 a
//                       minute), each a timed-out call to shipping-label-api (duration_ms 2000..4999, as Tempo).
// `fillServiceLogs()` is exported for the CloudWatch Logs fake, whose ERROR messages follow these numbers.
//
// API (GET with query parameters or POST with a form body), errors as Loki's plain-text 400s:
//   /loki/api/v1/query_range  query, start, end (ns, s or RFC 3339), limit (100, at most 5000),
//                             direction (backward), step (metric queries)  -> streams | matrix
//   /loki/api/v1/query        query (metric only), time                    -> vector
//   /loki/api/v1/labels, /loki/api/v1/label/<name>/values, /loki/api/v1/series (match[]),
//   /loki/api/v1/status/buildinfo, /ready
// LogQL understood: a stream selector `{label op "value", ...}` followed by line filters `|= != |~ !~` with a
// "string" or `raw string`; metric queries `count_over_time|rate|bytes_over_time(<log query> [range])`,
// optionally inside sum|min|max|avg|count [by|without (labels)] (...). Anything else (`| logfmt`, label
// filters, unwrap) answers 400; extend `parseLogQuery`/`parseMetricQuery` if a later feature needs it.
import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { Timeline } from './clock.js';
import { BadData, type Labels, matches, parseGrouping, parseSelector, parseStep, type Selector } from './prometheus.js';

export type LogLevel = 'info' | 'error';
/** One fill-service log line; `ms` is its epoch time in milliseconds. */
export type LogEntry = { ms: number; level: LogLevel; line: string };

const STREAM_LABELS: Record<LogLevel, Labels> = {
    info: { app: 'fill-service', env: 'demo', level: 'info' },
    error: { app: 'fill-service', env: 'demo', level: 'error' },
};

/** Loki's defaults: limit 100, max_entries_limit_per_query 5000, 11,000 points per series. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 5000;
const MAX_POINTS = 11_000;
/** The fake makes its lines on demand, one slot per second; longer ranges are refused like max_query_length. */
const MAX_RANGE_MS = 7 * 24 * 3600_000;
const BASELINE_ERROR_EVERY_S = 40;
const INCIDENT_ERROR_EVERY_S = 3;

/** Deterministic integer in [0, n) from a key. */
function hash(key: string, n: number): number {
    return createHash('sha256').update(key).digest().readUInt32BE(0) % n;
}

const pick = <T>(xs: readonly T[], key: string): T => xs[hash(key, xs.length)];

const INFO_MESSAGES = ['fill queued', 'fill verified', 'fill packed', 'label created', 'fill shipped'] as const;
const QUEUE_OF: Record<(typeof INFO_MESSAGES)[number], string> = {
    'fill queued': 'fill',
    'fill verified': 'fill',
    'fill packed': 'pack',
    'label created': 'ship',
    'fill shipped': 'ship',
};
const ORDINARY_ERRORS = [
    'msg="label printer heartbeat missed" printer=demo-printer-2',
    'msg="insurance eligibility check failed" payer=DEMO-PAYER-7 status=503 retry=true',
    'msg="inventory sync conflict" sku=DEMO-SKU-0042 retry=true',
] as const;

/** The line in the slot of second `s`, if any. */
function slot(s: number, tl: Timeline): LogEntry | undefined {
    const ms = s * 1000 + hash(`loki|offset|${s}`, 1000);
    const incident = ms >= tl.incidentAt && ms < tl.recoveryAt;
    const ts = new Date(ms).toISOString();
    const fill = `fill_id=demo-fill-${100_000 + hash(`loki|fill|${s}`, 900_000)}`;
    if (incident && (s % INCIDENT_ERROR_EVERY_S === 0 || hash(`loki|incident|${s}`, 6) === 0)) {
        const duration = 2000 + hash(`loki|slow|${s}`, 3000);
        return {
            ms,
            level: 'error',
            line: `ts=${ts} level=error msg="create shipping label failed" ${fill} downstream=shipping-label-api duration_ms=${duration} err="context deadline exceeded"`,
        };
    }
    if (s % BASELINE_ERROR_EVERY_S === 7) {
        return { ms, level: 'error', line: `ts=${ts} level=error ${pick(ORDINARY_ERRORS, `loki|ordinary|${s}`)} ${fill}` };
    }
    if (hash(`loki|info|${s}`, 3) !== 0) return undefined;
    const msg = pick(INFO_MESSAGES, `loki|msg|${s}`);
    const duration =
        msg === 'label created'
            ? `downstream=shipping-label-api duration_ms=${incident ? 2000 + hash(`loki|slow|${s}`, 3000) : 120 + hash(`loki|fast|${s}`, 360)}`
            : `duration_ms=${5 + hash(`loki|dur|${s}`, 80)}`;
    return { ms, level: 'info', line: `ts=${ts} level=info msg="${msg}" queue=${QUEUE_OF[msg]} ${fill} ${duration}` };
}

/** Every fill-service line with fromMs <= ms < toMs, oldest first. */
export function fillServiceLogs(fromMs: number, toMs: number, tl: Timeline): LogEntry[] {
    const out: LogEntry[] = [];
    for (let s = Math.floor(fromMs / 1000); s * 1000 < toMs; s++) {
        const e = slot(s, tl);
        if (e && e.ms >= fromMs && e.ms < toMs) out.push(e);
    }
    return out;
}

// ---------------------------------------------------------------- LogQL (the small subset the demo needs)

type LineFilter = { op: '|=' | '!=' | '|~' | '!~'; value: string; re?: RegExp };
type LogQuery = { selector: Selector; filters: LineFilter[] };
type RangeFn = 'count_over_time' | 'rate' | 'bytes_over_time';
type Aggregation = { op: 'sum' | 'min' | 'max' | 'avg' | 'count'; by?: string[]; without?: string[] };
type MetricQuery = { fn: RangeFn; rangeMs: number; log: LogQuery; aggregation?: Aggregation };

/** Index just past the `}` closing the selector that starts at src[0] === '{' (quotes respected). */
function selectorEnd(src: string): number {
    let quote = '';
    for (let i = 1; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\' && quote !== '`') i++;
            else if (c === quote) quote = '';
        } else if (c === '"' || c === '`') quote = c;
        else if (c === '}') return i + 1;
    }
    throw new BadData(`parse error: unclosed stream selector in "${src}"`);
}

function parseLogQuery(raw: string): LogQuery {
    const src = raw.trim();
    if (!src.startsWith('{')) throw new BadData(`parse error: a log query starts with a stream selector {...}, got "${src}"`);
    const end = selectorEnd(src);
    const selector = parseSelector(src.slice(0, end));
    const filters: LineFilter[] = [];
    let rest = src.slice(end).trim();
    while (rest) {
        const m = rest.match(/^(\|=|!=|\|~|!~)\s*("(?:[^"\\]|\\.)*"|`[^`]*`)\s*/);
        if (!m) throw new BadData(`parse error: the fake Loki understands only line filters (|= != |~ !~), got "${rest}"`);
        const value = m[2].startsWith('"') ? (JSON.parse(m[2]) as string) : m[2].slice(1, -1);
        const filter: LineFilter = { op: m[1] as LineFilter['op'], value };
        if (filter.op === '|~' || filter.op === '!~') {
            try {
                filter.re = new RegExp(value);
            } catch {
                throw new BadData(`parse error: invalid regular expression "${value}"`);
            }
        }
        filters.push(filter);
        rest = rest.slice(m[0].length);
    }
    return { selector, filters };
}

/** A Loki/Prometheus duration such as 1m, 30s, 1h30m, in ms. */
function parseRange(raw: string): number {
    try {
        return parseStep(raw.trim()) * 1000;
    } catch {
        throw new BadData(`parse error: invalid range "[${raw}]"`);
    }
}

function parseMetricQuery(raw: string): MetricQuery {
    let src = raw.trim();
    let aggregation: Aggregation | undefined;
    const agg = src.match(/^(sum|min|max|avg|count)\b\s*/);
    if (agg) {
        aggregation = { op: agg[1] as Aggregation['op'] };
        src = src.slice(agg[0].length);
        const group = (g: NonNullable<ReturnType<typeof parseGrouping>>) => {
            if (aggregation!.by || aggregation!.without) throw new BadData('parse error: grouping given twice');
            if (g.kind === 'by') aggregation!.by = g.labels;
            else aggregation!.without = g.labels;
            src = g.rest;
        };
        const before = parseGrouping(src);
        if (before) group(before);
        if (!src.startsWith('(')) throw new BadData(`parse error: expected "(" after ${aggregation.op}`);
        const close = src.lastIndexOf(')');
        let after = src.slice(close + 1).trim();
        src = src.slice(1, close).trim();
        const g = parseGrouping(after);
        if (g) {
            const inner = src;
            group(g);
            after = src.trim();
            src = inner;
        }
        if (after) throw new BadData(`parse error: unexpected "${after}" after ${aggregation.op}(...)`);
    }
    const fn = src.match(/^(count_over_time|rate|bytes_over_time)\s*\(/);
    if (!fn || !src.endsWith(')')) {
        throw new BadData(`parse error: the fake Loki understands count_over_time, rate and bytes_over_time, got "${raw.trim()}"`);
    }
    const inner = src.slice(fn[0].length, -1).trim();
    const open = inner.lastIndexOf('[');
    if (open < 0 || !inner.endsWith(']')) throw new BadData(`parse error: ${fn[1]} needs a range, e.g. [1m]`);
    return {
        fn: fn[1] as RangeFn,
        rangeMs: parseRange(inner.slice(open + 1, -1)),
        log: parseLogQuery(inner.slice(0, open)),
        aggregation,
    };
}

const isMetricQuery = (query: string) => !query.trim().startsWith('{');

function keep(q: LogQuery, e: LogEntry): boolean {
    if (!matches(STREAM_LABELS[e.level], q.selector.matchers)) return false;
    return q.filters.every((f) => {
        switch (f.op) {
            case '|=':
                return e.line.includes(f.value);
            case '!=':
                return !e.line.includes(f.value);
            case '|~':
                return f.re!.test(e.line);
            case '!~':
                return !f.re!.test(e.line);
        }
    });
}

type Point = [number, string];
type MetricSeries = { metric: Labels; points: Point[] };

/** Range-function value of each stream at each evaluation time (s); times without lines have no point, as Loki. */
function evaluateMetric(q: MetricQuery, times: number[], tl: Timeline): MetricSeries[] {
    if (!times.length) return [];
    const from = times[0] * 1000 - q.rangeMs;
    checkRange(from, times[times.length - 1] * 1000);
    const entries = fillServiceLogs(from, times[times.length - 1] * 1000 + 1, tl).filter((e) => keep(q.log, e));
    const perStream = new Map<LogLevel, LogEntry[]>();
    for (const e of entries) {
        const es = perStream.get(e.level) ?? [];
        es.push(e);
        perStream.set(e.level, es);
    }
    // values.get(level)[i]: the stream's value at times[i] over (t - range, t], undefined without lines.
    // Times ascend, so the window's ends only move forward; bytes[k] = bytes of es[0..k).
    const values = new Map<LogLevel, (number | undefined)[]>();
    for (const [level, es] of perStream) {
        const bytes = [0];
        for (const e of es) bytes.push(bytes[bytes.length - 1] + Buffer.byteLength(e.line));
        let lo = 0;
        let hi = 0;
        values.set(
            level,
            times.map((t) => {
                while (hi < es.length && es[hi].ms <= t * 1000) hi++;
                while (lo < hi && es[lo].ms <= t * 1000 - q.rangeMs) lo++;
                const n = hi - lo;
                if (!n) return undefined;
                if (q.fn === 'bytes_over_time') return bytes[hi] - bytes[lo];
                return q.fn === 'rate' ? n / (q.rangeMs / 1000) : n;
            }),
        );
    }
    const toPoints = (vs: (number | undefined)[]): Point[] =>
        vs.flatMap((v, i) => (v === undefined ? [] : [[Math.round(times[i] * 1000) / 1000, String(Number(v.toFixed(6)))] as Point]));
    if (!q.aggregation) return [...values].map(([level, vs]) => ({ metric: { ...STREAM_LABELS[level] }, points: toPoints(vs) }));
    const { op, by, without } = q.aggregation;
    const groupLabels = (labels: Labels): Labels => {
        if (by) return Object.fromEntries(by.filter((l) => l in labels).map((l) => [l, labels[l]]));
        const drop = new Set(without ?? Object.keys(labels));
        return Object.fromEntries(Object.entries(labels).filter(([k]) => !drop.has(k)));
    };
    const groups = new Map<string, { metric: Labels; members: (number | undefined)[][] }>();
    for (const [level, vs] of values) {
        const metric = groupLabels(STREAM_LABELS[level]);
        const key = JSON.stringify(Object.entries(metric).sort());
        const g = groups.get(key) ?? { metric, members: [] };
        g.members.push(vs);
        groups.set(key, g);
    }
    return [...groups.values()].map(({ metric, members }) => ({
        metric,
        points: toPoints(
            times.map((_, i) => {
                const xs = members.map((vs) => vs[i]).filter((v): v is number => v !== undefined);
                if (!xs.length) return undefined;
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
            }),
        ),
    }));
}

// ---------------------------------------------------------------- parameters

/** Loki time (as ms): integer ns (more than 10 digits) or s, decimal s, or RFC 3339. */
function parseTime(name: string, raw: string | null, fallbackMs: number): number {
    if (raw === null || raw === '') return fallbackMs;
    if (/^-?\d+$/.test(raw)) return raw.replace('-', '').length <= 10 ? Number(raw) * 1000 : Number(BigInt(raw) / 1000n) / 1000;
    if (/^-?\d+\.\d+$/.test(raw)) return Number(raw) * 1000;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) throw new BadData(`invalid parameter "${name}": cannot parse "${raw}" to a valid timestamp`);
    return ms;
}

function checkRange(fromMs: number, toMs: number): void {
    if (toMs - fromMs > MAX_RANGE_MS) {
        throw new BadData(`the query time range exceeds the limit (query length: ${Math.round((toMs - fromMs) / 1000)}s, limit: 7d)`);
    }
}

const nanos = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

function queryRange(p: URLSearchParams, tl: Timeline, now: number) {
    const query = p.get('query') ?? '';
    if (!query.trim()) throw new BadData('parse error: query is empty');
    const end = parseTime('end', p.get('end'), now);
    const start = parseTime('start', p.get('start'), end - 3600_000);
    if (end < start) throw new BadData('the end timestamp must not be before the start time');
    if (isMetricQuery(query)) {
        const q = parseMetricQuery(query);
        const rawStep = p.get('step');
        const step = rawStep ? parseStep(rawStep) : Math.max(Math.floor((end - start) / 1000 / 250), 1);
        if ((end - start) / 1000 / step > MAX_POINTS) {
            throw new BadData('exceeded maximum resolution of 11,000 points per timeseries. Try increasing the value of the step parameter');
        }
        const times: number[] = [];
        for (let i = 0; start / 1000 + i * step <= end / 1000 + 1e-9; i++) times.push(start / 1000 + i * step);
        const result = evaluateMetric(q, times, tl)
            .filter((s) => s.points.length)
            .map((s) => ({ metric: s.metric, values: s.points }));
        return { resultType: 'matrix', result, stats: {} };
    }
    const q = parseLogQuery(query);
    const rawLimit = p.get('limit');
    const limit = rawLimit === null || rawLimit === '' ? DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit <= 0) throw new BadData(`invalid parameter "limit": "${rawLimit}" is not a positive integer`);
    if (limit > MAX_LIMIT) throw new BadData(`max entries limit per query exceeded, limit > max_entries_limit (${limit} > ${MAX_LIMIT})`);
    const direction = (p.get('direction') || 'backward').toLowerCase();
    if (direction !== 'forward' && direction !== 'backward') throw new BadData(`invalid parameter "direction": "${direction}"`);
    checkRange(start, end);
    let entries = fillServiceLogs(start, end, tl).filter((e) => keep(q, e));
    if (direction === 'backward') entries.reverse();
    entries = entries.slice(0, limit);
    const streams = new Map<LogLevel, [string, string][]>();
    for (const e of entries) {
        const values = streams.get(e.level) ?? [];
        values.push([nanos(e.ms), e.line]);
        streams.set(e.level, values);
    }
    const result = [...streams].map(([level, values]) => ({ stream: { ...STREAM_LABELS[level] }, values }));
    return { resultType: 'streams', result, stats: {} };
}

function queryInstant(p: URLSearchParams, tl: Timeline, now: number) {
    const query = p.get('query') ?? '';
    if (!query.trim()) throw new BadData('parse error: query is empty');
    if (!isMetricQuery(query)) {
        throw new BadData('log queries are not supported as an instant query type, please change your query to a range query type');
    }
    const t = parseTime('time', p.get('time'), now) / 1000;
    const result = evaluateMetric(parseMetricQuery(query), [t], tl).flatMap((s) =>
        s.points.map((value) => ({ metric: s.metric, value })),
    );
    return { resultType: 'vector', result, stats: {} };
}

// ---------------------------------------------------------------- HTTP

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`${text}\n`);
}

const ok = (res: http.ServerResponse, data: unknown) => sendJson(res, 200, { status: 'success', data });

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

const ALL_STREAMS = Object.values(STREAM_LABELS);

/** Request handler of the fake Loki; `timeline` is read per request so restarts apply at once. */
export function lokiHandler(timeline: () => Timeline, now: () => number = Date.now): http.RequestListener {
    return (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const tl = timeline();
        const handle = async (): Promise<void> => {
            if (path === '/ready') {
                sendText(res, 200, 'ready');
                return;
            }
            if (req.method !== 'GET' && req.method !== 'POST') {
                sendText(res, 405, `method ${req.method} not allowed`);
                return;
            }
            const p = await params(req, url);
            switch (path) {
                case '/loki/api/v1/query_range':
                    ok(res, queryRange(p, tl, now()));
                    return;
                case '/loki/api/v1/query':
                    ok(res, queryInstant(p, tl, now()));
                    return;
                case '/loki/api/v1/labels':
                    ok(res, [...new Set(ALL_STREAMS.flatMap((s) => Object.keys(s)))].sort());
                    return;
                case '/loki/api/v1/series': {
                    const selectors = p.getAll('match[]').map((m) => parseLogQuery(m).selector);
                    if (!selectors.length) throw new BadData('invalid parameter "match[]": at least one selector is required');
                    ok(res, ALL_STREAMS.filter((s) => selectors.some((sel) => matches(s, sel.matchers))));
                    return;
                }
                case '/loki/api/v1/status/buildinfo':
                    sendJson(res, 200, { version: '3.1.0-demo', revision: 'demo', branch: 'demo' });
                    return;
            }
            const label = path.match(/^\/loki\/api\/v1\/label\/([^/]+)\/values$/);
            if (label) {
                const name = decodeURIComponent(label[1]);
                ok(res, [...new Set(ALL_STREAMS.map((s) => s[name]).filter((v): v is string => v !== undefined))].sort());
                return;
            }
            sendText(res, 404, `404 page not found: ${req.method} ${path}`);
        };
        handle().catch((e: unknown) => {
            if (e instanceof BadData) sendText(res, 400, e.message);
            else sendText(res, 500, e instanceof Error ? e.message : String(e));
        });
    };
}
