/**
 * A fake Tempo HTTP API serving fixed synthetic traces (Harness API `startFakeTempo`).
 *
 * - `GET /api/search` answers every fixture trace, in fixture order, cut to `limit` (default 20,
 *   as Tempo), in Tempo's search JSON: `traceID` (hex), `rootServiceName`, `rootTraceName`,
 *   `startTimeUnixNano` (string), `durationMs` and one span set whose `matched` is the trace's
 *   span count (in `spanSets` and the older `spanSet`). The fake does not evaluate the TraceQL
 *   query or the time range: every trace is in every answer. A bad `limit`, `start` or `end`
 *   answers 400 plain text, as Tempo.
 * - `GET /api/traces/<id>` answers the trace as Tempo's OTLP JSON (`{"batches": [...]}`, one
 *   resource per service in first-seen order, ids in base64, `startTimeUnixNano` /
 *   `endTimeUnixNano` strings, status codes as enum names, attributes as OTLP `AnyValue`s);
 *   `GET /api/v2/traces/<id>` answers the same as `{"trace": {"resourceSpans": [...]}}`. The id
 *   is hex, case-insensitive, leading zeros optional. An unknown id answers 404, as Tempo.
 * - `GET /ready` answers 200.
 */
import {
    type FakeReply,
    type FakeServer,
    jsonReply,
    type RecordedRequest,
    startFakeServer,
} from './fakeServer';

export type TempoAttributeValue =
    | string
    | number
    | boolean
    | null
    | TempoAttributeValue[]
    | { [key: string]: TempoAttributeValue };

export type TempoSpan = {
    /** 16 hex digits. */
    spanId: string;
    /** 16 hex digits; missing for a root span. */
    parentSpanId?: string;
    /** The resource's `service.name`. */
    service: string;
    name: string;
    /** RFC 3339; the fraction may carry up to nanoseconds. */
    start: string;
    durationMs: number;
    /** Default `unset`. */
    status?: 'ok' | 'error' | 'unset';
    attributes?: Record<string, TempoAttributeValue>;
};

export type TempoTrace = {
    /** Up to 32 hex digits. */
    traceId: string;
    rootServiceName: string;
    rootTraceName: string;
    /** RFC 3339; the fraction may carry up to nanoseconds. */
    start: string;
    durationMs: number;
    spans: TempoSpan[];
};

export type StartFakeTempoOptions = {
    traces: TempoTrace[];
};

export type FakeTempo = FakeServer & {
    setTraces(traces: TempoTrace[]): void;
};

/** Tempo's default search limit. */
const DEFAULT_LIMIT = 20;

const STATUS_CODES = {
    ok: 'STATUS_CODE_OK',
    error: 'STATUS_CODE_ERROR',
    unset: 'STATUS_CODE_UNSET',
} as const;

const badRequest = (message: string): FakeReply => ({
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: message,
});

const notFound = (): FakeReply => ({
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: 'trace not found\n',
});

/** Unix nanoseconds of an RFC 3339 timestamp, or undefined. */
function rfc3339Nanos(value: string): bigint | undefined {
    const m = value.match(/^(.+?)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/i);
    if (!m) return undefined;
    const ms = Date.parse(`${m[1]}${m[3]}`);
    if (Number.isNaN(ms)) return undefined;
    return BigInt(ms) * 1_000_000n + BigInt((m[2] ?? '').padEnd(9, '0'));
}

const msToNanos = (ms: number) => BigInt(Math.round(ms * 1_000_000));

/** Canonical form of a hex trace id: lowercase, padded to 32 digits; undefined when not hex. */
function canonicalTraceId(id: string): string | undefined {
    if (!/^[0-9a-f]{1,32}$/i.test(id)) return undefined;
    return id.toLowerCase().padStart(32, '0');
}

const hexToBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

/** A plain JSON value as an OTLP `AnyValue` in the protobuf JSON mapping. */
function anyValue(value: TempoAttributeValue): Record<string, unknown> {
    if (value === null) return {};
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { boolValue: value };
    if (typeof value === 'number') {
        // int64 is text in protobuf JSON.
        return Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value };
    }
    if (Array.isArray(value)) {
        return { arrayValue: { values: value.map(anyValue) } };
    }
    return {
        kvlistValue: {
            values: Object.entries(value).map(([key, v]) => ({
                key,
                value: anyValue(v),
            })),
        },
    };
}

type Prepared = {
    id: string;
    trace: TempoTrace;
    startNanos: bigint;
    spans: { span: TempoSpan; startNanos: bigint }[];
};

function prepare(traces: TempoTrace[]): Prepared[] {
    const where = (what: string, value: string) =>
        new Error(
            `startFakeTempo: bad ${what} ${JSON.stringify(value)}`,
        );
    return traces.map((trace) => {
        const id = canonicalTraceId(trace.traceId);
        if (!id) throw where('traceId (hex expected)', trace.traceId);
        const startNanos = rfc3339Nanos(trace.start);
        if (startNanos === undefined) {
            throw where('trace start (RFC 3339 expected)', trace.start);
        }
        const spans = trace.spans.map((span) => {
            if (!/^[0-9a-f]{16}$/i.test(span.spanId)) {
                throw where('spanId (16 hex digits expected)', span.spanId);
            }
            if (
                span.parentSpanId !== undefined &&
                !/^[0-9a-f]{16}$/i.test(span.parentSpanId)
            ) {
                throw where(
                    'parentSpanId (16 hex digits expected)',
                    span.parentSpanId,
                );
            }
            const spanStart = rfc3339Nanos(span.start);
            if (spanStart === undefined) {
                throw where('span start (RFC 3339 expected)', span.start);
            }
            return { span, startNanos: spanStart };
        });
        return { id, trace, startNanos, spans };
    });
}

/** Tempo's search JSON for one trace. */
function searchEntry(p: Prepared) {
    const spanSet = { spans: [], matched: p.spans.length };
    return {
        traceID: p.id,
        rootServiceName: p.trace.rootServiceName,
        rootTraceName: p.trace.rootTraceName,
        startTimeUnixNano: p.startNanos.toString(),
        durationMs: p.trace.durationMs,
        spanSet,
        spanSets: [spanSet],
    };
}

/** The trace's OTLP resource spans: one resource per service, in first-seen order. */
function resourceSpans(p: Prepared) {
    const byService = new Map<string, Record<string, unknown>[]>();
    for (const { span, startNanos } of p.spans) {
        const otlp: Record<string, unknown> = {
            traceId: hexToBase64(p.id),
            spanId: hexToBase64(span.spanId.toLowerCase()),
            name: span.name,
            kind: 'SPAN_KIND_INTERNAL',
            startTimeUnixNano: startNanos.toString(),
            endTimeUnixNano: (
                startNanos + msToNanos(span.durationMs)
            ).toString(),
            attributes: Object.entries(span.attributes ?? {}).map(
                ([key, value]) => ({ key, value: anyValue(value) }),
            ),
            status: { code: STATUS_CODES[span.status ?? 'unset'] },
        };
        if (span.parentSpanId !== undefined) {
            otlp.parentSpanId = hexToBase64(span.parentSpanId.toLowerCase());
        }
        const list = byService.get(span.service) ?? [];
        list.push(otlp);
        byService.set(span.service, list);
    }
    return [...byService].map(([service, spans]) => ({
        resource: {
            attributes: [
                { key: 'service.name', value: { stringValue: service } },
            ],
        },
        scopeSpans: [{ scope: { name: 'synthetic' }, spans }],
    }));
}

export async function startFakeTempo(
    opts: StartFakeTempoOptions,
): Promise<FakeTempo> {
    let traces = prepare(opts.traces);

    const search = (params: Record<string, string>): FakeReply => {
        const limitText = params.limit ?? '';
        let limit = DEFAULT_LIMIT;
        if (limitText !== '') {
            if (!/^\d+$/.test(limitText) || Number(limitText) <= 0) {
                return badRequest(`invalid limit: ${limitText}`);
            }
            limit = Number(limitText);
        }
        for (const key of ['start', 'end'] as const) {
            const value = params[key];
            if (value !== undefined && value !== '' && !/^\d+$/.test(value)) {
                return badRequest(`invalid ${key}: ${value}`);
            }
        }
        if (
            params.start &&
            params.end &&
            BigInt(params.end) < BigInt(params.start)
        ) {
            return badRequest('invalid start: start must be before end');
        }
        return jsonReply({
            traces: traces.slice(0, limit).map(searchEntry),
            metrics: { inspectedTraces: traces.length },
        });
    };

    const answer = (request: RecordedRequest): FakeReply => {
        if (request.path === '/ready') {
            return { status: 200, body: 'ready' };
        }
        if (request.path === '/api/search') {
            return search(request.params);
        }
        const m = request.path.match(/^\/api\/(v2\/)?traces\/([^/]+)$/);
        if (!m) {
            return { status: 404, body: '404 page not found\n' };
        }
        const id = canonicalTraceId(decodeURIComponent(m[2]));
        if (!id) {
            return badRequest(`invalid trace id: ${m[2]}`);
        }
        const found = traces.find((t) => t.id === id);
        if (!found) return notFound();
        const batches = resourceSpans(found);
        return jsonReply(
            m[1]
                ? { trace: { resourceSpans: batches } }
                : { batches },
        );
    };

    const server = await startFakeServer(answer);
    return {
        ...server,
        setTraces(next: TempoTrace[]) {
            traces = prepare(next);
        },
    };
}
