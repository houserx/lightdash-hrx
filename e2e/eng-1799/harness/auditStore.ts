/**
 * A fake audit store (Harness API `startFakeAuditStore`): DynamoDB and S3 on one fake server,
 * enough for the engine's `[audit]` writer. Every Audited Query writes a DynamoDB `PutItem`
 * (AWS JSON 1.0, `x-amz-target: DynamoDB_20120810.PutItem`) and then an S3 `PutObject`
 * (path-style `PUT /<bucket>/<key>`); both answer success.
 *
 * Minimal on purpose: feature int-harness-audit-store adds `items()`, `objects()`,
 * `setFailing()`, the `Query` operation over the portal GSIs and the failure case.
 */
import { type FakeReply, type FakeServer, startFakeServer } from './fakeServer';

/** The table and bucket names the harness renders into `[audit]`. */
export const AUDIT_TABLE = 'db-query-portal-executions';
export const AUDIT_BUCKET = 'db-query-portal-audit';

export type FakeAuditStore = FakeServer & {
    /** The `[audit] dynamodb_endpoint_url`. */
    dynamodbUrl: string;
    /** The `[audit] s3_endpoint_url` (the engine uses path-style addressing). */
    s3Url: string;
};

const DYNAMODB_JSON = 'application/x-amz-json-1.0';

const dynamoError = (type: string, message: string): FakeReply => ({
    status: 400,
    headers: { 'content-type': DYNAMODB_JSON, 'x-amzn-errortype': type },
    body: JSON.stringify({
        __type: `com.amazonaws.dynamodb.v20120810#${type}`,
        message,
    }),
});

export async function startFakeAuditStore(): Promise<FakeAuditStore> {
    const server = await startFakeServer((request): FakeReply => {
        const target = request.headers['x-amz-target'];
        if (target !== undefined) {
            const operation = target.split('.').pop();
            if (operation === 'PutItem') {
                return {
                    status: 200,
                    headers: { 'content-type': DYNAMODB_JSON },
                    body: '{}',
                };
            }
            return dynamoError(
                'UnknownOperationException',
                `fake audit store does not implement ${operation}`,
            );
        }
        if (request.method === 'PUT') {
            return {
                status: 200,
                headers: { etag: '"00000000000000000000000000000000"' },
                body: '',
            };
        }
        return {
            status: 400,
            headers: { 'content-type': 'application/xml' },
            body: '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NotImplemented</Code><Message>fake audit store answers PutObject only</Message></Error>',
        };
    });
    return { ...server, dynamodbUrl: server.url, s3Url: server.url };
}
