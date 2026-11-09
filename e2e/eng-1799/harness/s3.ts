/**
 * A small in-process fake S3 for Lightdash's results and exports storage (`startLightdash`
 * points S3_* and RESULTS_S3_* at it). Never MinIO or Docker.
 *
 * Path-style requests only (`/<bucket>/<key>`), any bucket, no signature check:
 *   PUT    /<bucket>/<key>                PutObject (aws-chunked bodies decoded); 200 + ETag
 *   GET    /<bucket>/<key>                GetObject; 404 NoSuchKey
 *   HEAD   /<bucket>/<key>                HeadObject; 404
 *   DELETE /<bucket>/<key>                DeleteObject; 204 (also for a missing key, as S3)
 *   GET    /<bucket>?list-type=2          ListObjectsV2 (`prefix`, `max-keys`, `continuation-token`)
 * Anything else (multipart uploads, ACLs, …) answers 501 NotImplemented, so a new need shows up
 * clearly instead of silently misbehaving.
 */
import * as crypto from 'node:crypto';
import { decodeAwsChunked } from './auditStore';
import { startFakeServer, type FakeReply, type FakeServer } from './fakeServer';

export type FakeS3Object = {
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
    etag: string;
    lastModified: Date;
};

export type FakeS3 = FakeServer & {
    /** Stored objects, oldest first. */
    objects(): FakeS3Object[];
};

const xml = (body: string, status = 200): FakeReply => ({
    status,
    headers: { 'content-type': 'application/xml' },
    body: `<?xml version="1.0" encoding="UTF-8"?>\n${body}`,
});

const escapeXml = (value: string) =>
    value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');

const s3Error = (status: number, code: string, message: string) =>
    xml(
        `<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`,
        status,
    );

export async function startFakeS3(): Promise<FakeS3> {
    const store = new Map<string, FakeS3Object>();
    const id = (bucket: string, key: string) => `${bucket}\u0000${key}`;

    const server = await startFakeServer((request, _res, rawBody) => {
        const [, bucket = '', ...rest] = request.path.split('/');
        const key = decodeURIComponent(rest.join('/'));
        if (!bucket) {
            return s3Error(501, 'NotImplemented', 'ListBuckets is not faked');
        }

        if (!key) {
            if (
                request.method === 'GET' &&
                request.params['list-type'] === '2'
            ) {
                const prefix = request.params.prefix ?? '';
                const maxKeys = Number(request.params['max-keys'] ?? 1000);
                const after = request.params['continuation-token']
                    ? Buffer.from(
                          request.params['continuation-token'],
                          'base64url',
                      ).toString('utf8')
                    : (request.params['start-after'] ?? '');
                const matching = [...store.values()]
                    .filter(
                        (o) =>
                            o.bucket === bucket &&
                            o.key.startsWith(prefix) &&
                            o.key > after,
                    )
                    .sort((a, b) => (a.key < b.key ? -1 : 1));
                const page = matching.slice(0, maxKeys);
                const truncated = matching.length > page.length;
                const contents = page
                    .map(
                        (o) =>
                            `<Contents><Key>${escapeXml(o.key)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
                    )
                    .join('');
                const next =
                    truncated && page.length
                        ? `<NextContinuationToken>${Buffer.from(page[page.length - 1].key).toString('base64url')}</NextContinuationToken>`
                        : '';
                return xml(
                    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${escapeXml(bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`,
                );
            }
            return s3Error(
                501,
                'NotImplemented',
                `${request.method} on a bucket is not faked`,
            );
        }

        // The SDK adds `?x-id=<Operation>`; other sub-resources are not faked.
        const subresources = Object.keys(request.params).filter(
            (name) => name !== 'x-id',
        );
        if (subresources.length > 0) {
            return s3Error(
                501,
                'NotImplemented',
                `${request.method} /${bucket}/${key}?${subresources.join('&')} is not faked`,
            );
        }

        const object = store.get(id(bucket, key));
        switch (request.method) {
            case 'PUT': {
                const chunked =
                    (request.headers['content-encoding'] ?? '').includes(
                        'aws-chunked',
                    ) ||
                    (request.headers['x-amz-content-sha256'] ?? '').startsWith(
                        'STREAMING-',
                    );
                const body = chunked ? decodeAwsChunked(rawBody) : rawBody;
                const etag = crypto
                    .createHash('md5')
                    .update(body)
                    .digest('hex');
                store.delete(id(bucket, key));
                store.set(id(bucket, key), {
                    bucket,
                    key,
                    body,
                    contentType:
                        request.headers['content-type'] ??
                        'application/octet-stream',
                    etag,
                    lastModified: new Date(),
                });
                return { status: 200, headers: { etag: `"${etag}"` } };
            }
            case 'GET':
            case 'HEAD': {
                if (!object) {
                    return request.method === 'HEAD'
                        ? { status: 404 }
                        : s3Error(
                              404,
                              'NoSuchKey',
                              'The specified key does not exist.',
                          );
                }
                return {
                    status: 200,
                    headers: {
                        'content-type': object.contentType,
                        'content-length': String(object.body.length),
                        etag: `"${object.etag}"`,
                        'last-modified': object.lastModified.toUTCString(),
                    },
                    body: request.method === 'HEAD' ? undefined : object.body,
                };
            }
            case 'DELETE':
                store.delete(id(bucket, key));
                return { status: 204 };
            default:
                return s3Error(
                    501,
                    'NotImplemented',
                    `${request.method} on an object is not faked`,
                );
        }
    });

    return {
        ...server,
        objects: () => [...store.values()],
    };
}
