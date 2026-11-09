/**
 * A fake CloudWatch Logs Insights serving fixed synthetic results (Harness API
 * `startFakeCloudWatchLogs`).
 *
 * Speaks AWS JSON 1.1 (`x-amz-target: Logs_20140328.<Operation>`), what the engine's
 * aws-sdk-cloudwatchlogs 1.163 sends. `StartQuery` records its input and answers a fresh
 * `queryId`; `GetQueryResults` for a known id answers `Complete` with every result at once (the
 * fake does not evaluate the query, the log groups or the time range), each result as
 * `[{ field, value }]` in the fixture's key order; `StopQuery` answers `success: true`. Unknown
 * query ids answer 400 `ResourceNotFoundException`, any other operation 400
 * `InvalidOperationException`.
 *
 * The fake does not check SigV4 signatures; the checks read the recorded `authorization` header
 * (the engine signs with the harness's fake `AKIDTESTNOTREAL00001` key).
 */
import {
    type FakeReply,
    type FakeServer,
    type RecordedRequest,
    startFakeServer,
} from './fakeServer';

/** One Logs Insights result: field name → value (`@timestamp` as `YYYY-MM-DD HH:MM:SS.mmm` UTC). */
export type CloudWatchLogsResult = Record<string, string>;

export type StartFakeCloudWatchLogsOptions = {
    results: CloudWatchLogsResult[];
};

/** A recorded `StartQuery` input (`startTime`/`endTime` in epoch seconds). */
export type CloudWatchLogsStartQuery = {
    logGroupNames?: string[];
    logGroupName?: string;
    logGroupIdentifiers?: string[];
    queryString: string;
    startTime: number;
    endTime: number;
    limit?: number;
};

export type FakeCloudWatchLogs = FakeServer & {
    /** Every StartQuery input received, in arrival order. */
    startQueries(): CloudWatchLogsStartQuery[];
    /** The query ids StopQuery was called with, in arrival order. */
    stoppedQueries(): string[];
    setResults(results: CloudWatchLogsResult[]): void;
};

const TARGET_PREFIX = 'Logs_20140328.';
const CONTENT_TYPE = 'application/x-amz-json-1.1';

const reply = (value: unknown, status = 200): FakeReply => ({
    status,
    headers: { 'content-type': CONTENT_TYPE },
    body: JSON.stringify(value),
});

const errorReply = (status: number, type: string, message: string) => ({
    ...reply({ __type: type, message }, status),
    headers: { 'content-type': CONTENT_TYPE, 'x-amzn-errortype': type },
});

const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

function checkResults(results: CloudWatchLogsResult[]): CloudWatchLogsResult[] {
    for (const result of results) {
        for (const [field, value] of Object.entries(result)) {
            if (typeof value !== 'string') {
                throw new Error(
                    `startFakeCloudWatchLogs: field ${field} must be a string`,
                );
            }
        }
    }
    return results;
}

export async function startFakeCloudWatchLogs(
    opts: StartFakeCloudWatchLogsOptions,
): Promise<FakeCloudWatchLogs> {
    let results = checkResults(opts.results);
    const started: CloudWatchLogsStartQuery[] = [];
    const stopped: string[] = [];
    const queryIds = new Set<string>();

    const operation = (request: RecordedRequest): FakeReply => {
        const target = request.headers['x-amz-target'] ?? '';
        if (request.method !== 'POST' || !target.startsWith(TARGET_PREFIX)) {
            return {
                status: 400,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
                body: `fake CloudWatch Logs: unsupported request ${request.method} ${request.path}`,
            };
        }
        const name = target.slice(TARGET_PREFIX.length);
        const input = asRecord(request.json);
        switch (name) {
            case 'StartQuery': {
                if (
                    typeof input.queryString !== 'string' ||
                    typeof input.startTime !== 'number' ||
                    typeof input.endTime !== 'number'
                ) {
                    return errorReply(
                        400,
                        'InvalidParameterException',
                        'queryString, startTime and endTime are required',
                    );
                }
                started.push(input as CloudWatchLogsStartQuery);
                const queryId = `fake-query-${started.length}`;
                queryIds.add(queryId);
                return reply({ queryId });
            }
            case 'GetQueryResults': {
                const queryId = input.queryId;
                if (typeof queryId !== 'string' || !queryIds.has(queryId)) {
                    return errorReply(
                        400,
                        'ResourceNotFoundException',
                        `unknown queryId ${String(queryId)}`,
                    );
                }
                return reply({
                    status: 'Complete',
                    results: results.map((result) =>
                        Object.entries(result).map(([field, value]) => ({
                            field,
                            value,
                        })),
                    ),
                    statistics: {
                        recordsMatched: results.length,
                        recordsScanned: results.length,
                        bytesScanned: 0,
                    },
                });
            }
            case 'StopQuery': {
                if (typeof input.queryId === 'string') {
                    stopped.push(input.queryId);
                }
                return reply({ success: true });
            }
            default:
                return errorReply(
                    400,
                    'InvalidOperationException',
                    `fake CloudWatch Logs does not implement ${name}`,
                );
        }
    };

    const server = await startFakeServer((request) => operation(request));

    return {
        ...server,
        startQueries: () => [...started],
        stoppedQueries: () => [...stopped],
        setResults(next) {
            results = checkResults(next);
        },
    };
}
