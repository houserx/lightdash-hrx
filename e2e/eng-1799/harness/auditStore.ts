/**
 * The fake audit store (Harness API `startFakeAuditStore`): the DynamoDB `executions` table and
 * the S3 Object Lock bucket the engine's `[audit]` writer uses, on one fake server. Mirrors the
 * engine line's Rust harness (federation-engine/tests/acceptance/harness/aws.rs).
 *
 * - DynamoDB, AWS JSON 1.0 (`x-amz-target: DynamoDB_20120810.<Operation>`):
 *   `PutItem` stores the item (a second item with the same `id` fails the engine's
 *   `attribute_not_exists(id)` condition), `Query` reads the table or one of the portal's GSIs
 *   (`byMonth`, `byTicket`, `byUser`; sort key `createdAt`) with paging by `LastEvaluatedKey`.
 * - S3, path-style `PUT /<bucket>/<key>` (`PutObject`): stores the object; an aws-chunked body
 *   (SigV4 streaming, with or without a checksum trailer) is decoded first.
 * - `setFailing(true)` makes every put (PutItem and PutObject) answer a 5xx, which the engine
 *   turns into SQLSTATE 58000 `audit write failed`.
 */
import { type FakeReply, type FakeServer, startFakeServer } from './fakeServer';

/** The table and bucket names the harness renders into `[audit]`. */
export const AUDIT_TABLE = 'db-query-portal-executions';
export const AUDIT_BUCKET = 'db-query-portal-audit';

/** A plain-JSON execution (DynamoDB numbers become JSON numbers). */
export type AuditItem = Record<string, unknown>;

export type AuditObject = {
    key: string;
    /** The object's bytes as UTF-8 (aws-chunked framing removed). */
    body: string;
    /** The PutObject request's headers, lower-case keys. */
    headers: Record<string, string>;
};

export type FakeAuditStore = FakeServer & {
    /** The `[audit] dynamodb_endpoint_url`. */
    dynamodbUrl: string;
    /** The `[audit] s3_endpoint_url` (the engine uses path-style addressing). */
    s3Url: string;
    /** Stored executions, in write order. */
    items(): AuditItem[];
    /** Stored S3 objects, in write order. */
    objects(): AuditObject[];
    /** While true, every PutItem and PutObject fails with a 5xx. */
    setFailing(failing: boolean): void;
};

const DYNAMODB_JSON = 'application/x-amz-json-1.0';
const DYNAMODB_TARGET_PREFIX = 'DynamoDB_20120810.';

type AttributeValue = Record<string, unknown>;

const dynamoReply = (value: unknown): FakeReply => ({
    status: 200,
    headers: { 'content-type': DYNAMODB_JSON },
    body: JSON.stringify(value),
});

const dynamoError = (
    status: number,
    type: string,
    message: string,
): FakeReply => ({
    status,
    headers: { 'content-type': DYNAMODB_JSON, 'x-amzn-errortype': type },
    body: JSON.stringify({
        __type: `com.amazonaws.dynamodb.v20120810#${type}`,
        message,
    }),
});

const s3Error = (status: number, code: string, message: string): FakeReply => ({
    status,
    headers: { 'content-type': 'application/xml' },
    body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>fake</RequestId></Error>`,
});

// ---------------------------------------------------------------------------------------------
// DynamoDB attribute values
// ---------------------------------------------------------------------------------------------

function unmarshalAttr(value: AttributeValue): unknown {
    const [type, x] = Object.entries(value)[0] ?? [];
    switch (type) {
        case 'S':
        case 'BOOL':
        case 'SS':
        case 'NS':
            return x;
        case 'N':
            return Number(x);
        case 'NULL':
            return null;
        case 'M':
            return unmarshalItem(x as Record<string, AttributeValue>);
        case 'L':
            return (x as AttributeValue[]).map(unmarshalAttr);
        default:
            throw new Error(`unsupported DynamoDB attribute type ${type}`);
    }
}

function unmarshalItem(item: Record<string, AttributeValue>): AuditItem {
    return Object.fromEntries(
        Object.entries(item).map(([k, v]) => [k, unmarshalAttr(v)]),
    );
}

function marshalAttr(value: unknown): AttributeValue {
    if (value === null || value === undefined) return { NULL: true };
    if (typeof value === 'boolean') return { BOOL: value };
    if (typeof value === 'number') return { N: String(value) };
    if (typeof value === 'string') return { S: value };
    if (Array.isArray(value)) return { L: value.map(marshalAttr) };
    return { M: marshalItem(value as AuditItem) };
}

function marshalItem(item: AuditItem): Record<string, AttributeValue> {
    return Object.fromEntries(
        Object.entries(item).map(([k, v]) => [k, marshalAttr(v)]),
    );
}

// ---------------------------------------------------------------------------------------------
// Query over the portal's GSIs
// ---------------------------------------------------------------------------------------------

const INDEX_PARTITION_KEYS: Record<string, string> = {
    '': 'id',
    byMonth: 'createdAtMonth',
    byTicket: 'linearTicketId',
    byUser: 'executedByEmail',
};

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * `<pk> = :v` plus an optional `createdAt BETWEEN :a AND :b | >= :a | <= :b`, a simple
 * `FilterExpression` (`a = :v` / `a <> :v` joined by AND), ScanIndexForward, Limit,
 * ExclusiveStartKey/LastEvaluatedKey and `Select: COUNT` (as the engine's Rust harness does).
 */
function runQuery(items: AuditItem[], input: Record<string, any>) {
    const names: Record<string, string> = input.ExpressionAttributeNames ?? {};
    const values: Record<string, unknown> = Object.fromEntries(
        Object.entries(
            (input.ExpressionAttributeValues ?? {}) as Record<
                string,
                AttributeValue
            >,
        ).map(([k, v]) => [k, unmarshalAttr(v)]),
    );
    const resolve = (token: string) => names[token] ?? token;
    const index: string = input.IndexName ?? '';
    const pk = INDEX_PARTITION_KEYS[index];
    if (!pk) throw new QueryError(`unknown index ${index}`);
    const kce: string = input.KeyConditionExpression ?? '';
    const tokens = kce.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
    let pkValue: unknown;
    let hasPk = false;
    let lo: string | undefined;
    let hi: string | undefined;
    for (let i = 0; i < tokens.length; i += 1) {
        const attr = resolve(tokens[i]);
        const op = tokens[i + 1]?.toUpperCase();
        if (attr === pk && op === '=' && i + 2 < tokens.length) {
            pkValue = values[tokens[i + 2]];
            hasPk = true;
            i += 2;
        } else if (attr === 'createdAt' && op === 'BETWEEN') {
            lo = text(values[tokens[i + 2]]);
            hi = text(values[tokens[i + 4]]);
            i += 4;
        } else if (attr === 'createdAt' && (op === '>=' || op === '>')) {
            lo = text(values[tokens[i + 2]]);
            i += 2;
        } else if (attr === 'createdAt' && (op === '<=' || op === '<')) {
            hi = text(values[tokens[i + 2]]);
            i += 2;
        }
    }
    if (!hasPk) {
        throw new QueryError(
            `KeyConditionExpression ${JSON.stringify(kce)} has no \`${pk} = :v\` for index ${JSON.stringify(index)}`,
        );
    }
    const filters = String(input.FilterExpression ?? '')
        .split(' AND ')
        .map((c) => c.trim().split(/\s+/))
        .filter((t) => t.length === 3)
        .map(([a, op, v]) => ({ attr: resolve(a), op, value: values[v] }));

    const matching = items
        .filter((it) => it[pk] === pkValue)
        .filter((it) => lo === undefined || text(it.createdAt) >= lo)
        .filter((it) => hi === undefined || text(it.createdAt) <= hi)
        .sort((a, b) => {
            const ka = `${text(a.createdAt)}\u0000${text(a.id)}`;
            const kb = `${text(b.createdAt)}\u0000${text(b.id)}`;
            if (ka === kb) return 0;
            return ka < kb ? -1 : 1;
        });
    if (input.ScanIndexForward === false) matching.reverse();
    let rest = matching;
    if (input.ExclusiveStartKey) {
        const start = unmarshalItem(input.ExclusiveStartKey);
        const pos = matching.findIndex((it) => it.id === start.id);
        if (pos >= 0) rest = matching.slice(pos + 1);
    }
    const limit: number | undefined =
        typeof input.Limit === 'number' ? input.Limit : undefined;
    const evaluated = limit === undefined ? rest : rest.slice(0, limit);
    const page = evaluated.filter((it) =>
        filters.every(({ attr, op, value }) => {
            const x = it[attr] ?? null;
            if (op === '=') return x === (value ?? null);
            if (op === '<>') return x !== (value ?? null);
            return true;
        }),
    );
    const out: Record<string, unknown> = {
        Count: page.length,
        ScannedCount: evaluated.length,
    };
    if (input.Select !== 'COUNT') out.Items = page.map(marshalItem);
    if (evaluated.length < rest.length) {
        const last = evaluated[evaluated.length - 1];
        const key: AuditItem = { id: last.id };
        if (pk !== 'id') {
            key[pk] = last[pk];
            key.createdAt = last.createdAt;
        }
        out.LastEvaluatedKey = marshalItem(key);
    }
    return out;
}

class QueryError extends Error {}

// ---------------------------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------------------------

/** Undoes `Content-Encoding: aws-chunked` (SigV4 streaming, with or without trailers). */
export function decodeAwsChunked(body: Buffer): Buffer {
    const out: Buffer[] = [];
    let i = 0;
    while (i < body.length) {
        const eol = body.indexOf('\r\n', i);
        if (eol < 0) break;
        const size = parseInt(
            body.subarray(i, eol).toString('latin1').split(';')[0].trim(),
            16,
        );
        if (Number.isNaN(size)) break;
        i = eol + 2;
        if (size === 0) break;
        out.push(body.subarray(i, Math.min(i + size, body.length)));
        i += size + 2;
    }
    return Buffer.concat(out);
}

export async function startFakeAuditStore(): Promise<FakeAuditStore> {
    const items: AuditItem[] = [];
    const objects: AuditObject[] = [];
    let failing = false;

    const dynamodb = (operation: string, input: any): FakeReply => {
        if (operation === 'PutItem') {
            if (failing) {
                return dynamoError(
                    500,
                    'InternalServerError',
                    'fake audit store is failing on purpose',
                );
            }
            if (input?.TableName !== AUDIT_TABLE) {
                return dynamoError(
                    400,
                    'ResourceNotFoundException',
                    `Requested resource not found: Table: ${input?.TableName} not found`,
                );
            }
            const item = unmarshalItem(input.Item ?? {});
            if (items.some((it) => it.id === item.id)) {
                return dynamoError(
                    400,
                    'ConditionalCheckFailedException',
                    'The conditional request failed',
                );
            }
            items.push(item);
            return dynamoReply({});
        }
        if (operation === 'Query') {
            if (input?.TableName !== AUDIT_TABLE) {
                return dynamoError(
                    400,
                    'ResourceNotFoundException',
                    `Requested resource not found: Table: ${input?.TableName} not found`,
                );
            }
            try {
                return dynamoReply(runQuery(items, input));
            } catch (error) {
                if (!(error instanceof QueryError)) throw error;
                return dynamoError(400, 'ValidationException', error.message);
            }
        }
        return dynamoError(
            400,
            'UnknownOperationException',
            `fake audit store does not implement ${operation}`,
        );
    };

    const server = await startFakeServer((request, _res, rawBody) => {
        const target = request.headers['x-amz-target'];
        if (target !== undefined) {
            if (!target.startsWith(DYNAMODB_TARGET_PREFIX)) {
                return dynamoError(
                    400,
                    'UnknownOperationException',
                    `fake audit store does not implement ${target}`,
                );
            }
            return dynamodb(
                target.slice(DYNAMODB_TARGET_PREFIX.length),
                request.json,
            );
        }
        if (request.method !== 'PUT') {
            return s3Error(
                501,
                'NotImplemented',
                'fake audit store answers PutObject only',
            );
        }
        if (failing) {
            return s3Error(
                500,
                'InternalError',
                'fake audit store is failing on purpose',
            );
        }
        const path = request.path.replace(/^\/+/, '');
        const slash = path.indexOf('/');
        const bucket = decodeURIComponent(
            slash < 0 ? path : path.slice(0, slash),
        );
        const key = slash < 0 ? '' : decodeURIComponent(path.slice(slash + 1));
        if (bucket !== AUDIT_BUCKET) {
            return s3Error(
                404,
                'NoSuchBucket',
                'The specified bucket does not exist',
            );
        }
        const chunked =
            (request.headers['content-encoding'] ?? '').includes(
                'aws-chunked',
            ) ||
            (request.headers['x-amz-content-sha256'] ?? '').startsWith(
                'STREAMING-',
            );
        const body = chunked ? decodeAwsChunked(rawBody) : rawBody;
        objects.push({
            key,
            body: body.toString('utf8'),
            headers: { ...request.headers },
        });
        return {
            status: 200,
            headers: { etag: '"0123456789abcdef0123456789abcdef"' },
            body: '',
        };
    });
    return {
        ...server,
        dynamodbUrl: server.url,
        s3Url: server.url,
        items: () => items.map((it) => structuredClone(it)),
        objects: () => objects.map((o) => ({ ...o, headers: { ...o.headers } })),
        setFailing(on: boolean) {
            failing = on;
        },
    };
}
