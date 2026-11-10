/**
 * A fake CloudWatch serving fixed synthetic datapoints (Harness API `startFakeCloudWatch`).
 *
 * Speaks `GetMetricData` in Smithy RPC v2 CBOR (`POST /service/GraniteServiceVersion20100801/
 * operation/GetMetricData`, what the engine's aws-sdk-cloudwatch 1.140 sends) and in AWS JSON 1.0
 * (`x-amz-target: GraniteServiceVersion20100801.GetMetricData`); the reply uses the request's
 * protocol. For the i-th `MetricDataQuery` the reply's i-th `MetricDataResult` has `Id` = the
 * query's `Id`, `Label` = the query's `Label` or else `metrics[i].label`, and `metrics[i]`'s
 * points (`metrics[0]` when there are fewer metrics than queries), `StatusCode: Complete`, no
 * `NextToken`. The fake does not evaluate the query or the time range: every point is in every
 * answer. Any other operation or protocol answers 400.
 *
 * The fake does not check SigV4 signatures; the checks read the recorded `authorization` header
 * (the engine signs with the harness's fake `AKIDTESTNOTREAL00001` key).
 */
import { cborDouble, cborTimestamp, decodeCbor, encodeCbor } from './cbor';
import {
    type FakeReply,
    type FakeServer,
    type RecordedRequest,
    startFakeServer,
} from './fakeServer';

export type CloudWatchMetric = {
    label: string;
    /** `[RFC 3339 timestamp, value]`, in the order CloudWatch returns them. */
    points: [string, number][];
};

export type StartFakeCloudWatchOptions = {
    metrics: CloudWatchMetric[];
};

/** A decoded `MetricDataQuery`, with AWS field names. */
export type MetricDataQuery = {
    Id?: string;
    MetricStat?: {
        Metric?: {
            Namespace?: string;
            MetricName?: string;
            Dimensions?: { Name: string; Value: string }[];
        };
        Period?: number;
        Stat?: string;
        Unit?: string;
    };
    Expression?: string;
    Label?: string;
    ReturnData?: boolean;
    Period?: number;
    AccountId?: string;
};

export type FakeCloudWatch = FakeServer & {
    /** Every MetricDataQuery of every GetMetricData request, in arrival order. */
    metricDataQueries(): MetricDataQuery[];
    setMetrics(metrics: CloudWatchMetric[]): void;
};

const SERVICE = 'GraniteServiceVersion20100801';
const CBOR_PATH = `/service/${SERVICE}/operation/`;
const JSON_TARGET = `${SERVICE}.`;
const JSON_CONTENT_TYPE = 'application/x-amz-json-1.0';

type Protocol = 'cbor' | 'json';

function cborReply(value: unknown, status = 200): FakeReply {
    return {
        status,
        headers: {
            'content-type': 'application/cbor',
            'smithy-protocol': 'rpc-v2-cbor',
        },
        body: encodeCbor(value),
    };
}

function errorReply(
    protocol: Protocol,
    status: number,
    type: string,
    message: string,
): FakeReply {
    if (protocol === 'cbor') {
        return cborReply({ __type: type, message }, status);
    }
    return {
        status,
        headers: {
            'content-type': JSON_CONTENT_TYPE,
            'x-amzn-errortype': type,
        },
        body: JSON.stringify({ __type: type, message }),
    };
}

/** The operation and decoded input of a CloudWatch RPC request, or why it is not one. */
function decodeRequest(
    request: RecordedRequest,
    rawBody: Buffer,
):
    | { protocol: Protocol; operation: string; input: Record<string, unknown> }
    | { error: FakeReply } {
    if (request.path.startsWith(CBOR_PATH)) {
        const operation = request.path.slice(CBOR_PATH.length);
        let input: unknown = {};
        if (rawBody.length > 0) {
            try {
                input = decodeCbor(rawBody);
            } catch (error) {
                return {
                    error: errorReply(
                        'cbor',
                        400,
                        'SerializationException',
                        String(error),
                    ),
                };
            }
        }
        return { protocol: 'cbor', operation, input: asRecord(input) };
    }
    const target = request.headers['x-amz-target'] ?? '';
    if (target.startsWith(JSON_TARGET)) {
        return {
            protocol: 'json',
            operation: target.slice(JSON_TARGET.length),
            input: asRecord(request.json ?? {}),
        };
    }
    return {
        error: {
            status: 400,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
            body: `fake CloudWatch: unsupported request ${request.method} ${request.path}`,
        },
    };
}

const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

function epochSeconds(iso: string): number {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
        throw new Error(`startFakeCloudWatch: bad timestamp ${iso}`);
    }
    return ms / 1000;
}

function checkMetrics(metrics: CloudWatchMetric[]): CloudWatchMetric[] {
    for (const metric of metrics) {
        for (const [timestamp] of metric.points) epochSeconds(timestamp);
    }
    return metrics;
}

export async function startFakeCloudWatch(
    opts: StartFakeCloudWatchOptions,
): Promise<FakeCloudWatch> {
    let metrics = checkMetrics(opts.metrics);
    const queries: MetricDataQuery[] = [];

    const getMetricData = (
        protocol: Protocol,
        input: Record<string, unknown>,
    ): FakeReply => {
        const received = Array.isArray(input.MetricDataQueries)
            ? (input.MetricDataQueries as MetricDataQuery[])
            : [];
        if (received.length === 0) {
            return errorReply(
                protocol,
                400,
                'ValidationError',
                'MetricDataQueries must not be empty',
            );
        }
        queries.push(...received);
        const results = received.map((query, i) => {
            const metric = metrics[i] ?? metrics[0];
            const points = metric?.points ?? [];
            const seconds = points.map(([timestamp]) =>
                epochSeconds(timestamp),
            );
            const values = points.map(([, value]) => value);
            return {
                Id: query.Id ?? `m${i}`,
                Label: query.Label ?? metric?.label ?? query.Id ?? `m${i}`,
                StatusCode: 'Complete',
                Timestamps:
                    protocol === 'cbor' ? seconds.map(cborTimestamp) : seconds,
                Values: protocol === 'cbor' ? values.map(cborDouble) : values,
            };
        });
        const output = { MetricDataResults: results, Messages: [] };
        return protocol === 'cbor'
            ? cborReply(output)
            : {
                  status: 200,
                  headers: { 'content-type': JSON_CONTENT_TYPE },
                  body: JSON.stringify(output),
              };
    };

    const server = await startFakeServer((request, _res, rawBody) => {
        const decoded = decodeRequest(request, rawBody);
        if ('error' in decoded) return decoded.error;
        const { protocol, operation, input } = decoded;
        if (protocol === 'cbor') request.json = input;
        if (operation === 'GetMetricData') {
            return getMetricData(protocol, input);
        }
        return errorReply(
            protocol,
            400,
            'UnknownOperationException',
            `fake CloudWatch does not implement ${operation}`,
        );
    });

    return {
        ...server,
        metricDataQueries: () => [...queries],
        setMetrics(next) {
            metrics = checkMetrics(next);
        },
    };
}
