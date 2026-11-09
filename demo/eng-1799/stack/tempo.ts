// ENG-1799 demo: the fake Tempo (served from the telemetry-fakes process on its reserved port).
//
// Traces: fill-service "ship fill" requests. Like the other fakes, the traces at time t are a pure function of t
// and the current scenario timeline (PROGRESS.md "Scenario clock and data"); every whole second is a slot that
// holds at most one trace, and its offset, ids and timings come from a hash of the second, never Math.random().
// A trace starts in every second divisible by 15 and in about 1 of 8 other seconds (about 11 a minute).
//
// Each trace has 4 or 5 spans:
//   fill-service        SERVER    POST /fills/{fill_id}/ship                      (root)
//     fill-service      CLIENT    SELECT demo.fills                               3..32 ms
//     fill-service      CLIENT    POST shipping-label-api /v1/labels              the label call + 1..4 ms
//       shipping-label-api SERVER POST /v1/labels                                 120..479 ms, 2000..4999 ms in the incident
//     fill-service      PRODUCER  publish fill.label_created                      only when the label call succeeded
// A trace starting in [incidentAt, recoveryAt) has the slow label call (as the Loki lines), and about half of
// those fail with "context deadline exceeded" (status error on the client, server and root spans).
//
// The trace id is the slot's epoch second as 8 hex digits followed by 24 hex digits of hash, so trace(id) finds
// the trace without a time range; an id whose hash does not match its slot is unknown (404, as Tempo).
//
// API (GET), errors as Tempo's plain-text 400s:
//   /api/search          q (TraceQL), start, end (unix s; default the last hour), limit (20), minDuration,
//                        maxDuration -> {traces: [...newest first], metrics}
//   /api/traces/<id>     -> {batches: [OTLP resource spans]};  /api/v2/traces/<id> -> {trace: {resourceSpans}}
//   /api/search/tags, /api/search/tag/<tag>/values, /api/echo, /api/status/buildinfo, /ready
// TraceQL understood: one spanset filter `{ ... }` (or several joined by && / ||) holding conditions joined
// by && / || with parentheses. A condition is `<field> <op> <value>`, op one of = != > >= < <= =~ !~; fields
// are the intrinsics name, status, kind, duration, rootName, rootServiceName, traceDuration and attributes
// `resource.x`, `span.x` or `.x` (either scope). Values: "strings", numbers, durations (2s, 500ms, 1m30s),
// true/false and the status/kind enums. Pipelines (`| ...`) and structural operators answer 400.
import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { Timeline } from './clock.js';

type Status = 'ok' | 'error' | 'unset';
type Kind = 'server' | 'client' | 'producer' | 'internal';
type AttrValue = string | number | boolean;

export type Span = {
    spanId: string;
    parentSpanId?: string;
    service: string;
    name: string;
    kind: Kind;
    startMs: number;
    durationMs: number;
    status: Status;
    attributes: Record<string, AttrValue>;
};

export type Trace = {
    traceId: string;
    startMs: number;
    durationMs: number;
    spans: Span[];
};

/** Tempo's defaults: search limit 20, look-back 1 h, max search duration 168 h. */
const DEFAULT_LIMIT = 20;
const DEFAULT_LOOKBACK_S = 3600;
const MAX_RANGE_S = 7 * 24 * 3600;
const TRACE_EVERY_S = 15;

class BadRequest extends Error {}

function digest(key: string): Buffer {
    return createHash('sha256').update(key).digest();
}

/** Deterministic integer in [0, n) from a key. */
const hash = (key: string, n: number): number => digest(key).readUInt32BE(0) % n;

const hex = (key: string, digits: number): string => digest(key).toString('hex').slice(0, digits);

const RESOURCE: Record<string, Record<string, AttrValue>> = {
    'fill-service': { 'service.name': 'fill-service', 'deployment.environment': 'demo', 'service.version': '2.14.0-demo' },
    'shipping-label-api': { 'service.name': 'shipping-label-api', 'deployment.environment': 'demo', 'service.version': '1.8.3-demo' },
};

const hasTrace = (s: number) => s % TRACE_EVERY_S === 0 || hash(`tempo|has|${s}`, 8) === 0;

const traceIdOf = (s: number) => s.toString(16).padStart(8, '0') + hex(`tempo|trace|${s}`, 24);

/** The trace in the slot of second `s`, if any. */
function slot(s: number, tl: Timeline): Trace | undefined {
    if (s < 0 || s > 0xffffffff || !hasTrace(s)) return undefined;
    const traceId = traceIdOf(s);
    const spanId = (i: number) => hex(`tempo|span|${s}|${i}`, 16);
    const start = s * 1000 + hash(`tempo|offset|${s}`, 1000);
    const incident = start >= tl.incidentAt && start < tl.recoveryAt;
    const failed = incident && hash(`tempo|failed|${s}`, 2) === 0;
    const fillId = `demo-fill-${100_000 + hash(`tempo|fill|${s}`, 900_000)}`;
    const labelMs = incident ? 2000 + hash(`tempo|slow|${s}`, 3000) : 120 + hash(`tempo|fast|${s}`, 360);

    const dbStart = start + 1;
    const dbMs = 3 + hash(`tempo|db|${s}`, 30);
    const clientStart = dbStart + dbMs + 1;
    const clientMs = labelMs + 1 + hash(`tempo|client|${s}`, 4);
    const publishStart = clientStart + clientMs + 1;
    const publishMs = 1 + hash(`tempo|publish|${s}`, 8);
    const end = (failed ? clientStart + clientMs : publishStart + publishMs) + 1;
    const root: Span = {
        spanId: spanId(0),
        service: 'fill-service',
        name: 'POST /fills/{fill_id}/ship',
        kind: 'server',
        startMs: start,
        durationMs: end - start,
        status: failed ? 'error' : 'unset',
        attributes: {
            'http.request.method': 'POST',
            'http.route': '/fills/{fill_id}/ship',
            'http.response.status_code': failed ? 504 : 200,
            fill_id: fillId,
        },
    };
    const spans: Span[] = [
        root,
        {
            spanId: spanId(1),
            parentSpanId: root.spanId,
            service: 'fill-service',
            name: 'SELECT demo.fills',
            kind: 'client',
            startMs: dbStart,
            durationMs: dbMs,
            status: 'unset',
            attributes: { 'db.system': 'postgresql', 'db.operation.name': 'SELECT', 'db.collection.name': 'fills' },
        },
        {
            spanId: spanId(2),
            parentSpanId: root.spanId,
            service: 'fill-service',
            name: 'POST shipping-label-api /v1/labels',
            kind: 'client',
            startMs: clientStart,
            durationMs: clientMs,
            status: failed ? 'error' : 'unset',
            attributes: {
                'http.request.method': 'POST',
                'server.address': 'shipping-label-api',
                'peer.service': 'shipping-label-api',
                ...(failed ? { 'error.type': 'context deadline exceeded' } : { 'http.response.status_code': 201 }),
            },
        },
        {
            spanId: spanId(3),
            parentSpanId: spanId(2),
            service: 'shipping-label-api',
            name: 'POST /v1/labels',
            kind: 'server',
            startMs: clientStart + 1,
            durationMs: labelMs,
            status: failed ? 'error' : 'unset',
            attributes: {
                'http.request.method': 'POST',
                'http.route': '/v1/labels',
                'http.response.status_code': failed ? 504 : 201,
                carrier: 'DEMO-CARRIER',
                fill_id: fillId,
            },
        },
    ];
    if (!failed) {
        spans.push({
            spanId: spanId(4),
            parentSpanId: root.spanId,
            service: 'fill-service',
            name: 'publish fill.label_created',
            kind: 'producer',
            startMs: publishStart,
            durationMs: publishMs,
            status: 'unset',
            attributes: { 'messaging.system': 'sqs', 'messaging.destination.name': 'hrx-demo-fill-events' },
        });
    }
    return { traceId, startMs: start, durationMs: end - start, spans };
}

/** Every fill-service trace starting in [fromMs, toMs), oldest first. */
export function fillServiceTraces(fromMs: number, toMs: number, tl: Timeline): Trace[] {
    const out: Trace[] = [];
    for (let s = Math.floor(fromMs / 1000); s * 1000 < toMs; s++) {
        const t = slot(s, tl);
        if (t && t.startMs >= fromMs && t.startMs < toMs) out.push(t);
    }
    return out;
}

/** The trace with this id (hex, case-insensitive, leading zeros optional), or undefined. */
export function traceById(id: string, tl: Timeline): Trace | undefined {
    const canonical = id.toLowerCase().padStart(32, '0');
    const t = slot(parseInt(canonical.slice(0, 8), 16), tl);
    return t && t.traceId === canonical ? t : undefined;
}

// ---------------------------------------------------------------- TraceQL (the small subset the demo needs)

type Value = { type: 'string'; v: string } | { type: 'number'; v: number } | { type: 'bool'; v: boolean } | { type: 'enum'; v: string };
type Op = '=' | '!=' | '>' | '>=' | '<' | '<=' | '=~' | '!~';
type Field = { kind: 'intrinsic'; name: string } | { kind: 'attribute'; scope: 'resource' | 'span' | 'any'; name: string };
type Cond = { field: Field; op: Op; value: Value; re?: RegExp };
type Expr = { and: Expr[] } | { or: Expr[] } | { cond: Cond } | { all: true };
type Query = { spansets: Expr[]; join: '&&' | '||' };

const INTRINSICS = new Set(['name', 'status', 'kind', 'duration', 'rootName', 'rootServiceName', 'traceDuration']);
const ENUMS = new Set(['ok', 'error', 'unset', 'server', 'client', 'producer', 'consumer', 'internal', 'unspecified']);
const DURATION_UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** A Go-style duration such as 2s, 500ms, 1m30s, 1.5s, in ms; undefined when it is not one. */
function parseDuration(raw: string): number | undefined {
    if (!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(raw)) return undefined;
    let ms = 0;
    for (const m of raw.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) ms += Number(m[1]) * DURATION_UNITS[m[2]];
    return ms;
}

type Token = { t: string; pos: number };

function tokenize(src: string): Token[] {
    const out: Token[] = [];
    const re = /\s*("(?:[^"\\]|\\.)*"|`[^`]*`|&&|\|\||!=|>=|<=|=~|!~|[{}()=<>|!]|[A-Za-z0-9_.:µ-]+)/y;
    let i = 0;
    while (i < src.length) {
        if (/^\s*$/.test(src.slice(i))) break;
        re.lastIndex = i;
        const m = re.exec(src);
        if (!m) throw new BadRequest(`invalid TraceQL query: parse error at position ${i}: unexpected "${src.slice(i).trim()[0]}"`);
        out.push({ t: m[1], pos: i + m[0].length - m[1].length });
        i = re.lastIndex;
    }
    return out;
}

function parseQuery(src: string): Query {
    const toks = tokenize(src);
    let i = 0;
    const peek = () => toks[i]?.t;
    const fail = (what: string): never => {
        const at = toks[i];
        throw new BadRequest(`invalid TraceQL query: parse error at position ${at ? at.pos : src.length}: ${what}${at ? `, got "${at.t}"` : ''}`);
    };
    const expect = (t: string) => (peek() === t ? toks[i++] : fail(`expected "${t}"`));

    const value = (): Value => {
        const t = toks[i++]?.t;
        if (t === undefined) return fail('expected a value');
        if (t.startsWith('"')) return { type: 'string', v: JSON.parse(t) as string };
        if (t.startsWith('`')) return { type: 'string', v: t.slice(1, -1) };
        if (t === 'true' || t === 'false') return { type: 'bool', v: t === 'true' };
        if (ENUMS.has(t)) return { type: 'enum', v: t };
        if (/^-?\d+(\.\d+)?$/.test(t)) return { type: 'number', v: Number(t) };
        const d = parseDuration(t);
        if (d !== undefined) return { type: 'number', v: d };
        i--;
        return fail('expected a value');
    };
    const field = (): Field => {
        const t = toks[i++]?.t;
        if (t === undefined) return fail('expected a field');
        if (INTRINSICS.has(t)) return { kind: 'intrinsic', name: t };
        const m = t.match(/^(resource|span)?\.([A-Za-z_][A-Za-z0-9_.:-]*)$/);
        if (m) return { kind: 'attribute', scope: (m[1] as 'resource' | 'span' | undefined) ?? 'any', name: m[2] };
        i--;
        return fail('expected an intrinsic or an attribute (resource.x, span.x, .x)');
    };
    const cond = (): Expr => {
        const f = field();
        const op = peek();
        if (!op || !['=', '!=', '>', '>=', '<', '<=', '=~', '!~'].includes(op)) return fail('expected an operator');
        i++;
        const c: Cond = { field: f, op: op as Op, value: value() };
        if (c.op === '=~' || c.op === '!~') {
            if (c.value.type !== 'string') throw new BadRequest(`invalid TraceQL query: ${c.op} needs a string`);
            try {
                c.re = new RegExp(`^(?:${c.value.v})$`);
            } catch {
                throw new BadRequest(`invalid TraceQL query: invalid regular expression "${c.value.v}"`);
            }
        }
        return { cond: c };
    };
    const primary = (): Expr => {
        if (peek() !== '(') return cond();
        i++;
        const e = or();
        expect(')');
        return e;
    };
    const and = (): Expr => {
        const xs = [primary()];
        while (peek() === '&&') {
            i++;
            xs.push(primary());
        }
        return xs.length === 1 ? xs[0] : { and: xs };
    };
    const or = (): Expr => {
        const xs = [and()];
        while (peek() === '||') {
            i++;
            xs.push(and());
        }
        return xs.length === 1 ? xs[0] : { or: xs };
    };
    const spanset = (): Expr => {
        expect('{');
        if (peek() === '}') {
            i++;
            return { all: true };
        }
        const e = or();
        expect('}');
        return e;
    };

    if (!toks.length) return { spansets: [{ all: true }], join: '&&' };
    const spansets = [spanset()];
    let join: Query['join'] = '&&';
    while (peek() === '&&' || peek() === '||') {
        if (spansets.length > 1 && peek() !== join) fail('mixing && and || between spansets is not supported by the fake Tempo');
        join = toks[i++].t as Query['join'];
        spansets.push(spanset());
    }
    if (i < toks.length) {
        fail(peek() === '|' ? 'the fake Tempo does not support pipelines' : 'the fake Tempo understands only spanset filters joined by && or ||');
    }
    return { spansets, join };
}

function fieldValue(f: Field, span: Span, trace: Trace): AttrValue | undefined {
    if (f.kind === 'intrinsic') {
        const root = trace.spans[0];
        switch (f.name) {
            case 'name':
                return span.name;
            case 'status':
                return span.status;
            case 'kind':
                return span.kind;
            case 'duration':
                return span.durationMs;
            case 'rootName':
                return root.name;
            case 'rootServiceName':
                return root.service;
            case 'traceDuration':
                return trace.durationMs;
        }
        return undefined;
    }
    const resource = RESOURCE[span.service] ?? { 'service.name': span.service };
    if (f.scope === 'resource') return resource[f.name];
    if (f.scope === 'span') return span.attributes[f.name];
    return span.attributes[f.name] ?? resource[f.name];
}

function test(c: Cond, actual: AttrValue | undefined): boolean {
    if (actual === undefined) return false;
    const expected = c.value.v;
    if (c.re) return typeof actual === 'string' && c.re.test(actual) === (c.op === '=~');
    if (typeof actual !== typeof expected) return false;
    switch (c.op) {
        case '=':
            return actual === expected;
        case '!=':
            return actual !== expected;
        case '>':
            return actual > expected;
        case '>=':
            return actual >= expected;
        case '<':
            return actual < expected;
        case '<=':
            return actual <= expected;
    }
    return false;
}

function evaluate(e: Expr, span: Span, trace: Trace): boolean {
    if ('all' in e) return true;
    if ('and' in e) return e.and.every((x) => evaluate(x, span, trace));
    if ('or' in e) return e.or.some((x) => evaluate(x, span, trace));
    return test(e.cond, fieldValue(e.cond.field, span, trace));
}

/** The spans of the trace matching the query, or undefined when the trace does not match. */
function matchQuery(q: Query, trace: Trace): Span[] | undefined {
    const sets = q.spansets.map((e) => trace.spans.filter((s) => evaluate(e, s, trace)));
    const hit = q.join === '&&' ? sets.every((s) => s.length) : sets.some((s) => s.length);
    return hit ? [...new Set(sets.flat())] : undefined;
}

// ---------------------------------------------------------------- HTTP answers

const nanos = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();

function attributes(values: Record<string, AttrValue>) {
    return Object.entries(values).map(([key, v]) => ({
        key,
        value:
            typeof v === 'string'
                ? { stringValue: v }
                : typeof v === 'boolean'
                  ? { boolValue: v }
                  : Number.isInteger(v)
                    ? { intValue: String(v) }
                    : { doubleValue: v },
    }));
}

const hexToBase64 = (h: string) => Buffer.from(h, 'hex').toString('base64');

const KINDS: Record<Kind, string> = {
    server: 'SPAN_KIND_SERVER',
    client: 'SPAN_KIND_CLIENT',
    producer: 'SPAN_KIND_PRODUCER',
    internal: 'SPAN_KIND_INTERNAL',
};
const STATUSES: Record<Status, string> = { ok: 'STATUS_CODE_OK', error: 'STATUS_CODE_ERROR', unset: 'STATUS_CODE_UNSET' };

/** The trace as OTLP resource spans (protobuf JSON mapping): one resource per service, in first-seen order. */
function resourceSpans(trace: Trace) {
    const byService = new Map<string, Record<string, unknown>[]>();
    for (const s of trace.spans) {
        const otlp: Record<string, unknown> = {
            traceId: hexToBase64(trace.traceId),
            spanId: hexToBase64(s.spanId),
            ...(s.parentSpanId ? { parentSpanId: hexToBase64(s.parentSpanId) } : {}),
            name: s.name,
            kind: KINDS[s.kind],
            startTimeUnixNano: nanos(s.startMs),
            endTimeUnixNano: nanos(s.startMs + s.durationMs),
            attributes: attributes(s.attributes),
            status: s.status === 'error' ? { code: STATUSES.error, message: 'context deadline exceeded' } : { code: STATUSES[s.status] },
        };
        const list = byService.get(s.service) ?? [];
        list.push(otlp);
        byService.set(s.service, list);
    }
    return [...byService].map(([service, spans]) => ({
        resource: { attributes: attributes(RESOURCE[service] ?? { 'service.name': service }) },
        scopeSpans: [{ scope: { name: 'demo-synthetic' }, spans }],
    }));
}

function searchEntry(trace: Trace, matched: Span[]) {
    const root = trace.spans[0];
    const spanSet = {
        spans: matched.slice(0, 3).map((s) => ({
            spanID: s.spanId,
            name: s.name,
            startTimeUnixNano: nanos(s.startMs),
            durationNanos: nanos(s.durationMs),
            attributes: attributes({ 'service.name': s.service }),
        })),
        matched: matched.length,
    };
    return {
        traceID: trace.traceId,
        rootServiceName: root.service,
        rootTraceName: root.name,
        startTimeUnixNano: nanos(trace.startMs),
        durationMs: trace.durationMs,
        spanSet,
        spanSets: [spanSet],
    };
}

function unixSeconds(name: string, raw: string | null, fallback: number): number {
    if (raw === null || raw === '') return fallback;
    if (!/^\d+$/.test(raw)) throw new BadRequest(`invalid ${name}: ${raw}`);
    return Number(raw);
}

function durationParam(name: string, raw: string | null): number | undefined {
    if (raw === null || raw === '') return undefined;
    const ms = parseDuration(raw);
    if (ms === undefined) throw new BadRequest(`invalid ${name}: ${raw}`);
    return ms;
}

function search(p: URLSearchParams, tl: Timeline, nowMs: number) {
    const query = parseQuery(p.get('q') ?? '');
    const rawLimit = p.get('limit');
    const limit = rawLimit === null || rawLimit === '' ? DEFAULT_LIMIT : Number(rawLimit);
    if (!/^\d+$/.test(rawLimit ?? '0') || !Number.isSafeInteger(limit) || limit <= 0) throw new BadRequest(`invalid limit: ${rawLimit}`);
    const end = unixSeconds('end', p.get('end'), Math.ceil(nowMs / 1000));
    const start = unixSeconds('start', p.get('start'), end - DEFAULT_LOOKBACK_S);
    if (end < start) throw new BadRequest('invalid start: start must be before end');
    if (end - start > MAX_RANGE_S) throw new BadRequest(`range specified by start and end exceeds 168h0m0s. received start=${start} end=${end}`);
    const minDuration = durationParam('minDuration', p.get('minDuration'));
    const maxDuration = durationParam('maxDuration', p.get('maxDuration'));
    const found: ReturnType<typeof searchEntry>[] = [];
    const candidates = fillServiceTraces(start * 1000, (end + 1) * 1000, tl);
    for (const trace of candidates.reverse()) {
        if (minDuration !== undefined && trace.durationMs < minDuration) continue;
        if (maxDuration !== undefined && trace.durationMs > maxDuration) continue;
        const matched = matchQuery(query, trace);
        if (matched) found.push(searchEntry(trace, matched));
        if (found.length >= limit) break;
    }
    return { traces: found, metrics: { inspectedTraces: candidates.length, completedJobs: 1, totalJobs: 1 } };
}

// Tag names and values the search API lists (the attributes the generator writes).
function tags(scope: 'resource' | 'span'): string[] {
    if (scope === 'resource') return [...new Set(Object.values(RESOURCE).flatMap((r) => Object.keys(r)))].sort();
    // Second 0 holds a trace (0 is divisible by TRACE_EVERY_S); a successful one carries every span attribute
    // but error.type, which only failed label calls have.
    const sample = slot(0, { startedAt: 0, incidentAt: 0, recoveryAt: 0 })!;
    return [...new Set(sample.spans.flatMap((s) => Object.keys(s.attributes)).concat('error.type'))].sort();
}

function tagValues(tag: string, tl: Timeline, nowMs: number): AttrValue[] {
    const name = tag.replace(/^(resource|span)?\./, '');
    const seen = new Set<AttrValue>();
    const nowS = Math.floor(nowMs / 1000);
    for (const t of fillServiceTraces((nowS - 900) * 1000, nowMs + 1, tl)) {
        for (const s of t.spans) {
            const v = INTRINSICS.has(tag)
                ? fieldValue({ kind: 'intrinsic', name: tag }, s, t)
                : fieldValue({ kind: 'attribute', scope: tag.startsWith('resource.') ? 'resource' : tag.startsWith('span.') ? 'span' : 'any', name }, s, t);
            if (v !== undefined && typeof v !== 'number') seen.add(v);
        }
        if (seen.size > 50) break;
    }
    return [...seen].sort();
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`${text}\n`);
}

/** Request handler of the fake Tempo; `timeline` is read per request so restarts apply at once. */
export function tempoHandler(timeline: () => Timeline, now: () => number = Date.now): http.RequestListener {
    return (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const tl = timeline();
        try {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendText(res, 405, `method ${req.method} not allowed`);
                return;
            }
            switch (path) {
                case '/ready':
                    sendText(res, 200, 'ready');
                    return;
                case '/api/echo':
                    sendText(res, 200, 'echo');
                    return;
                case '/api/status/buildinfo':
                    sendJson(res, 200, { version: '2.6.0-demo', revision: 'demo', branch: 'demo' });
                    return;
                case '/api/search':
                    sendJson(res, 200, search(url.searchParams, tl, now()));
                    return;
                case '/api/search/tags':
                    sendJson(res, 200, { tagNames: [...tags('resource'), ...tags('span')] });
                    return;
                case '/api/v2/search/tags':
                    sendJson(res, 200, {
                        scopes: [
                            { name: 'resource', tags: tags('resource') },
                            { name: 'span', tags: tags('span') },
                            { name: 'intrinsic', tags: [...INTRINSICS].sort() },
                        ],
                    });
                    return;
            }
            const values = path.match(/^\/api\/(v2\/)?search\/tag\/([^/]+)\/values$/);
            if (values) {
                const vs = tagValues(decodeURIComponent(values[2]), tl, now());
                sendJson(
                    res,
                    200,
                    values[1]
                        ? { tagValues: vs.map((v) => ({ type: typeof v === 'boolean' ? 'bool' : 'string', value: String(v) })) }
                        : { tagValues: vs.map(String) },
                );
                return;
            }
            const m = path.match(/^\/api\/(v2\/)?traces\/([^/]+)$/);
            if (m) {
                const id = decodeURIComponent(m[2]);
                if (!/^[0-9a-f]{1,32}$/i.test(id)) throw new BadRequest(`invalid trace id: ${id}`);
                const trace = traceById(id, tl);
                if (!trace) {
                    sendText(res, 404, 'trace not found');
                    return;
                }
                const batches = resourceSpans(trace);
                sendJson(res, 200, m[1] ? { trace: { resourceSpans: batches } } : { batches });
                return;
            }
            sendText(res, 404, `404 page not found: ${req.method} ${path}`);
        } catch (e: unknown) {
            if (e instanceof BadRequest) sendText(res, 400, e.message);
            else sendText(res, 500, e instanceof Error ? e.message : String(e));
        }
    };
}
