import { Readable } from 'node:stream';
import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import { carriesMethod, readMcpBody } from './requestBody.js';

function request(method: string, body: string, headers: Record<string, string> = {}): http.IncomingMessage {
    const req = Readable.from([Buffer.from(body)]) as unknown as http.IncomingMessage;
    req.method = method;
    req.headers = headers;
    return req;
}

describe('readMcpBody', () => {
    it('parses a POST body as JSON', async () => {
        const body = await readMcpBody(request('POST', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'));
        expect(body).toEqual({ kind: 'read', parsed: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    });

    it('keeps a non-JSON body as text for the transport to reject', async () => {
        expect(await readMcpBody(request('POST', 'not json'))).toEqual({ kind: 'read', parsed: 'not json' });
    });

    it('leaves GET and DELETE to the transport', async () => {
        expect(await readMcpBody(request('GET', ''))).toEqual({ kind: 'none' });
        expect(await readMcpBody(request('DELETE', ''))).toEqual({ kind: 'none' });
    });

    it('refuses a body over the limit, declared or streamed', async () => {
        expect(await readMcpBody(request('POST', '{}', { 'content-length': '100' }), 10)).toEqual({ kind: 'tooLarge' });
        expect(await readMcpBody(request('POST', '"0123456789abcdef"'), 10)).toEqual({ kind: 'tooLarge' });
    });
});

describe('carriesMethod', () => {
    const methods = ['tools/list', 'tools/call'];
    it('finds a tool method in a single message or a batch', () => {
        expect(carriesMethod({ method: 'tools/call' }, methods)).toBe(true);
        expect(carriesMethod([{ method: 'ping' }, { method: 'tools/list' }], methods)).toBe(true);
    });
    it('ignores other methods and non-messages', () => {
        expect(carriesMethod({ method: 'initialize' }, methods)).toBe(false);
        expect(carriesMethod([{ method: 'ping' }, null, 'x'], methods)).toBe(false);
        expect(carriesMethod('tools/list', methods)).toBe(false);
    });
});
