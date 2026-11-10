// ENG-1799 demo: the fake CloudWatch Logs Insights (served from the telemetry-fakes process on its reserved port).
//
// Log group /hrx/demo/fill-service holds the fill-service's log lines, the same lines the fake Loki serves
// (`fillServiceLogs()` in stack/loki.ts), written the way the service would log to CloudWatch:
//   <ISO time> INFO|ERROR <the logfmt rest of the line>
// So messages containing ERROR follow the Loki error numbers: about 1.5 a minute in the baseline and after
// recovery, 20..30 a minute from incidentAt to recoveryAt (each a slow shipping-label-api call). Like every fake,
// the events at time t are a pure function of t and the current scenario timeline; events after "now" do not
// exist yet.
//
// API: AWS JSON 1.1, POST / with X-Amz-Target: Logs_20140328.<Operation> (what the engine's
// aws-sdk-cloudwatchlogs sends; requests are not signature-checked):
//   StartQuery       logGroupNames | logGroupName | logGroupIdentifiers, queryString, startTime, endTime (epoch s,
//                    both inclusive), limit  -> {queryId}. The query runs at once; an unknown log group answers
//                    400 ResourceNotFoundException, a query the fake does not understand 400 MalformedQueryException.
//   GetQueryResults  queryId -> {status: "Complete", results: [[{field, value}]], statistics}
//   StopQuery        queryId -> {success: false} (a query is complete as soon as it starts)
//   DescribeLogGroups  -> the one log group
//   GET /ready       -> 200 "ready" (not an AWS route; up.sh checks it)
// Logs Insights understood: commands separated by `|`:
//   fields <f>, ...            (also `display`); @timestamp, @message, @logStream, @log, @ptr
//   filter <condition>         <field> like /re/flags | like "text" | not like ... | =~ /re/ | = "x" | != "x",
//                              combined with and, or, not and parentheses
//   sort <field> [asc|desc]    (no sort: newest first)
//   limit <n>                  (no limit: 1000; at most 10000)
// Anything else (stats, parse, dedup) answers MalformedQueryException; extend `parseQuery` if a later feature
// needs it.
import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { Timeline } from './clock.js';
import { fillServiceLogs } from './loki.js';

export const LOG_GROUP = '/hrx/demo/fill-service';
const LOG_STREAM = 'fill-service/demo-0';
const ACCOUNT = '000000000000';
const TARGET_PREFIX = 'Logs_20140328.';
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
/** The fake makes its events on demand, one slot per second; longer ranges are refused. */
const MAX_RANGE_S = 7 * 24 * 3600;
/** Finished queries kept for GetQueryResults (oldest dropped first). */
const MAX_KEPT_QUERIES = 200;
const MAX_BODY_BYTES = 256 * 1024;

/** A request the fake (like CloudWatch Logs) refuses: HTTP 400 with an AWS error code. */
export class AwsError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

type LogEvent = Record<string, string>;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Logs Insights' @timestamp text: `YYYY-MM-DD HH:MM:SS.mmm`, UTC. */
export function insightsTime(ms: number): string {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
        d.getUTCMinutes(),
    )}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/** The fill-service's events with startS*1000 <= ms <= endS*1000 (and not after now), oldest first. */
export function fillServiceEvents(startS: number, endS: number, tl: Timeline, nowMs: number): LogEvent[] {
    const toMs = Math.min(endS * 1000 + 1, nowMs + 1);
    if (toMs <= startS * 1000) return [];
    return fillServiceLogs(startS * 1000, toMs, tl).map((e) => {
        // The Loki line is `ts=<iso> level=<level> <rest>`; CloudWatch carries `<iso> <LEVEL> <rest>`.
        const rest = e.line.replace(/^ts=\S+ level=\S+ /, '');
        return {
            '@timestamp': insightsTime(e.ms),
            '@message': `${new Date(e.ms).toISOString()} ${e.level.toUpperCase()} ${rest}`,
            '@logStream': LOG_STREAM,
            '@log': `${ACCOUNT}:${LOG_GROUP}`,
            '@ptr': createHash('sha256').update(`cwl|${e.ms}`).digest('base64url').slice(0, 24),
        };
    });
}

// ---------------------------------------------------------------- Logs Insights (the subset the demo needs)

type Condition =
    | { kind: 'and' | 'or'; left: Condition; right: Condition }
    | { kind: 'not'; inner: Condition }
    | { kind: 'match'; field: string; test: (value: string) => boolean };

export type Query = {
    fields?: string[];
    filters: Condition[];
    sort?: { field: string; desc: boolean };
    limit: number;
    /** The query has a `limit` command (it wins over StartQuery's limit parameter). */
    limitCommand?: boolean;
};

const malformed = (message: string) => new AwsError('MalformedQueryException', message);

/** Splits on `|` outside "..", '..' and /regex/ literals (a `/` opens a regex after `like` or `=~`). */
function splitPipeline(src: string): string[] {
    const parts: string[] = [];
    let current = '';
    let quote = '';
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            current += c;
            if (c === '\\' && i + 1 < src.length) current += src[++i];
            else if (c === quote) quote = '';
        } else if (c === '"' || c === "'") {
            quote = c;
            current += c;
        } else if (c === '/' && /(\blike|=~)\s*$/i.test(current)) {
            quote = '/';
            current += c;
        } else if (c === '|') {
            parts.push(current.trim());
            current = '';
        } else current += c;
    }
    if (quote) throw malformed(`unterminated ${quote === '/' ? 'regular expression' : 'string'} in the query`);
    parts.push(current.trim());
    return parts;
}

type Token = { t: 'word' | 'op' | 'string' | 'regex' | '(' | ')'; v: string; flags?: string };

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const rest = src.slice(i);
        const space = rest.match(/^\s+/);
        if (space) {
            i += space[0].length;
            continue;
        }
        const prev = tokens[tokens.length - 1];
        const afterMatchOp = prev && ((prev.t === 'word' && prev.v.toLowerCase() === 'like') || (prev.t === 'op' && prev.v === '=~'));
        let m: RegExpMatchArray | null;
        if (rest[0] === '(' || rest[0] === ')') {
            tokens.push({ t: rest[0] as '(' | ')', v: rest[0] });
            i++;
        } else if (afterMatchOp && (m = rest.match(/^\/((?:[^/\\]|\\.)*)\/([a-z]*)/))) {
            tokens.push({ t: 'regex', v: m[1].replace(/\\\//g, '/'), flags: m[2] });
            i += m[0].length;
        } else if ((m = rest.match(/^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/))) {
            tokens.push({ t: 'string', v: (m[1] ?? m[2]).replace(/\\(.)/g, '$1') });
            i += m[0].length;
        } else if ((m = rest.match(/^(=~|!=|=)/))) {
            tokens.push({ t: 'op', v: m[1] });
            i += m[0].length;
        } else if ((m = rest.match(/^[@A-Za-z_][\w.@-]*/))) {
            tokens.push({ t: 'word', v: m[0] });
            i += m[0].length;
        } else throw malformed(`unexpected "${rest.slice(0, 20)}" in filter`);
    }
    return tokens;
}

function regex(tok: Token): RegExp {
    const flags = tok.flags ?? '';
    if (/[^imsu]/.test(flags)) throw malformed(`unsupported regular expression flags "${flags}"`);
    try {
        return new RegExp(tok.v, flags);
    } catch (e) {
        throw malformed(`invalid regular expression /${tok.v}/: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function parseCondition(src: string): Condition {
    const tokens = tokenize(src);
    let pos = 0;
    const peekWord = (w: string) => tokens[pos]?.t === 'word' && tokens[pos].v.toLowerCase() === w;
    const or = (): Condition => {
        let left = and();
        while (peekWord('or')) {
            pos++;
            left = { kind: 'or', left, right: and() };
        }
        return left;
    };
    const and = (): Condition => {
        let left = unary();
        while (peekWord('and')) {
            pos++;
            left = { kind: 'and', left, right: unary() };
        }
        return left;
    };
    const unary = (): Condition => {
        if (peekWord('not')) {
            pos++;
            return { kind: 'not', inner: unary() };
        }
        if (tokens[pos]?.t === '(') {
            pos++;
            const inner = or();
            if (tokens[pos]?.t !== ')') throw malformed(`missing ")" in filter "${src}"`);
            pos++;
            return inner;
        }
        return comparison();
    };
    const comparison = (): Condition => {
        const field = tokens[pos++];
        if (!field || field.t !== 'word') throw malformed(`filter "${src}": expected a field name`);
        let negate = false;
        if (peekWord('not')) {
            negate = true;
            pos++;
        }
        const op = tokens[pos++];
        const value = tokens[pos++];
        if (!op || !value) throw malformed(`filter "${src}": incomplete condition on ${field.v}`);
        let test: (v: string) => boolean;
        if ((op.t === 'word' && op.v.toLowerCase() === 'like') || (op.t === 'op' && op.v === '=~')) {
            if (value.t === 'regex') {
                const re = regex(value);
                test = (v) => re.test(v);
            } else if (value.t === 'string') {
                test = (v) => v.includes(value.v);
            } else throw malformed(`filter "${src}": ${op.v} needs a /regex/ or a "string"`);
        } else if (op.t === 'op' && (op.v === '=' || op.v === '!=') && !negate) {
            if (value.t !== 'string') throw malformed(`filter "${src}": ${op.v} needs a "string"`);
            test = op.v === '=' ? (v) => v === value.v : (v) => v !== value.v;
        } else throw malformed(`filter "${src}": unsupported operator "${op.v}"`);
        const name = field.v;
        const match: Condition = { kind: 'match', field: name, test };
        return negate ? { kind: 'not', inner: match } : match;
    };
    const cond = or();
    if (pos !== tokens.length) throw malformed(`filter "${src}": unexpected "${tokens[pos].v}"`);
    return cond;
}

function holds(c: Condition, e: LogEvent): boolean {
    switch (c.kind) {
        case 'and':
            return holds(c.left, e) && holds(c.right, e);
        case 'or':
            return holds(c.left, e) || holds(c.right, e);
        case 'not':
            return !holds(c.inner, e);
        default:
            return e[c.field] !== undefined && c.test(e[c.field]);
    }
}

const fieldList = (src: string) => {
    const names = src.split(',').map((f) => f.trim());
    if (names.some((f) => !/^[@A-Za-z_][\w.@-]*$/.test(f))) {
        throw malformed(`the fake understands plain field lists only, got "${src}"`);
    }
    return names;
};

export function parseQuery(queryString: string): Query {
    const query: Query = { filters: [], limit: DEFAULT_LIMIT };
    for (const part of splitPipeline(queryString)) {
        const m = part.match(/^(\w+)\s*([\s\S]*)$/);
        if (!m) throw malformed(`empty command in query "${queryString}"`);
        const [, command, args] = m;
        switch (command.toLowerCase()) {
            case 'fields':
            case 'display':
                query.fields = [...(query.fields ?? []), ...fieldList(args)];
                break;
            case 'filter':
                query.filters.push(parseCondition(args));
                break;
            case 'sort': {
                const s = args.trim().match(/^([@A-Za-z_][\w.@-]*)(?:\s+(asc|desc))?$/i);
                if (!s) throw malformed(`sort needs one field and an optional asc|desc, got "${args}"`);
                query.sort = { field: s[1], desc: (s[2] ?? 'asc').toLowerCase() === 'desc' };
                break;
            }
            case 'limit': {
                const n = Number(args.trim());
                if (!/^\d+$/.test(args.trim()) || n < 1 || n > MAX_LIMIT) {
                    throw malformed(`limit must be a whole number from 1 to ${MAX_LIMIT}, got "${args.trim()}"`);
                }
                query.limit = n;
                query.limitCommand = true;
                break;
            }
            default:
                throw malformed(`the demo's fake Logs Insights does not understand the command "${command}"`);
        }
    }
    return query;
}

/** Runs a parsed query over the events (oldest first): the result rows and the statistics. */
export function runQuery(query: Query, events: LogEvent[]) {
    const matched = events.filter((e) => query.filters.every((f) => holds(f, e)));
    const sort = query.sort ?? { field: '@timestamp', desc: true };
    const key = (e: LogEvent) => e[sort.field] ?? '';
    // Stable sort; @timestamp text sorts like time.
    const sorted = matched
        .map((e, i) => ({ e, i }))
        .sort((a, b) => (key(a.e) < key(b.e) ? -1 : key(a.e) > key(b.e) ? 1 : a.i - b.i))
        .map((x) => x.e);
    if (sort.desc) sorted.reverse();
    const shown = query.fields ? [...new Set([...query.fields, '@ptr'])] : ['@timestamp', '@message', '@logStream', '@log', '@ptr'];
    const results = sorted
        .slice(0, query.limit)
        .map((e) => shown.filter((f) => e[f] !== undefined).map((field) => ({ field, value: e[field] })));
    const bytes = events.reduce((n, e) => n + Buffer.byteLength(e['@message']), 0);
    return {
        results,
        statistics: { recordsMatched: matched.length, recordsScanned: events.length, bytesScanned: bytes },
    };
}

// ---------------------------------------------------------------- operations

type Finished = ReturnType<typeof runQuery>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function epochSeconds(v: unknown, name: string): number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
        throw new AwsError('InvalidParameterException', `${name} must be epoch seconds (a whole number).`);
    }
    return v;
}

/** The log group names a StartQuery input asks for (names or ARNs). */
function logGroups(input: Record<string, unknown>): string[] {
    const list = input.logGroupNames ?? input.logGroupIdentifiers ?? (input.logGroupName !== undefined ? [input.logGroupName] : undefined);
    if (!Array.isArray(list) || list.length === 0 || !list.every((g) => typeof g === 'string' && g !== '')) {
        throw new AwsError('InvalidParameterException', 'StartQuery needs logGroupNames, logGroupName or logGroupIdentifiers.');
    }
    return (list as string[]).map((g) => g.replace(/^arn:[^:]*:logs:[^:]*:[^:]*:log-group:/, '').replace(/:\*$/, ''));
}

export class LogsInsights {
    private readonly queries = new Map<string, Finished>();
    private next = 0;

    constructor(
        private readonly timeline: () => Timeline,
        private readonly now: () => number = Date.now,
    ) {}

    startQuery(input: Record<string, unknown>): { queryId: string } {
        const groups = logGroups(input);
        const missing = groups.find((g) => g !== LOG_GROUP);
        if (missing !== undefined) {
            throw new AwsError('ResourceNotFoundException', `Log group '${missing}' does not exist for account ID '${ACCOUNT}'`);
        }
        if (typeof input.queryString !== 'string' || input.queryString.trim() === '') {
            throw new AwsError('InvalidParameterException', 'queryString is required.');
        }
        const start = epochSeconds(input.startTime, 'startTime');
        const end = epochSeconds(input.endTime, 'endTime');
        if (end < start) throw new AwsError('InvalidParameterException', 'endTime must not be before startTime.');
        if (end - start > MAX_RANGE_S) {
            throw new AwsError('InvalidParameterException', `The demo's fake Logs Insights queries at most ${MAX_RANGE_S} s at once.`);
        }
        const query = parseQuery(input.queryString);
        if (input.limit !== undefined && input.limit !== null) {
            const limit = input.limit;
            if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
                throw new AwsError('InvalidParameterException', `limit must be from 1 to ${MAX_LIMIT}.`);
            }
            if (!query.limitCommand) query.limit = limit;
        }
        const finished = runQuery(query, fillServiceEvents(start, end, this.timeline(), this.now()));
        const queryId = `demo-${String(++this.next).padStart(8, '0')}-${createHash('sha256').update(`${this.now()}|${this.next}`).digest('hex').slice(0, 12)}`;
        this.queries.set(queryId, finished);
        while (this.queries.size > MAX_KEPT_QUERIES) this.queries.delete(this.queries.keys().next().value as string);
        return { queryId };
    }

    private finished(input: Record<string, unknown>): Finished {
        const id = input.queryId;
        const q = typeof id === 'string' ? this.queries.get(id) : undefined;
        if (!q) throw new AwsError('ResourceNotFoundException', `Query ${JSON.stringify(id ?? null)} does not exist.`);
        return q;
    }

    getQueryResults(input: Record<string, unknown>) {
        const { results, statistics } = this.finished(input);
        return { status: 'Complete', results, statistics };
    }

    stopQuery(input: Record<string, unknown>) {
        this.finished(input);
        return { success: false };
    }

    describeLogGroups() {
        return {
            logGroups: [
                {
                    logGroupName: LOG_GROUP,
                    arn: `arn:aws:logs:us-east-2:${ACCOUNT}:log-group:${LOG_GROUP}:*`,
                    logGroupArn: `arn:aws:logs:us-east-2:${ACCOUNT}:log-group:${LOG_GROUP}`,
                    creationTime: 0,
                    storedBytes: 0,
                    logGroupClass: 'STANDARD',
                },
            ],
        };
    }
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

function reply(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-requestid': 'demo-fake-cloudwatch-logs' });
    res.end(JSON.stringify(body));
}

/** The HTTP handler of the fake CloudWatch Logs. `timeline` is read per query. */
export function cloudwatchLogsHandler(timeline: () => Timeline, now: () => number = Date.now): http.RequestListener {
    const insights = new LogsInsights(timeline, now);
    return (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/ready') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('ready\n');
            return;
        }
        const target = req.headers['x-amz-target'];
        if (typeof target !== 'string' || !target.startsWith(TARGET_PREFIX)) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end(`no route ${req.method} ${url.pathname}\n`);
            return;
        }
        const fail = (e: unknown) => {
            if (e instanceof AwsError) reply(res, 400, { __type: e.code, message: e.message });
            else reply(res, 500, { __type: 'ServiceUnavailableException', message: e instanceof Error ? e.message : String(e) });
        };
        if (req.method !== 'POST') {
            fail(new AwsError('InvalidOperationException', 'CloudWatch Logs operations are POST requests.'));
            return;
        }
        const operation = target.slice(TARGET_PREFIX.length);
        readBody(req)
            .then((body) => {
                let input: unknown;
                try {
                    input = body.length ? JSON.parse(body.toString('utf8')) : {};
                } catch {
                    throw new AwsError('SerializationException', 'The request body is not JSON.');
                }
                if (!isObject(input)) throw new AwsError('SerializationException', 'The request body must be a structure.');
                switch (operation) {
                    case 'StartQuery':
                        return insights.startQuery(input);
                    case 'GetQueryResults':
                        return insights.getQueryResults(input);
                    case 'StopQuery':
                        return insights.stopQuery(input);
                    case 'DescribeLogGroups':
                        return insights.describeLogGroups();
                    default:
                        throw new AwsError(
                            'InvalidOperationException',
                            `The demo's fake CloudWatch Logs answers StartQuery, GetQueryResults, StopQuery and DescribeLogGroups, not ${operation}.`,
                        );
                }
            })
            .then((out) => reply(res, 200, out), fail);
    };
}
