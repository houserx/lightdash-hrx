/**
 * A fake Loki HTTP API serving fixed synthetic log streams and metric series (Harness API
 * `startFakeLoki`).
 *
 * `/loki/api/v1/query_range` (GET or POST form body), like Loki:
 * - a log query (one that starts with `{`) answers `streams`: every fixture stream's lines whose
 *   timestamp is inside `[start, end]`, ordered by `direction` (default `backward`, newest
 *   first) and cut to the first `limit` lines over all streams (default 100). Streams without a
 *   line in the answer are left out. Timestamps go out as unix-nanosecond strings.
 * - any other (metric) query answers a `matrix` with every `series`, one point per step from
 *   `start` to `end`, both included, each carrying the series' fixed value (as the fake
 *   Prometheus does).
 * The fake does not evaluate selectors: every stream (or series) is in every answer. Bad
 * parameters answer 400 with a plain-text message, as Loki does. `start`/`end` take unix
 * nanoseconds, unix seconds (10 digits or fewer, or with a fraction) or RFC 3339; `step` a float
 * of seconds or a duration.
 */
import {
    type FakeReply,
    type FakeServer,
    jsonReply,
    type RecordedRequest,
    startFakeServer,
} from './fakeServer';
import { parseStep, sampleValue } from './prometheus';

export type LokiStream = {
    labels: Record<string, string>;
    /** `[RFC 3339 timestamp, line]`; the fraction may carry up to nanoseconds. */
    lines: [string, string][];
};

export type LokiSeries = {
    labels: Record<string, string>;
    value: number;
};

export type StartFakeLokiOptions = {
    streams: LokiStream[];
    /** What a metric query answers (default none). */
    series?: LokiSeries[];
};

export type FakeLoki = FakeServer & {
    setStreams(streams: LokiStream[]): void;
    setSeries(series: LokiSeries[]): void;
};

const NANOS_PER_SECOND = 1_000_000_000n;
const DEFAULT_LIMIT = 100;
const DEFAULT_DIRECTION = 'backward';
/** Loki's default range when `start` is missing. */
const DEFAULT_RANGE_NS = 3600n * NANOS_PER_SECOND;
/** Loki refuses more points than this per series. */
const MAX_POINTS = 11_000;

const badRequest = (message: string): FakeReply => ({
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: message,
});

/** Unix nanoseconds of an RFC 3339 timestamp, or undefined. */
function rfc3339Nanos(value: string): bigint | undefined {
    const m = value.match(/^(.+?)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/i);
    if (!m) return undefined;
    const ms = Date.parse(`${m[1]}${m[3]}`);
    if (Number.isNaN(ms)) return undefined;
    return BigInt(ms) * 1_000_000n + BigInt((m[2] ?? '').padEnd(9, '0'));
}

/** Unix nanoseconds of a Loki time parameter, as Loki reads it. */
function parseTime(value: string): bigint | undefined {
    if (/^-?\d+$/.test(value)) {
        // Loki: up to 10 digits are seconds, more are nanoseconds.
        return value.replace(/^-/, '').length <= 10
            ? BigInt(value) * NANOS_PER_SECOND
            : BigInt(value);
    }
    const seconds = value.match(/^(\d+)\.(\d+)$/);
    if (seconds) {
        return (
            BigInt(seconds[1]) * NANOS_PER_SECOND +
            BigInt(seconds[2].slice(0, 9).padEnd(9, '0'))
        );
    }
    return rfc3339Nanos(value);
}

/** Unix seconds (a float, as Loki and Prometheus write sample times) of unix nanoseconds. */
const nanosToSeconds = (ns: bigint) =>
    Number(ns / NANOS_PER_SECOND) +
    Number(ns % NANOS_PER_SECOND) / 1_000_000_000;

type Entry = { stream: number; ns: bigint; line: string };

function fixtureEntries(streams: LokiStream[]): Entry[] {
    return streams.flatMap((s, stream) =>
        s.lines.map(([timestamp, line]) => {
            const ns = rfc3339Nanos(timestamp);
            if (ns === undefined) {
                throw new Error(
                    `startFakeLoki: bad line timestamp ${JSON.stringify(timestamp)} (RFC 3339 expected)`,
                );
            }
            return { stream, ns, line };
        }),
    );
}

export async function startFakeLoki(
    opts: StartFakeLokiOptions,
): Promise<FakeLoki> {
    let streams = opts.streams;
    let entries = fixtureEntries(streams);
    let series = opts.series ?? [];

    const logAnswer = (
        start: bigint,
        end: bigint,
        params: Record<string, string>,
    ): FakeReply => {
        const limitText = params.limit ?? String(DEFAULT_LIMIT);
        if (!/^\d+$/.test(limitText) || Number(limitText) <= 0) {
            return badRequest(
                `invalid limit: must be a positive integer, got ${limitText}`,
            );
        }
        const direction = (
            params.direction ?? DEFAULT_DIRECTION
        ).toLowerCase();
        if (direction !== 'forward' && direction !== 'backward') {
            return badRequest(`invalid direction "${params.direction}"`);
        }
        const sign = direction === 'forward' ? 1 : -1;
        const picked = entries
            .filter((e) => e.ns >= start && e.ns <= end)
            .sort((a, b) => sign * (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0))
            .slice(0, Number(limitText));
        const result = streams.flatMap((s, i) => {
            const values = picked
                .filter((e) => e.stream === i)
                .map((e) => [e.ns.toString(), e.line]);
            return values.length ? [{ stream: s.labels, values }] : [];
        });
        return jsonReply({
            status: 'success',
            data: { resultType: 'streams', result, stats: {} },
        });
    };

    const metricAnswer = (
        start: bigint,
        end: bigint,
        params: Record<string, string>,
    ): FakeReply => {
        let stepSeconds: number | undefined;
        if (params.step === undefined || params.step === '') {
            // Loki's default: the range over 250 points, at least a second.
            stepSeconds = Math.max(
                1,
                Math.ceil(nanosToSeconds(end - start) / 250),
            );
        } else {
            stepSeconds = parseStep(params.step);
        }
        if (stepSeconds === undefined || stepSeconds <= 0) {
            return badRequest(`invalid parameter "step": ${params.step}`);
        }
        const stepNs = BigInt(Math.round(stepSeconds * 1e9));
        if (stepNs <= 0n) {
            return badRequest(`invalid parameter "step": ${params.step}`);
        }
        if ((end - start) / stepNs > BigInt(MAX_POINTS)) {
            return badRequest(
                'exceeded maximum resolution of 11,000 points per timeseries. Try increasing the value of the step parameter',
            );
        }
        const times: number[] = [];
        for (let t = start; t <= end; t += stepNs) {
            times.push(nanosToSeconds(t));
        }
        return jsonReply({
            status: 'success',
            data: {
                resultType: 'matrix',
                result: series.map((s) => ({
                    metric: s.labels,
                    values: times.map((t) => [t, sampleValue(s.value)]),
                })),
                stats: {},
            },
        });
    };

    const answer = (request: RecordedRequest): FakeReply => {
        if (request.path === '/ready') {
            return { status: 200, body: 'ready' };
        }
        if (request.path !== '/loki/api/v1/query_range') {
            return { status: 404, body: '404 page not found\n' };
        }
        const { params } = request;
        const query = params.query ?? '';
        if (query.trim() === '') {
            return badRequest('query must not be empty');
        }
        const end =
            params.end === undefined || params.end === ''
                ? BigInt(Date.now()) * 1_000_000n
                : parseTime(params.end);
        if (end === undefined) {
            return badRequest(`invalid parameter "end": ${params.end}`);
        }
        const start =
            params.start === undefined || params.start === ''
                ? end - DEFAULT_RANGE_NS
                : parseTime(params.start);
        if (start === undefined) {
            return badRequest(`invalid parameter "start": ${params.start}`);
        }
        if (end < start) {
            return badRequest(
                'end timestamp must not be before or equal to start time',
            );
        }
        return query.trimStart().startsWith('{')
            ? logAnswer(start, end, params)
            : metricAnswer(start, end, params);
    };

    const server = await startFakeServer(answer);
    return {
        ...server,
        setStreams(next: LokiStream[]) {
            entries = fixtureEntries(next);
            streams = next;
        },
        setSeries(next: LokiSeries[]) {
            series = next;
        },
    };
}
