// ENG-1799 demo: the fake audit store the Federation Engine's `[audit]` writer and audit browser use
// (CONTRACTS §6): db-query-portal's DynamoDB `executions` table and its S3 Object Lock bucket, in memory.
// telemetry-fakes serves one AuditStore on two endpoints the engine config reserved:
//
//   endpoints.auditDynamodb  DynamoDB, AWS JSON 1.0 (`X-Amz-Target: DynamoDB_20120810.<Op>`):
//     PutItem   stores an execution; `attribute_not_exists(id)` (the engine always sends it) fails a second
//               item with the same id with ConditionalCheckFailedException;
//     Query     the table (`id = :v`) or one of the portal's GSIs, `byMonth` (createdAtMonth), `byTicket`
//               (linearTicketId, sparse), `byUser` (executedByEmail), sort key createdAt; ScanIndexForward,
//               Limit, ExclusiveStartKey / LastEvaluatedKey, an optional createdAt range in the key condition;
//     GetItem   by id; DescribeTable.
//   endpoints.auditS3        S3, path-style `/<bucket>/<key>`, a versioned Object Lock bucket:
//     PUT       PutObject: every put is a new version; `x-amz-object-lock-mode` (COMPLIANCE|GOVERNANCE) needs
//               a future `x-amz-object-lock-retain-until-date`; an aws-chunked (SigV4 streaming) body is decoded;
//     GET/HEAD  the object (`?versionId=` for an older version), ListObjectsV2 (`GET /<bucket>?list-type=2`);
//     DELETE    refused (403 AccessDenied) while any version of the key is under retention, as Object Lock does
//               for COMPLIANCE; the demo never deletes, so an unlocked delete is refused too (501).
// Both answer GET /ready. Records live as long as the telemetry-fakes process (down.sh discards them).
// Nothing here logs a record.
import { createHash, randomUUID } from 'node:crypto';
import type http from 'node:http';

export const AUDIT_TABLE = 'demo-federation-audit';
export const AUDIT_BUCKET = 'demo-federation-audit';

const MAX_BODY_BYTES = 1024 * 1024;
const DYNAMODB_JSON = 'application/x-amz-json-1.0';
const TARGET_PREFIX = 'DynamoDB_20120810.';

type Plain = Record<string, unknown>;
type AttributeValue = Record<string, unknown>;

class AwsError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

// ---------------------------------------------------------------- DynamoDB attribute values

function unmarshal(value: unknown): unknown {
    if (value === null || typeof value !== 'object') throw new AwsError(400, 'ValidationException', 'an attribute value must be a structure');
    const [type, x] = Object.entries(value as AttributeValue)[0] ?? [];
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
            return unmarshalItem(x);
        case 'L':
            if (!Array.isArray(x)) throw new AwsError(400, 'ValidationException', 'L must be a list');
            return x.map(unmarshal);
        default:
            throw new AwsError(400, 'ValidationException', `unsupported attribute type ${String(type)}`);
    }
}

function unmarshalItem(item: unknown): Plain {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new AwsError(400, 'ValidationException', 'an item must be a map of attribute values');
    }
    return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, unmarshal(v)]));
}

function marshal(value: unknown): AttributeValue {
    if (value === null || value === undefined) return { NULL: true };
    if (typeof value === 'boolean') return { BOOL: value };
    if (typeof value === 'number') return { N: String(value) };
    if (typeof value === 'string') return { S: value };
    if (Array.isArray(value)) return { L: value.map(marshal) };
    return { M: marshalItem(value as Plain) };
}

function marshalItem(item: Plain): Record<string, AttributeValue> {
    return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, marshal(v)]));
}

// ---------------------------------------------------------------- the store

/** Partition key of the table ('') and of the portal's GSIs; every GSI sorts by createdAt. */
const PARTITION_KEYS: Record<string, string> = {
    '': 'id',
    byMonth: 'createdAtMonth',
    byTicket: 'linearTicketId',
    byUser: 'executedByEmail',
};

type ObjectVersion = {
    versionId: string;
    body: Buffer;
    contentType: string;
    lastModified: Date;
    lockMode: string | null;
    retainUntil: Date | null;
};

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** The audit table and bucket, shared by the DynamoDB and S3 handlers. */
export class AuditStore {
    private readonly items = new Map<string, Plain>();
    private readonly objects = new Map<string, ObjectVersion[]>();

    constructor(private readonly now: () => number = Date.now) {}

    // DynamoDB

    putItem(input: Plain): Plain {
        tableOf(input);
        const item = unmarshalItem(input.Item);
        if (typeof item.id !== 'string' || item.id === '') {
            throw new AwsError(400, 'ValidationException', 'One or more parameter values were invalid: Missing the key id in the item');
        }
        const condition = text(input.ConditionExpression).replace(/\s+/g, '');
        if (condition && condition !== 'attribute_not_exists(id)') {
            throw new AwsError(400, 'ValidationException', `the fake audit store supports only attribute_not_exists(id), got ${input.ConditionExpression}`);
        }
        if (condition && this.items.has(item.id)) {
            throw new AwsError(400, 'ConditionalCheckFailedException', 'The conditional request failed');
        }
        this.items.set(item.id, item);
        return {};
    }

    getItem(input: Plain): Plain {
        tableOf(input);
        const key = unmarshalItem(input.Key);
        const item = typeof key.id === 'string' ? this.items.get(key.id) : undefined;
        return item ? { Item: marshalItem(item) } : {};
    }

    describeTable(input: Plain): Plain {
        const name = tableOf(input);
        return {
            Table: {
                TableName: name,
                TableStatus: 'ACTIVE',
                ItemCount: this.items.size,
                KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
                GlobalSecondaryIndexes: Object.entries(PARTITION_KEYS)
                    .filter(([index]) => index !== '')
                    .map(([index, pk]) => ({
                        IndexName: index,
                        IndexStatus: 'ACTIVE',
                        KeySchema: [
                            { AttributeName: pk, KeyType: 'HASH' },
                            { AttributeName: 'createdAt', KeyType: 'RANGE' },
                        ],
                        Projection: { ProjectionType: 'ALL' },
                    })),
            },
        };
    }

    /** `<pk> = :v [AND createdAt BETWEEN :a AND :b | >= :a | > :a | <= :b | < :b]`, newest last unless ScanIndexForward is false. */
    query(input: Plain): Plain {
        tableOf(input);
        const index = text(input.IndexName);
        const pk = PARTITION_KEYS[index];
        if (!pk) throw new AwsError(400, 'ValidationException', `The table does not have the specified index: ${index}`);
        if (input.FilterExpression !== undefined) {
            throw new AwsError(400, 'ValidationException', 'the fake audit store does not support FilterExpression');
        }
        const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
        const rawValues = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
        const value = (token: string | undefined) => {
            if (token === undefined || !(token in rawValues)) {
                throw new AwsError(400, 'ValidationException', `An expression attribute value used in expression is not defined: ${String(token)}`);
            }
            return unmarshal(rawValues[token]);
        };
        const attr = (token: string) => names[token] ?? token;
        const tokens = text(input.KeyConditionExpression).replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
        let pkValue: unknown;
        let hasPk = false;
        let lo: { v: string; strict: boolean } | undefined;
        let hi: { v: string; strict: boolean } | undefined;
        for (let i = 0; i < tokens.length; i += 1) {
            if (tokens[i].toUpperCase() === 'AND') continue;
            const name = attr(tokens[i]);
            const op = tokens[i + 1]?.toUpperCase();
            if (name === pk && op === '=') {
                pkValue = value(tokens[i + 2]);
                hasPk = true;
                i += 2;
            } else if (name === 'createdAt' && op === 'BETWEEN' && tokens[i + 3]?.toUpperCase() === 'AND') {
                lo = { v: text(value(tokens[i + 2])), strict: false };
                hi = { v: text(value(tokens[i + 4])), strict: false };
                i += 4;
            } else if (name === 'createdAt' && (op === '>=' || op === '>')) {
                lo = { v: text(value(tokens[i + 2])), strict: op === '>' };
                i += 2;
            } else if (name === 'createdAt' && (op === '<=' || op === '<')) {
                hi = { v: text(value(tokens[i + 2])), strict: op === '<' };
                i += 2;
            } else {
                throw new AwsError(400, 'ValidationException', `Query condition not supported by the fake audit store: ${String(input.KeyConditionExpression)}`);
            }
        }
        if (!hasPk) throw new AwsError(400, 'ValidationException', `Query condition missed key schema element: ${pk}`);

        const matching = [...this.items.values()]
            .filter((it) => it[pk] !== undefined && it[pk] === pkValue)
            .filter((it) => {
                const at = text(it.createdAt);
                if (lo && (lo.strict ? at <= lo.v : at < lo.v)) return false;
                if (hi && (hi.strict ? at >= hi.v : at > hi.v)) return false;
                return true;
            })
            .sort((a, b) => {
                const ka = `${text(a.createdAt)}\u0000${text(a.id)}`;
                const kb = `${text(b.createdAt)}\u0000${text(b.id)}`;
                return ka === kb ? 0 : ka < kb ? -1 : 1;
            });
        if (input.ScanIndexForward === false) matching.reverse();
        let rest = matching;
        if (input.ExclusiveStartKey !== undefined) {
            const start = unmarshalItem(input.ExclusiveStartKey);
            if (typeof start.id !== 'string') throw new AwsError(400, 'ValidationException', 'The provided starting key is invalid');
            const at = matching.findIndex((it) => it.id === start.id);
            rest = at >= 0 ? matching.slice(at + 1) : [];
        }
        const limit = input.Limit;
        if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
            throw new AwsError(400, 'ValidationException', 'Limit must be a positive integer');
        }
        const page = limit === undefined ? rest : rest.slice(0, limit);
        const out: Plain = { Count: page.length, ScannedCount: page.length };
        if (input.Select !== 'COUNT') out.Items = page.map(marshalItem);
        if (page.length < rest.length) {
            const last = page[page.length - 1];
            const key: Plain = { id: last.id };
            if (pk !== 'id') {
                key[pk] = last[pk];
                key.createdAt = last.createdAt;
            }
            out.LastEvaluatedKey = marshalItem(key);
        }
        return out;
    }

    // S3

    putObject(key: string, body: Buffer, headers: http.IncomingHttpHeaders): Record<string, string> {
        const mode = header(headers, 'x-amz-object-lock-mode');
        const until = header(headers, 'x-amz-object-lock-retain-until-date');
        if (Boolean(mode) !== Boolean(until)) {
            throw new AwsError(400, 'InvalidRequest', 'x-amz-object-lock-mode and x-amz-object-lock-retain-until-date must both be supplied');
        }
        let retainUntil: Date | null = null;
        if (mode) {
            if (mode !== 'COMPLIANCE' && mode !== 'GOVERNANCE') throw new AwsError(400, 'InvalidArgument', `Unknown wormMode directive: ${mode}`);
            retainUntil = new Date(until as string);
            if (Number.isNaN(retainUntil.getTime())) throw new AwsError(400, 'InvalidArgument', 'The retain until date is not a date');
            if (retainUntil.getTime() <= this.now()) {
                throw new AwsError(400, 'InvalidArgument', 'The retain until date must be in the future!');
            }
        }
        const version: ObjectVersion = {
            versionId: randomUUID().replace(/-/g, ''),
            body,
            contentType: header(headers, 'content-type') ?? 'binary/octet-stream',
            lastModified: new Date(this.now()),
            lockMode: mode ?? null,
            retainUntil,
        };
        const versions = this.objects.get(key) ?? [];
        versions.push(version);
        this.objects.set(key, versions);
        return { etag: etag(body), 'x-amz-version-id': version.versionId };
    }

    getObject(key: string, versionId: string | null): ObjectVersion {
        const versions = this.objects.get(key);
        const version = versionId === null ? versions?.at(-1) : versions?.find((v) => v.versionId === versionId);
        if (!version) {
            throw versionId === null
                ? new AwsError(404, 'NoSuchKey', 'The specified key does not exist.')
                : new AwsError(404, 'NoSuchVersion', 'The specified version does not exist.');
        }
        return version;
    }

    deleteObject(key: string): never {
        const locked = (this.objects.get(key) ?? []).some((v) => v.retainUntil !== null && v.retainUntil.getTime() > this.now());
        if (locked) throw new AwsError(403, 'AccessDenied', 'Access Denied because object protected by object lock.');
        throw new AwsError(501, 'NotImplemented', 'the fake audit store keeps every object');
    }

    listObjects(prefix: string, maxKeys: number): string {
        const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const shown = keys.slice(0, maxKeys);
        const contents = shown
            .map((k) => {
                const v = this.objects.get(k)?.at(-1) as ObjectVersion;
                return `<Contents><Key>${xml(k)}</Key><LastModified>${v.lastModified.toISOString()}</LastModified><ETag>${xml(etag(v.body))}</ETag><Size>${v.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
            })
            .join('');
        return (
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            `<Name>${AUDIT_BUCKET}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${shown.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
            `<IsTruncated>${shown.length < keys.length}</IsTruncated>${contents}</ListBucketResult>`
        );
    }
}

function tableOf(input: Plain): string {
    if (input.TableName !== AUDIT_TABLE) {
        throw new AwsError(400, 'ResourceNotFoundException', `Requested resource not found: Table: ${String(input.TableName)} not found`);
    }
    return AUDIT_TABLE;
}

function header(headers: http.IncomingHttpHeaders, name: string): string | undefined {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
}

const etag = (body: Buffer) => `"${createHash('md5').update(body).digest('hex')}"`;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Undoes `Content-Encoding: aws-chunked` (SigV4 streaming, with or without a checksum trailer). */
export function decodeAwsChunked(body: Buffer): Buffer {
    const out: Buffer[] = [];
    let i = 0;
    while (i < body.length) {
        const eol = body.indexOf('\r\n', i);
        if (eol < 0) break;
        const size = parseInt(body.subarray(i, eol).toString('latin1').split(';')[0].trim(), 16);
        if (Number.isNaN(size)) break;
        i = eol + 2;
        if (size === 0) break;
        out.push(body.subarray(i, Math.min(i + size, body.length)));
        i += size + 2;
    }
    return Buffer.concat(out);
}

// ---------------------------------------------------------------- HTTP

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new AwsError(413, 'EntityTooLarge', 'request body too large');
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

function ready(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.method === 'GET' && (req.url ?? '/').split('?')[0] === '/ready') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ready\n');
        return true;
    }
    return false;
}

/** The fake DynamoDB of `store`. */
export function auditDynamodbHandler(store: AuditStore): http.RequestListener {
    const reply = (res: http.ServerResponse, status: number, body: unknown, errorType?: string) => {
        const headers: Record<string, string> = { 'content-type': DYNAMODB_JSON, 'x-amzn-requestid': 'demo-fake-audit-dynamodb' };
        if (errorType) headers['x-amzn-errortype'] = errorType;
        res.writeHead(status, headers);
        res.end(JSON.stringify(body));
    };
    return (req, res) => {
        if (ready(req, res)) return;
        const target = header(req.headers, 'x-amz-target');
        const fail = (e: unknown) => {
            const err = e instanceof AwsError ? e : new AwsError(500, 'InternalServerError', e instanceof Error ? e.message : String(e));
            reply(res, err.status, { __type: `com.amazonaws.dynamodb.v20120810#${err.code}`, message: err.message }, err.code);
        };
        if (req.method !== 'POST' || !target?.startsWith(TARGET_PREFIX)) {
            fail(new AwsError(400, 'UnknownOperationException', `no DynamoDB operation in ${req.method} ${req.url ?? '/'}`));
            return;
        }
        const operation = target.slice(TARGET_PREFIX.length);
        readBody(req)
            .then((body) => {
                let input: unknown;
                try {
                    input = body.length ? JSON.parse(body.toString('utf8')) : {};
                } catch {
                    throw new AwsError(400, 'SerializationException', 'The request body is not JSON.');
                }
                if (input === null || typeof input !== 'object' || Array.isArray(input)) {
                    throw new AwsError(400, 'SerializationException', 'The request body must be a structure.');
                }
                switch (operation) {
                    case 'PutItem':
                        return store.putItem(input as Plain);
                    case 'Query':
                        return store.query(input as Plain);
                    case 'GetItem':
                        return store.getItem(input as Plain);
                    case 'DescribeTable':
                        return store.describeTable(input as Plain);
                    default:
                        throw new AwsError(400, 'UnknownOperationException', `the fake audit store does not implement ${operation}`);
                }
            })
            .then((out) => reply(res, 200, out), fail);
    };
}

/** The fake S3 Object Lock bucket of `store` (path-style addressing). */
export function auditS3Handler(store: AuditStore): http.RequestListener {
    const fail = (res: http.ServerResponse, e: unknown) => {
        const err = e instanceof AwsError ? e : new AwsError(500, 'InternalError', e instanceof Error ? e.message : String(e));
        res.writeHead(err.status, { 'content-type': 'application/xml', 'x-amz-request-id': 'demo-fake-audit-s3' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${err.code}</Code><Message>${xml(err.message)}</Message><RequestId>demo-fake-audit-s3</RequestId></Error>`);
    };
    return (req, res) => {
        if (ready(req, res)) return;
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname.replace(/^\/+/, '');
        const slash = path.indexOf('/');
        const bucket = decodeURIComponent(slash < 0 ? path : path.slice(0, slash));
        const key = slash < 0 ? '' : decodeURIComponent(path.slice(slash + 1));
        const handle = async () => {
            if (bucket !== AUDIT_BUCKET) throw new AwsError(404, 'NoSuchBucket', 'The specified bucket does not exist');
            if (key === '') {
                if (req.method !== 'GET' || url.searchParams.get('list-type') !== '2') {
                    throw new AwsError(501, 'NotImplemented', 'the fake audit store lists with ListObjectsV2 only');
                }
                const maxKeys = Math.min(Math.max(Number(url.searchParams.get('max-keys') ?? 1000) || 1000, 1), 1000);
                res.writeHead(200, { 'content-type': 'application/xml' });
                res.end(store.listObjects(url.searchParams.get('prefix') ?? '', maxKeys));
                return;
            }
            switch (req.method) {
                case 'PUT': {
                    // PutObject carries only `x-id=PutObject`; a subresource (?tagging, ?retention, ...) is another API.
                    if ([...url.searchParams.keys()].some((k) => k !== 'x-id')) {
                        throw new AwsError(501, 'NotImplemented', 'the fake audit store answers PutObject only');
                    }
                    const raw = await readBody(req);
                    const chunked =
                        (header(req.headers, 'content-encoding') ?? '').includes('aws-chunked') ||
                        (header(req.headers, 'x-amz-content-sha256') ?? '').startsWith('STREAMING-');
                    const headers = store.putObject(key, chunked ? decodeAwsChunked(raw) : raw, req.headers);
                    res.writeHead(200, headers);
                    res.end();
                    return;
                }
                case 'GET':
                case 'HEAD': {
                    const v = store.getObject(key, url.searchParams.get('versionId'));
                    const headers: Record<string, string> = {
                        'content-type': v.contentType,
                        'content-length': String(v.body.length),
                        etag: etag(v.body),
                        'last-modified': v.lastModified.toUTCString(),
                        'x-amz-version-id': v.versionId,
                    };
                    if (v.lockMode && v.retainUntil) {
                        headers['x-amz-object-lock-mode'] = v.lockMode;
                        headers['x-amz-object-lock-retain-until-date'] = v.retainUntil.toISOString();
                    }
                    res.writeHead(200, headers);
                    res.end(req.method === 'GET' ? v.body : undefined);
                    return;
                }
                case 'DELETE':
                    store.deleteObject(key);
                    return;
                default:
                    throw new AwsError(405, 'MethodNotAllowed', `The specified method is not allowed against this resource: ${req.method}`);
            }
        };
        handle().catch((e: unknown) => fail(res, e));
    };
}
