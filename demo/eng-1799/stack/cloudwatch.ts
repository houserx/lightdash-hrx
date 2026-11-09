// ENG-1799 demo: the fake CloudWatch metrics API (served from the telemetry-fakes process on its reserved port).
//
// Metric: AWS/SQS ApproximateNumberOfMessagesVisible{QueueName="hrx-demo-fill-queue"}, the depth of the SQS
// queue in front of fill-service. Like the other fakes, the value at time t is a pure function of t and the
// current scenario timeline (PROGRESS.md "Scenario clock and data"): the fake holds one raw sample every 10 s
// (epoch-aligned), its jitter a hash of the sample time, never Math.random(). Samples later than "now" do
// not exist yet, so a bucket is computed from the samples that already happened and an empty one is left out.
//
//   baseline  20..50; from incidentAt it ramps up over 20 s to 150..190 and stays there until recoveryAt;
//             then it falls back over 30 s. So every bucket inside [incidentAt+20s, recoveryAt) is at least
//             150 whatever the statistic, and every bucket before incidentAt or after recoveryAt+30s at most 50.
//
// API: GetMetricData only, in the two protocols an AWS SDK may speak to CloudWatch:
//   Smithy RPC v2 CBOR  POST /service/GraniteServiceVersion20100801/operation/GetMetricData  (what the
//                       engine's aws-sdk-cloudwatch sends)
//   AWS JSON 1.0        POST /  with X-Amz-Target: GraniteServiceVersion20100801.GetMetricData  (timestamps as
//                       epoch seconds; handy with curl)
//   GET /ready          -> 200 "ready" (not an AWS route; up.sh checks it)
// Requests are not signature-checked (the engine signs with fake credentials). Buckets start at StartTime and
// follow every Period from there (StartTime is NOT rounded to wall-clock minutes; the engine passes it through
// unaligned) while they start before EndTime. Statistics: Average, Sum, Minimum, Maximum, SampleCount and
// percentiles pNN(.N). An unknown metric, or a Unit other than the metric's, gives a Complete result with no
// datapoints, as CloudWatch does. Expression queries (SEARCH, metric math) answer 400; extend `queryResult`
// if a later feature needs them. NextToken paging follows MaxDatapoints.
import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { Timeline } from './clock.js';

export const NAMESPACE = 'AWS/SQS';
export const METRIC_NAME = 'ApproximateNumberOfMessagesVisible';
export const QUEUE_NAME = 'hrx-demo-fill-queue';
const SERVICE = 'GraniteServiceVersion20100801';
const SAMPLE_INTERVAL_S = 10;
const DEFAULT_MAX_DATAPOINTS = 100_800;
/** The fake computes at most this many buckets per request; a longer range at a short period answers 400. */
const MAX_BUCKETS = 200_000;
const MAX_QUERIES = 500;
const MAX_BODY_BYTES = 1024 * 1024;

/** Deterministic integer in [0, n) from a key. */
function hash(key: string, n: number): number {
    return createHash('sha256').update(key).digest().readUInt32BE(0) % n;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * Math.min(1, Math.max(0, f));
const RAMP_UP_MS = 20_000;
const RAMP_DOWN_MS = 30_000;

/** The fill queue's visible messages at sample time t (epoch seconds, a multiple of SAMPLE_INTERVAL_S). */
export function fillQueueDepth(t: number, tl: Timeline): number {
    const baseline = 20 + hash(`sqs|fill|base|${t}`, 31); // 20..50
    const incident = 150 + hash(`sqs|fill|incident|${t}`, 41); // 150..190
    const ms = t * 1000;
    if (ms < tl.incidentAt) return baseline;
    if (ms < tl.recoveryAt) return Math.round(lerp(baseline, incident, (ms - tl.incidentAt) / RAMP_UP_MS));
    return Math.round(lerp(incident, baseline, (ms - tl.recoveryAt) / RAMP_DOWN_MS));
}

type Dimension = { Name: string; Value: string };
type MetricDef = {
    namespace: string;
    metricName: string;
    dimensions: Dimension[];
    unit: string;
    value: (t: number, tl: Timeline) => number;
};

const METRICS: MetricDef[] = [
    {
        namespace: NAMESPACE,
        metricName: METRIC_NAME,
        dimensions: [{ Name: 'QueueName', Value: QUEUE_NAME }],
        unit: 'Count',
        value: fillQueueDepth,
    },
];

/** A request the fake (like CloudWatch) refuses: HTTP 400 with an AWS error code. */
export class AwsError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

// ---------------------------------------------------------------- CBOR (RFC 8949, the part RPC v2 needs)

/** An epoch-seconds timestamp (CBOR tag 1). */
export class Timestamp {
    constructor(readonly seconds: number) {}
}

/** A list of doubles: written as CBOR floats even when whole (the SDK reads Values as doubles). */
class Doubles {
    constructor(readonly values: number[]) {}
}

type Wire = null | undefined | boolean | number | string | Timestamp | Doubles | Wire[] | { [k: string]: Wire };

export function encodeCbor(value: Wire): Buffer {
    const out: Buffer[] = [];
    const head = (major: number, n: number) => {
        if (n < 24) out.push(Buffer.from([(major << 5) | n]));
        else if (n < 0x100) out.push(Buffer.from([(major << 5) | 24, n]));
        else if (n < 0x10000) {
            const b = Buffer.alloc(3);
            b[0] = (major << 5) | 25;
            b.writeUInt16BE(n, 1);
            out.push(b);
        } else if (n < 0x100000000) {
            const b = Buffer.alloc(5);
            b[0] = (major << 5) | 26;
            b.writeUInt32BE(n, 1);
            out.push(b);
        } else {
            const b = Buffer.alloc(9);
            b[0] = (major << 5) | 27;
            b.writeBigUInt64BE(BigInt(n), 1);
            out.push(b);
        }
    };
    const float = (x: number) => {
        const b = Buffer.alloc(9);
        b[0] = 0xfb;
        b.writeDoubleBE(x, 1);
        out.push(b);
    };
    const walk = (v: Wire) => {
        if (v === null || v === undefined) out.push(Buffer.from([0xf6]));
        else if (typeof v === 'boolean') out.push(Buffer.from([v ? 0xf5 : 0xf4]));
        else if (typeof v === 'number') {
            if (Number.isSafeInteger(v)) head(v < 0 ? 1 : 0, v < 0 ? -1 - v : v);
            else float(v);
        } else if (typeof v === 'string') {
            const b = Buffer.from(v, 'utf8');
            head(3, b.length);
            out.push(b);
        } else if (v instanceof Timestamp) {
            head(6, 1);
            float(v.seconds);
        } else if (v instanceof Doubles) {
            head(4, v.values.length);
            v.values.forEach(float);
        } else if (Array.isArray(v)) {
            head(4, v.length);
            v.forEach(walk);
        } else {
            const entries = Object.entries(v).filter(([, x]) => x !== undefined);
            head(5, entries.length);
            for (const [k, x] of entries) {
                walk(k);
                walk(x);
            }
        }
    };
    walk(value);
    return Buffer.concat(out);
}

const BREAK = Symbol('break');

/** Decodes one CBOR item (definite or indefinite lengths). Tag 1 becomes a Timestamp; other tags their content. */
export function decodeCbor(buf: Buffer): unknown {
    let pos = 0;
    const need = (n: number) => {
        if (pos + n > buf.length) throw new AwsError('SerializationException', 'truncated CBOR body');
    };
    const argument = (info: number): number => {
        if (info < 24) return info;
        const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
        if (!size) throw new AwsError('SerializationException', `unsupported CBOR additional info ${info}`);
        need(size);
        const n =
            size === 1
                ? buf[pos]
                : size === 2
                  ? buf.readUInt16BE(pos)
                  : size === 4
                    ? buf.readUInt32BE(pos)
                    : Number(buf.readBigUInt64BE(pos));
        pos += size;
        return n;
    };
    const item = (depth: number): unknown => {
        if (depth > 64) throw new AwsError('SerializationException', 'CBOR nested too deeply');
        need(1);
        const byte = buf[pos++];
        const major = byte >> 5;
        const info = byte & 0x1f;
        const indefinite = info === 31;
        switch (major) {
            case 0:
                return argument(info);
            case 1:
                return -1 - argument(info);
            case 2:
            case 3: {
                const chunks: Buffer[] = [];
                if (indefinite) {
                    for (let c = item(depth + 1); c !== BREAK; c = item(depth + 1)) {
                        chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : (c as Buffer));
                    }
                } else {
                    const n = argument(info);
                    need(n);
                    chunks.push(buf.subarray(pos, pos + n));
                    pos += n;
                }
                const all = Buffer.concat(chunks);
                return major === 3 ? all.toString('utf8') : all;
            }
            case 4: {
                const list: unknown[] = [];
                if (indefinite) for (let x = item(depth + 1); x !== BREAK; x = item(depth + 1)) list.push(x);
                else for (let i = argument(info); i > 0; i--) list.push(item(depth + 1));
                return list;
            }
            case 5: {
                const map: Record<string, unknown> = {};
                const pair = (k: unknown) => {
                    if (typeof k !== 'string') throw new AwsError('SerializationException', 'CBOR map key is not a string');
                    map[k] = item(depth + 1);
                };
                if (indefinite) for (let k = item(depth + 1); k !== BREAK; k = item(depth + 1)) pair(k);
                else for (let i = argument(info); i > 0; i--) pair(item(depth + 1));
                return map;
            }
            case 6: {
                const tag = argument(info);
                const content = item(depth + 1);
                return tag === 1 && typeof content === 'number' ? new Timestamp(content) : content;
            }
            default: {
                if (info === 20) return false;
                if (info === 21) return true;
                if (info === 22 || info === 23) return null;
                if (info === 31) return BREAK;
                if (info === 25) {
                    need(2);
                    const h = buf.readUInt16BE(pos);
                    pos += 2;
                    const exp = (h >> 10) & 0x1f;
                    const frac = h & 0x3ff;
                    const sign = h & 0x8000 ? -1 : 1;
                    if (exp === 0) return sign * frac * 2 ** -24;
                    if (exp === 31) return frac ? NaN : sign * Infinity;
                    return sign * (1 + frac / 1024) * 2 ** (exp - 15);
                }
                if (info === 26) {
                    need(4);
                    pos += 4;
                    return buf.readFloatBE(pos - 4);
                }
                if (info === 27) {
                    need(8);
                    pos += 8;
                    return buf.readDoubleBE(pos - 8);
                }
                throw new AwsError('SerializationException', `unsupported CBOR simple value ${info}`);
            }
        }
    };
    if (buf.length === 0) return {};
    const value = item(0);
    if (value === BREAK || pos !== buf.length) throw new AwsError('SerializationException', 'malformed CBOR body');
    return value;
}

// ---------------------------------------------------------------- GetMetricData

type Row = { t: number; v: number };
type Result = { Id: string; Label: string; rows: Row[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Epoch seconds of a request timestamp: a CBOR tag-1 value, or (AWS JSON) a number or an ISO string. */
function seconds(v: unknown, name: string): number {
    if (v instanceof Timestamp) return v.seconds;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return Date.parse(v) / 1000;
    throw new AwsError('ValidationError', `The parameter ${name} is required and must be a timestamp.`);
}

function aggregate(stat: string, values: number[]): number {
    switch (stat) {
        case 'Maximum':
            return Math.max(...values);
        case 'Minimum':
            return Math.min(...values);
        case 'Sum':
            return values.reduce((a, b) => a + b, 0);
        case 'Average':
            return values.reduce((a, b) => a + b, 0) / values.length;
        case 'SampleCount':
            return values.length;
        default: {
            // pNN or pNN.N: nearest rank.
            const p = Number(stat.slice(1));
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
        }
    }
}

function validStat(stat: unknown): stat is string {
    if (typeof stat !== 'string') return false;
    if (['Maximum', 'Minimum', 'Sum', 'Average', 'SampleCount'].includes(stat)) return true;
    const m = stat.match(/^p(\d{1,2}(\.\d{1,2})?|100)$/);
    return m !== null && Number(stat.slice(1)) <= 100;
}

function sameDimensions(a: Dimension[], b: Dimension[]): boolean {
    if (a.length !== b.length) return false;
    const key = (d: Dimension) => `${d.Name}\u0000${d.Value}`;
    const set = new Set(a.map(key));
    return b.every((d) => set.has(key(d)));
}

/** Parses and checks one MetricDataQuery; returns what the result needs. */
function parseQuery(q: unknown) {
    if (!isObject(q)) throw new AwsError('ValidationError', 'Each MetricDataQueries member must be a structure.');
    const id = q.Id;
    if (typeof id !== 'string' || !/^[a-z][a-zA-Z0-9_]*$/.test(id) || id.length > 255) {
        throw new AwsError(
            'ValidationError',
            `The value ${JSON.stringify(id ?? null)} for parameter MetricDataQueries.member.Id is invalid: it must start with a lowercase letter and contain only letters, digits and underscores.`,
        );
    }
    if (q.Expression !== undefined && q.Expression !== null) {
        throw new AwsError(
            'InvalidParameterValue',
            `The demo's fake CloudWatch answers MetricStat queries only, not Expression (query ${id}).`,
        );
    }
    const stat = q.MetricStat;
    if (!isObject(stat) || !isObject(stat.Metric)) {
        throw new AwsError('ValidationError', `Query ${id} must have a MetricStat with a Metric.`);
    }
    const metric = stat.Metric;
    if (typeof metric.Namespace !== 'string' || typeof metric.MetricName !== 'string') {
        throw new AwsError('ValidationError', `Query ${id}: Metric needs a Namespace and a MetricName.`);
    }
    const dims = (metric.Dimensions ?? []) as unknown;
    if (!Array.isArray(dims) || !dims.every((d) => isObject(d) && typeof d.Name === 'string' && typeof d.Value === 'string')) {
        throw new AwsError('ValidationError', `Query ${id}: each dimension needs a Name and a Value.`);
    }
    const period = stat.Period;
    if (typeof period !== 'number' || !Number.isInteger(period) || period <= 0) {
        throw new AwsError('ValidationError', `Query ${id}: Period must be a positive whole number of seconds.`);
    }
    if (!validStat(stat.Stat)) {
        throw new AwsError('InvalidParameterValue', `Query ${id}: the statistic ${JSON.stringify(stat.Stat ?? null)} is not valid.`);
    }
    if (q.ReturnData === false) return undefined;
    const def = METRICS.find(
        (m) =>
            m.namespace === metric.Namespace &&
            m.metricName === metric.MetricName &&
            sameDimensions(m.dimensions, dims as Dimension[]) &&
            (stat.Unit === undefined || stat.Unit === null || stat.Unit === m.unit),
    );
    return {
        id,
        label: typeof q.Label === 'string' && q.Label !== '' ? q.Label : metric.MetricName,
        period,
        stat: stat.Stat,
        def,
    };
}

/** The whole answer of one GetMetricData call (all pages), ascending or descending. */
export function getMetricData(input: Record<string, unknown>, tl: Timeline, nowMs: number) {
    const start = seconds(input.StartTime, 'StartTime');
    const end = seconds(input.EndTime, 'EndTime');
    if (!(end > start)) throw new AwsError('ValidationError', 'The parameter StartTime must be less than the parameter EndTime.');
    const queries = input.MetricDataQueries;
    if (!Array.isArray(queries) || queries.length === 0 || queries.length > MAX_QUERIES) {
        throw new AwsError('ValidationError', `MetricDataQueries must hold 1 to ${MAX_QUERIES} queries.`);
    }
    const parsed = queries.map(parseQuery);
    const ids = new Set<string>();
    for (const q of parsed) {
        if (!q) continue;
        if (ids.has(q.id)) throw new AwsError('ValidationError', `The Id ${q.id} is used by more than one query.`);
        ids.add(q.id);
    }
    const descending = input.ScanBy === 'TimestampDescending';
    if (input.ScanBy !== undefined && input.ScanBy !== 'TimestampAscending' && !descending) {
        throw new AwsError('ValidationError', 'ScanBy must be TimestampAscending or TimestampDescending.');
    }
    // Samples after now do not exist yet.
    const last = Math.min(end, nowMs / 1000);
    let budget = MAX_BUCKETS;
    const results: Result[] = [];
    for (const q of parsed) {
        if (!q) continue;
        const rows: Row[] = [];
        if (q.def && last > start) {
            const buckets = Math.ceil((last - start) / q.period);
            budget -= buckets;
            if (budget < 0) {
                throw new AwsError(
                    'InvalidParameterCombination',
                    `The demo's fake CloudWatch computes at most ${MAX_BUCKETS} datapoints per request; use a longer Period or a shorter range.`,
                );
            }
            for (let i = 0; i < buckets; i++) {
                const from = start + i * q.period;
                const to = Math.min(from + q.period, last);
                const values: number[] = [];
                for (let s = Math.ceil(from / SAMPLE_INTERVAL_S) * SAMPLE_INTERVAL_S; s < to; s += SAMPLE_INTERVAL_S) {
                    values.push(q.def.value(s, tl));
                }
                if (values.length) rows.push({ t: from, v: aggregate(q.stat, values) });
            }
        }
        if (descending) rows.reverse();
        results.push({ Id: q.id, Label: q.label, rows });
    }
    return results;
}

/** One page of the answer: datapoints [offset, offset + max) counted across the results in order. */
function page(results: Result[], offset: number, max: number) {
    let skip = offset;
    let room = max;
    const out = results.map((r) => {
        const from = Math.min(skip, r.rows.length);
        skip -= from;
        const rows = r.rows.slice(from, from + room);
        room -= rows.length;
        return { Id: r.Id, Label: r.Label, StatusCode: 'Complete', rows };
    });
    const total = results.reduce((n, r) => n + r.rows.length, 0);
    return { out, next: offset + max < total ? Buffer.from(JSON.stringify({ o: offset + max })).toString('base64') : undefined };
}

function pageArgs(input: Record<string, unknown>): { offset: number; max: number } {
    const max = input.MaxDatapoints ?? DEFAULT_MAX_DATAPOINTS;
    if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
        throw new AwsError('ValidationError', 'MaxDatapoints must be a positive whole number.');
    }
    let offset = 0;
    if (typeof input.NextToken === 'string' && input.NextToken !== '') {
        try {
            offset = (JSON.parse(Buffer.from(input.NextToken, 'base64').toString('utf8')) as { o: number }).o;
        } catch {
            offset = NaN;
        }
        if (!Number.isInteger(offset) || offset < 0) throw new AwsError('InvalidNextToken', 'The NextToken is not valid.');
    }
    return { offset, max };
}

// ---------------------------------------------------------------- HTTP

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new AwsError('SerializationException', 'request body too large');
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

type Protocol = 'cbor' | 'json';

function reply(res: http.ServerResponse, protocol: Protocol, status: number, body: Wire): void {
    if (protocol === 'cbor') {
        res.writeHead(status, {
            'content-type': 'application/cbor',
            'smithy-protocol': 'rpc-v2-cbor',
            'x-amzn-requestid': 'demo-fake-cloudwatch',
        });
        res.end(encodeCbor(body));
        return;
    }
    const json = JSON.stringify(body, (_k, v: unknown) =>
        v instanceof Timestamp ? v.seconds : v instanceof Doubles ? v.values : v,
    );
    res.writeHead(status, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-requestid': 'demo-fake-cloudwatch' });
    res.end(json);
}

/** The HTTP handler of the fake CloudWatch. `timeline` is read per request. */
export function cloudwatchHandler(timeline: () => Timeline, now: () => number = Date.now): http.RequestListener {
    return (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/ready') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('ready\n');
            return;
        }
        let protocol: Protocol;
        let operation: string;
        const cbor = url.pathname.match(/^\/service\/([^/]+)\/operation\/([^/]+)$/);
        const target = req.headers['x-amz-target'];
        if (cbor && cbor[1] === SERVICE) {
            protocol = 'cbor';
            operation = cbor[2];
        } else if (typeof target === 'string' && target.startsWith(`${SERVICE}.`)) {
            protocol = 'json';
            operation = target.slice(SERVICE.length + 1);
        } else {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end(`no route ${req.method} ${url.pathname}\n`);
            return;
        }
        const fail = (e: unknown) => {
            if (e instanceof AwsError) reply(res, protocol, 400, { __type: e.code, message: e.message });
            else reply(res, protocol, 500, { __type: 'InternalFailure', message: e instanceof Error ? e.message : String(e) });
        };
        if (req.method !== 'POST') {
            fail(new AwsError('UnsupportedOperation', 'CloudWatch operations are POST requests.'));
            return;
        }
        readBody(req)
            .then((body) => {
                if (operation !== 'GetMetricData') {
                    throw new AwsError('UnsupportedOperation', `The demo's fake CloudWatch answers GetMetricData only, not ${operation}.`);
                }
                let input: unknown;
                if (protocol === 'cbor') input = decodeCbor(body);
                else {
                    try {
                        input = body.length ? JSON.parse(body.toString('utf8')) : {};
                    } catch {
                        throw new AwsError('SerializationException', 'The request body is not JSON.');
                    }
                }
                if (!isObject(input)) throw new AwsError('SerializationException', 'The request body must be a structure.');
                const { offset, max } = pageArgs(input);
                const { out, next } = page(getMetricData(input, timeline(), now()), offset, max);
                reply(res, protocol, 200, {
                    MetricDataResults: out.map((r) => ({
                        Id: r.Id,
                        Label: r.Label,
                        StatusCode: r.StatusCode,
                        Timestamps: r.rows.map((x) => new Timestamp(x.t)),
                        Values: new Doubles(r.rows.map((x) => x.v)),
                    })),
                    Messages: [],
                    NextToken: next,
                });
            })
            .catch(fail);
    };
}
