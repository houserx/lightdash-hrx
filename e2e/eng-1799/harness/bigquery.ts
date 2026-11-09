/**
 * A fake BigQuery REST API serving fixed synthetic Ops Mart tables (Harness API
 * `startFakeBigQuery`), shaped after what the engine's Ops Marts client calls
 * (federation-engine/src/ops_marts.rs):
 *
 * - `GET  /bigquery/v2/projects/<p>/datasets/<d>/tables/<t>` (`tables.get`) answers the table's
 *   `tableReference` and `schema.fields` (`{ name, type, mode: 'NULLABLE' }`); an unknown table
 *   answers 404 `notFound`, as BigQuery.
 * - `POST /bigquery/v2/projects/<p>/queries` (`jobs.query`) understands only the statement the
 *   engine sends: ``SELECT `c1`, `c2` FROM `<p>.<d>.<t>` [LIMIT n]`` (an empty column list is
 *   allowed). It answers `jobComplete: true`, a `jobReference` (`location: 'US'`), the selected
 *   columns' schema, the first page of rows and a `pageToken` when there are more. Anything else
 *   answers 400 `invalidQuery`.
 * - `GET  /bigquery/v2/projects/<p>/queries/<jobId>` (`jobs.getQueryResults`) answers the page
 *   named by `pageToken` (the first without one); an unknown job answers 404.
 *
 * Cells are BigQuery's JSON: `{ f: [{ v }] }` with every value a string (null stays null);
 * TIMESTAMP cells are int64 microseconds since the epoch (the engine always asks for
 * `formatOptions.useInt64Timestamp`), from an RFC 3339 fixture value. Every call must carry
 * `Authorization: Bearer <token>` (default {@link BIGQUERY_TOKEN}, which `startEngine` passes as
 * the `ops-marts` source's `access_token_env`); otherwise 401. The project id is not checked.
 */
import {
    type FakeReply,
    type FakeServer,
    jsonReply,
    startFakeServer,
} from './fakeServer';

/** The static bearer `startEngine` gives the `ops-marts` source. Not a real credential. */
export const BIGQUERY_TOKEN = 'test-bigquery-token-not-real';

/** The GCP project `startEngine` names in the `ops-marts` source. */
export const BIGQUERY_PROJECT = 'e2e-ops-marts';

export type BigQueryColumn = {
    name: string;
    /** A BigQuery type name: STRING, INT64, FLOAT64, BOOL, TIMESTAMP, DATE, ... */
    type: string;
};

/** A cell as written in a fixture; TIMESTAMP cells are RFC 3339 strings. */
export type BigQueryCell = string | number | boolean | null;

export type BigQueryTable = {
    dataset: string;
    table: string;
    columns: BigQueryColumn[];
    /** Positional, in `columns` order. */
    rows: BigQueryCell[][];
};

export type StartFakeBigQueryOptions = {
    tables: BigQueryTable[];
    /** Rows per result page (default 1000). */
    pageSize?: number;
    /** The bearer every call must carry (default {@link BIGQUERY_TOKEN}). */
    token?: string;
};

export type FakeBigQuery = FakeServer & {
    tables: BigQueryTable[];
    token: string;
    /** Every `jobs.query` statement received, in order. */
    queries(): string[];
};

type Job = {
    fields: { name: string; type: string; mode: string }[];
    rows: { f: { v: string | null }[] }[];
};

const API_PREFIX = '/bigquery/v2/projects/';

const bqError = (status: number, reason: string, message: string): FakeReply =>
    jsonReply(
        {
            error: {
                code: status,
                message,
                errors: [{ reason, message }],
                status: reason,
            },
        },
        status,
    );

/** A fixture cell as BigQuery's JSON cell value. */
function cellValue(type: string, cell: BigQueryCell): string | null {
    if (cell === null) return null;
    if (type === 'TIMESTAMP') {
        const ms = Date.parse(String(cell));
        if (Number.isNaN(ms)) {
            throw new Error(`fake BigQuery: bad TIMESTAMP ${String(cell)}`);
        }
        return String(BigInt(ms) * 1000n);
    }
    return String(cell);
}

/** Splits a list of backtick-quoted identifiers (`a`, `b\`c`) into names. */
function quotedNames(list: string): string[] | undefined {
    const names: string[] = [];
    let i = 0;
    const skipSpace = () => {
        while (list[i] === ' ') i += 1;
    };
    skipSpace();
    if (i === list.length) return names;
    for (;;) {
        if (list[i] !== '`') return undefined;
        i += 1;
        let name = '';
        while (i < list.length && list[i] !== '`') {
            if (list[i] === '\\') i += 1;
            name += list[i] ?? '';
            i += 1;
        }
        if (list[i] !== '`') return undefined;
        i += 1;
        names.push(name);
        skipSpace();
        if (i === list.length) return names;
        if (list[i] !== ',') return undefined;
        i += 1;
        skipSpace();
    }
}

export async function startFakeBigQuery(
    opts: StartFakeBigQueryOptions,
): Promise<FakeBigQuery> {
    const pageSize = opts.pageSize ?? 1000;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
        throw new Error(`startFakeBigQuery: bad pageSize ${pageSize}`);
    }
    const token = opts.token ?? BIGQUERY_TOKEN;
    const tables = opts.tables;
    const find = (dataset: string, table: string) =>
        tables.find((t) => t.dataset === dataset && t.table === table);
    const jobs = new Map<string, Job>();
    const queries: string[] = [];
    let nextJob = 1;

    const page = (jobId: string, job: Job, pageToken?: string): FakeReply => {
        const start = pageToken ? Number(pageToken.replace(/^page-/, '')) : 0;
        if (!Number.isInteger(start) || start < 0 || start > job.rows.length) {
            return bqError(400, 'invalid', `bad pageToken ${pageToken}`);
        }
        const end = Math.min(start + pageSize, job.rows.length);
        return jsonReply({
            kind: 'bigquery#getQueryResultsResponse',
            jobReference: { projectId: BIGQUERY_PROJECT, jobId, location: 'US' },
            jobComplete: true,
            schema: { fields: job.fields },
            totalRows: String(job.rows.length),
            rows: job.rows.slice(start, end),
            ...(end < job.rows.length ? { pageToken: `page-${end}` } : {}),
        });
    };

    const server = await startFakeServer((request) => {
        if (request.headers.authorization !== `Bearer ${token}`) {
            return bqError(
                401,
                'unauthorized',
                'Request is missing a valid bearer token.',
            );
        }
        if (!request.path.startsWith(API_PREFIX)) {
            return bqError(404, 'notFound', `Not found: ${request.path}`);
        }
        const segments = request.path
            .slice(API_PREFIX.length)
            .split('/')
            .map(decodeURIComponent);
        const [, ...rest] = segments;

        if (
            request.method === 'GET' &&
            rest.length === 4 &&
            rest[0] === 'datasets' &&
            rest[2] === 'tables'
        ) {
            const t = find(rest[1], rest[3]);
            if (!t) {
                return bqError(404, 'notFound', `Not found: Table ${rest[1]}.${rest[3]}`);
            }
            return jsonReply({
                kind: 'bigquery#table',
                tableReference: {
                    projectId: segments[0],
                    datasetId: t.dataset,
                    tableId: t.table,
                },
                schema: {
                    fields: t.columns.map((c) => ({
                        name: c.name,
                        type: c.type,
                        mode: 'NULLABLE',
                    })),
                },
                numRows: String(t.rows.length),
            });
        }

        if (request.method === 'POST' && rest.length === 1 && rest[0] === 'queries') {
            const sql = String((request.json as { query?: unknown })?.query ?? '');
            queries.push(sql);
            const m = /^SELECT (.*) FROM `([^`]+)`(?: LIMIT (\d+))?$/s.exec(sql);
            const names = m ? quotedNames(m[1]) : undefined;
            const ref = m?.[2].split('.');
            if (!m || !names || !ref || ref.length !== 3) {
                return bqError(400, 'invalidQuery', `The fake cannot run: ${sql}`);
            }
            const t = find(ref[1], ref[2]);
            if (!t) {
                return bqError(404, 'notFound', `Not found: Table ${ref.join('.')}`);
            }
            const positions = names.map((name) =>
                t.columns.findIndex((c) => c.name === name),
            );
            const missing = names.find((_, i) => positions[i] < 0);
            if (missing !== undefined) {
                return bqError(400, 'invalidQuery', `Unrecognized name: ${missing}`);
            }
            const limit = m[3] === undefined ? t.rows.length : Number(m[3]);
            const job: Job = {
                fields: positions.map((at) => ({
                    name: t.columns[at].name,
                    type: t.columns[at].type,
                    mode: 'NULLABLE',
                })),
                rows: t.rows.slice(0, limit).map((row) => ({
                    f: positions.map((at) => ({
                        v: cellValue(t.columns[at].type, row[at] ?? null),
                    })),
                })),
            };
            const jobId = `job_e2e_${nextJob}`;
            nextJob += 1;
            jobs.set(jobId, job);
            return page(jobId, job);
        }

        if (request.method === 'GET' && rest.length === 2 && rest[0] === 'queries') {
            const job = jobs.get(rest[1]);
            if (!job) return bqError(404, 'notFound', `Not found: Job ${rest[1]}`);
            return page(rest[1], job, request.params.pageToken || undefined);
        }

        return bqError(404, 'notFound', `Not found: ${request.method} ${request.path}`);
    });

    return {
        ...server,
        tables,
        token,
        queries: () => [...queries],
    };
}
