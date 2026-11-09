/**
 * A fake Prometheus HTTP API serving fixed synthetic series (Harness API `startFakePrometheus`).
 *
 * `/api/v1/query_range` answers a matrix with one point per step from `start` to `end`, both
 * included; `/api/v1/query` a vector with one point at `time`. Every point of a series carries
 * its fixed value. A query that is a bare metric name returns only the series whose `__name__`
 * equals it; any other query returns every series. GET and POST (form body) both work.
 */
import type { ServerResponse } from 'node:http';
import {
    type FakeReply,
    type FakeServer,
    jsonReply,
    type RecordedRequest,
    startFakeServer,
} from './fakeServer';
import { sleep } from './util';

export type PrometheusSeries = {
    labels: Record<string, string>;
    value: number;
};

export type StartFakePrometheusOptions = {
    series: PrometheusSeries[];
    /** Delay before every reply, in milliseconds. */
    delayMs?: number;
};

export type FakePrometheus = FakeServer & {
    setSeries(series: PrometheusSeries[]): void;
    setDelay(ms: number): void;
    /** Requests whose client hung up before the (delayed) reply. */
    cancelled(): number;
};

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
/** Prometheus refuses more points than this per series. */
const MAX_POINTS = 11_000;

const badData = (error: string) =>
    jsonReply({ status: 'error', errorType: 'bad_data', error }, 400);

/** Seconds from a Prometheus time parameter (unix seconds or RFC 3339). */
function parseTime(value: string | undefined): number | undefined {
    if (value === undefined || value === '') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms / 1000;
}

/** Seconds from a Prometheus step (a float of seconds or a duration such as `1m`, `1h30m`). */
function parseStep(value: string | undefined): number | undefined {
    if (value === undefined || value === '') return undefined;
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
    const units: Record<string, number> = {
        ms: 0.001,
        s: 1,
        m: 60,
        h: 3600,
        d: 86400,
        w: 604800,
        y: 31536000,
    };
    let total = 0;
    let consumed = '';
    for (const m of value.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) {
        total += Number(m[1]) * units[m[2]];
        consumed += m[0];
    }
    return consumed === value ? total : undefined;
}

/** Prometheus' sample value text. */
function sampleValue(value: number): string {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return '+Inf';
    if (value === -Infinity) return '-Inf';
    return String(value);
}

export async function startFakePrometheus(
    opts: StartFakePrometheusOptions,
): Promise<FakePrometheus> {
    let series = opts.series;
    let delayMs = opts.delayMs ?? 0;
    let cancelled = 0;

    const matching = (query: string) =>
        METRIC_NAME.test(query)
            ? series.filter((s) => s.labels.__name__ === query)
            : series;

    const answer = (request: RecordedRequest): FakeReply => {
        const { query } = request.params;
        if (query === undefined || query === '') {
            return badData('parameter "query" is missing');
        }
        if (request.path === '/api/v1/query_range') {
            const start = parseTime(request.params.start);
            const end = parseTime(request.params.end);
            const step = parseStep(request.params.step);
            if (start === undefined)
                return badData('invalid parameter "start"');
            if (end === undefined) return badData('invalid parameter "end"');
            if (step === undefined || step <= 0) {
                return badData('invalid parameter "step"');
            }
            if (end < start) {
                return badData('end timestamp must not be before start time');
            }
            if ((end - start) / step > MAX_POINTS) {
                return badData('exceeded maximum resolution of 11,000 points');
            }
            const times: number[] = [];
            // Integer steps from start, so float drift cannot add or drop the end point.
            for (let i = 0; start + i * step <= end + 1e-9; i++) {
                times.push(start + i * step);
            }
            return jsonReply({
                status: 'success',
                data: {
                    resultType: 'matrix',
                    result: matching(query).map((s) => ({
                        metric: s.labels,
                        values: times.map((t) => [t, sampleValue(s.value)]),
                    })),
                },
            });
        }
        if (request.path === '/api/v1/query') {
            const at =
                request.params.time === undefined
                    ? Date.now() / 1000
                    : parseTime(request.params.time);
            if (at === undefined) return badData('invalid parameter "time"');
            return jsonReply({
                status: 'success',
                data: {
                    resultType: 'vector',
                    result: matching(query).map((s) => ({
                        metric: s.labels,
                        value: [at, sampleValue(s.value)],
                    })),
                },
            });
        }
        return jsonReply(
            { status: 'error', errorType: 'not_found', error: 'not found' },
            404,
        );
    };

    const handler = async (
        request: RecordedRequest,
        res: ServerResponse,
    ): Promise<FakeReply | undefined> => {
        if (delayMs > 0) {
            let hungUp = false;
            const onClose = () => {
                if (!res.writableEnded) hungUp = true;
            };
            res.once('close', onClose);
            await sleep(delayMs);
            res.off('close', onClose);
            if (hungUp) {
                cancelled += 1;
                return undefined;
            }
        }
        return answer(request);
    };

    const server = await startFakeServer(handler);
    return {
        ...server,
        setSeries(next: PrometheusSeries[]) {
            series = next;
        },
        setDelay(ms: number) {
            delayMs = ms;
        },
        cancelled: () => cancelled,
    };
}
