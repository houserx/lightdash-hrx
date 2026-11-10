import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseWriteRequest, postEngineWrite } from './engineWrite';

const valid = {
    statement: 'UPDATE t SET a = 1 ',
    mode: 'preview',
    confirmationToken: 'token',
    description: ' Fix a row ',
};

describe('parseWriteRequest', () => {
    it('keeps the statement as sent and trims description and ticket', () => {
        expect(parseWriteRequest({ ...valid, ticket: ' ENG-1 ' })).toEqual({
            statement: 'UPDATE t SET a = 1 ',
            mode: 'preview',
            confirmationToken: 'token',
            description: 'Fix a row',
            ticket: 'ENG-1',
        });
    });

    it('accepts commit mode', () => {
        expect(parseWriteRequest({ ...valid, mode: 'commit' }).mode).toBe(
            'commit',
        );
    });

    it('turns a missing or blank ticket into null', () => {
        expect(parseWriteRequest(valid).ticket).toBeNull();
        expect(parseWriteRequest({ ...valid, ticket: '  ' }).ticket).toBeNull();
    });

    it('refuses a missing description before anything else', () => {
        expect(() => parseWriteRequest({ description: ' ' })).toThrow(
            'A description is required for Write Mode',
        );
        expect(() => parseWriteRequest(undefined)).toThrow(
            'A description is required for Write Mode',
        );
    });

    it.each([
        [{ statement: ' ' }, 'A statement is required'],
        [{ mode: 'force' }, 'mode must be "preview" or "commit"'],
        [{ confirmationToken: '' }, 'A confirmation token is required'],
        [{ ticket: 42 }, 'ticket must be a string'],
    ])('refuses %j', (override, message) => {
        expect(() => parseWriteRequest({ ...valid, ...override })).toThrow(
            message,
        );
    });
});

describe('postEngineWrite', () => {
    let server: Server;
    let baseUrl: string;
    let reply: { status: number; body: string };
    let received: { url?: string; authorization?: string; body: string };

    beforeAll(async () => {
        // The unit test setup stubs fetch; these tests talk to a real local server.
        vi.unstubAllGlobals();
        server = createServer((request, response) => {
            let body = '';
            request.on('data', (chunk) => {
                body += chunk;
            });
            request.on('end', () => {
                received = {
                    url: request.url,
                    authorization: request.headers.authorization,
                    body,
                };
                response.writeHead(reply.status, {
                    'content-type': 'application/json',
                });
                response.end(reply.body);
            });
        });
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    });

    it('posts the payload with the identity token and returns the result', async () => {
        const result = {
            audit_id: 'a',
            rows_affected: 1,
            preview: true,
            returning: [],
        };
        reply = { status: 200, body: JSON.stringify(result) };
        await expect(
            postEngineWrite(`${baseUrl}/`, 'identity', { mode: 'preview' }),
        ).resolves.toEqual(result);
        expect(received).toEqual({
            url: '/v1/write',
            authorization: 'Bearer identity',
            body: '{"mode":"preview"}',
        });
    });

    it('passes back an engine refusal with its status and message', async () => {
        reply = { status: 403, body: '{"error":"DDL is always blocked"}' };
        await expect(
            postEngineWrite(baseUrl, 'identity', {}),
        ).rejects.toMatchObject({
            statusCode: 403,
            message: 'DDL is always blocked',
        });
    });

    it('treats an engine 5xx or a non-JSON result as a server error', async () => {
        reply = { status: 502, body: 'bad gateway' };
        await expect(
            postEngineWrite(baseUrl, 'identity', {}),
        ).rejects.toMatchObject({
            statusCode: 500,
            message: 'Federation Engine write failed with status 502',
        });
        reply = { status: 200, body: 'not json' };
        await expect(
            postEngineWrite(baseUrl, 'identity', {}),
        ).rejects.toMatchObject({ statusCode: 500 });
    });
});
