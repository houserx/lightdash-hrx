// ENG-1799 demo: an in-memory S3-compatible fake for Lightdash's results and exports storage (S3_* and
// RESULTS_S3_* point here). Served by the telemetry-fakes process on an ephemeral 127.0.0.1 port. Never MinIO
// or Docker; nothing leaves the machine.
//
// Path-style requests only (`/<bucket>/<key>`), any bucket, no signature check (presigned-URL query parameters
// are ignored):
//   PUT    /<bucket>/<key>                               PutObject (aws-chunked bodies decoded); 200 + ETag
//   GET    /<bucket>/<key>                               GetObject (a single `Range: bytes=a-b` honoured); 404 NoSuchKey
//   HEAD   /<bucket>/<key>                               HeadObject; 404
//   DELETE /<bucket>/<key>                               DeleteObject; 204 (also for a missing key, as S3)
//   POST   /<bucket>/<key>?uploads                       CreateMultipartUpload  (lib-storage's Upload uses
//   PUT    /<bucket>/<key>?partNumber=N&uploadId=U       UploadPart              these for bodies over one part)
//   POST   /<bucket>/<key>?uploadId=U                    CompleteMultipartUpload
//   DELETE /<bucket>/<key>?uploadId=U                    AbortMultipartUpload
//   GET    /<bucket>?list-type=2                         ListObjectsV2 (`prefix`, `max-keys`, `continuation-token`)
//   HEAD   /<bucket>                                     HeadBucket (every bucket exists)
//   GET    /ready                                        200 (up.sh's readiness probe)
// Anything else answers 501 NotImplemented, so a new need shows up clearly instead of silently misbehaving.
// Objects live as long as the process (down.sh discards them). Nothing here logs object contents.
import { createHash, randomUUID } from 'node:crypto';
import type http from 'node:http';
import { decodeAwsChunked } from './audit-store.js';

/** The bucket up.sh points Lightdash at (any bucket works). */
export const RESULTS_BUCKET = 'demo-lightdash-results';

const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
/** Query parameters of presigned URLs and of the SDK (`x-id`), not sub-resources. */
const IGNORED_PARAMS = /^(x-id|X-Amz-.*)$/i;

type S3Object = { body: Buffer; contentType: string; etag: string; lastModified: Date };
type Upload = { bucket: string; key: string; contentType: string; parts: Map<number, Buffer> };

export class ResultsStore {
    readonly objects = new Map<string, S3Object>();
    readonly uploads = new Map<string, Upload>();
}

const id = (bucket: string, key: string) => `${bucket}\u0000${key}`;
const md5 = (body: Buffer) => createHash('md5').update(body).digest('hex');

const escapeXml = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function sendXml(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
}

function s3Error(res: http.ServerResponse, status: number, code: string, message: string): void {
    sendXml(res, status, `<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_OBJECT_BYTES) throw new Error('object too large for the demo fake');
        chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks);
    const encoding = String(req.headers['content-encoding'] ?? '');
    const sha = String(req.headers['x-amz-content-sha256'] ?? '');
    return encoding.includes('aws-chunked') || sha.startsWith('STREAMING-') ? decodeAwsChunked(raw) : raw;
}

function listObjects(res: http.ServerResponse, store: ResultsStore, bucket: string, params: URLSearchParams): void {
    const prefix = params.get('prefix') ?? '';
    const maxKeys = Math.max(0, Math.min(1000, Number(params.get('max-keys') ?? 1000) || 0));
    const token = params.get('continuation-token');
    const after = token ? Buffer.from(token, 'base64url').toString('utf8') : (params.get('start-after') ?? '');
    const matching = [...store.objects.entries()]
        .map(([k, o]) => {
            const [bucketOf, key] = k.split('\u0000');
            return { bucketOf, key, o };
        })
        .filter((e) => e.bucketOf === bucket && e.key.startsWith(prefix) && e.key > after)
        .sort((a, b) => (a.key < b.key ? -1 : 1));
    const page = matching.slice(0, maxKeys);
    const truncated = matching.length > page.length;
    const contents = page
        .map(
            ({ key, o }) =>
                `<Contents><Key>${escapeXml(key)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified>` +
                `<ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
        )
        .join('');
    const next =
        truncated && page.length
            ? `<NextContinuationToken>${Buffer.from(page[page.length - 1].key).toString('base64url')}</NextContinuationToken>`
            : '';
    sendXml(
        res,
        200,
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${escapeXml(bucket)}</Name>` +
            `<Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
            `<IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`,
    );
}

function sendObject(req: http.IncomingMessage, res: http.ServerResponse, o: S3Object): void {
    const headers: http.OutgoingHttpHeaders = {
        'content-type': o.contentType,
        etag: `"${o.etag}"`,
        'last-modified': o.lastModified.toUTCString(),
        'accept-ranges': 'bytes',
    };
    let body = o.body;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2]) && o.body.length > 0) {
        const size = o.body.length;
        let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        let end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (start >= size) {
            s3Error(res, 416, 'InvalidRange', 'The requested range is not satisfiable');
            return;
        }
        start = Math.max(0, start);
        end = Math.max(start, end);
        body = o.body.subarray(start, end + 1);
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = String(body.length);
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
}

async function handle(store: ResultsStore, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (url.pathname === '/ready' && (method === 'GET' || method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(method === 'HEAD' ? undefined : 'ready\n');
        return;
    }
    const [, bucket = '', ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    if (!bucket) {
        s3Error(res, 501, 'NotImplemented', 'ListBuckets is not faked');
        return;
    }
    const params = url.searchParams;

    if (!key) {
        if (method === 'GET' && params.get('list-type') === '2') {
            listObjects(res, store, bucket, params);
        } else if (method === 'HEAD') {
            res.writeHead(200);
            res.end();
        } else {
            s3Error(res, 501, 'NotImplemented', `${method} on a bucket is not faked`);
        }
        return;
    }

    const uploadId = params.get('uploadId');
    if (params.has('uploads') && method === 'POST') {
        const newId = randomUUID();
        store.uploads.set(newId, {
            bucket,
            key,
            contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
            parts: new Map(),
        });
        sendXml(
            res,
            200,
            `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${escapeXml(bucket)}</Bucket>` +
                `<Key>${escapeXml(key)}</Key><UploadId>${newId}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
    }
    if (uploadId !== null) {
        const upload = store.uploads.get(uploadId);
        if (!upload || upload.bucket !== bucket || upload.key !== key) {
            s3Error(res, 404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
            return;
        }
        if (method === 'PUT' && params.has('partNumber')) {
            const part = Number(params.get('partNumber'));
            if (!Number.isInteger(part) || part < 1 || part > 10000) {
                s3Error(res, 400, 'InvalidArgument', 'partNumber must be 1..10000');
                return;
            }
            const body = await readBody(req);
            upload.parts.set(part, body);
            res.writeHead(200, { etag: `"${md5(body)}"` });
            res.end();
            return;
        }
        if (method === 'POST') {
            await readBody(req); // the part list; every uploaded part is used, in part-number order
            const body = Buffer.concat([...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b));
            const etag = `${md5(body)}-${upload.parts.size}`;
            store.objects.delete(id(bucket, key));
            store.objects.set(id(bucket, key), { body, contentType: upload.contentType, etag, lastModified: new Date() });
            store.uploads.delete(uploadId);
            sendXml(
                res,
                200,
                `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${escapeXml(bucket)}</Bucket>` +
                    `<Key>${escapeXml(key)}</Key><ETag>&quot;${etag}&quot;</ETag></CompleteMultipartUploadResult>`,
            );
            return;
        }
        if (method === 'DELETE') {
            store.uploads.delete(uploadId);
            res.writeHead(204);
            res.end();
            return;
        }
        s3Error(res, 501, 'NotImplemented', `${method} on a multipart upload is not faked`);
        return;
    }

    const subresources = [...params.keys()].filter((name) => !IGNORED_PARAMS.test(name));
    if (subresources.length > 0) {
        s3Error(res, 501, 'NotImplemented', `${method} /${bucket}/<key>?${subresources.join('&')} is not faked`);
        return;
    }

    const object = store.objects.get(id(bucket, key));
    switch (method) {
        case 'PUT': {
            const body = await readBody(req);
            const etag = md5(body);
            store.objects.delete(id(bucket, key));
            store.objects.set(id(bucket, key), {
                body,
                contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
                etag,
                lastModified: new Date(),
            });
            res.writeHead(200, { etag: `"${etag}"` });
            res.end();
            return;
        }
        case 'GET':
        case 'HEAD':
            if (!object) {
                if (method === 'HEAD') {
                    res.writeHead(404);
                    res.end();
                } else {
                    s3Error(res, 404, 'NoSuchKey', 'The specified key does not exist.');
                }
                return;
            }
            sendObject(req, res, object);
            return;
        case 'DELETE':
            store.objects.delete(id(bucket, key));
            res.writeHead(204);
            res.end();
            return;
        default:
            s3Error(res, 501, 'NotImplemented', `${method} on an object is not faked`);
    }
}

export function resultsS3Handler(store: ResultsStore): http.RequestListener {
    return (req, res) => {
        handle(store, req, res).catch((e: unknown) => {
            if (!res.headersSent) s3Error(res, 400, 'InvalidRequest', e instanceof Error ? e.message : String(e));
            else res.destroy();
        });
    };
}
