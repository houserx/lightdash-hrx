import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEngineAudit, parseAuditFilters } from './engineAudit';

describe('parseAuditFilters', () => {
    it('trims the filters and drops blank or missing ones', () => {
        expect(
            parseAuditFilters({
                ticket: ' ENG-1 ',
                user: '  ',
                month: '2026-01',
                cursor: undefined,
            }),
        ).toEqual({ ticket: 'ENG-1', month: '2026-01' });
        expect(parseAuditFilters({})).toEqual({});
    });

    it.each(['2026-13', '2026-00', '2026-1', '202611', 'November'])(
        'refuses the month %j',
        (month) => {
            expect(() => parseAuditFilters({ month })).toThrow(
                'month must be in the form YYYY-MM',
            );
        },
    );

    it('refuses a filter that is not a string', () => {
        expect(() =>
            parseAuditFilters({ ticket: ['a', 'b'] as unknown as string }),
        ).toThrow('ticket must be a string');
    });
});

describe('getEngineAudit', () => {
    let server: Server;
    let baseUrl: string;
    let reply: { status: number; body: string };
    let received: { method?: string; url?: string; authorization?: string };

    beforeAll(async () => {
        // The unit test setup stubs fetch; these tests talk to a real local server.
        vi.unstubAllGlobals();
        server = createServer((request, response) => {
            received = {
                method: request.method,
                url: request.url,
                authorization: request.headers.authorization,
            };
            response.writeHead(reply.status, {
                'content-type': 'application/json',
            });
            response.end(reply.body);
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

    it('gets the page with the encoded filters and the identity token', async () => {
        const page = { items: [], nextCursor: null };
        reply = { status: 200, body: JSON.stringify(page) };
        await expect(
            getEngineAudit(`${baseUrl}/`, 'identity', {
                user: 'a+b@example.com',
                cursor: 'c/1',
            }),
        ).resolves.toEqual(page);
        expect(received).toEqual({
            method: 'GET',
            url: '/v1/audit?user=a%2Bb%40example.com&cursor=c%2F1',
            authorization: 'Bearer identity',
        });
    });

    it('passes back an engine refusal and hides other failures', async () => {
        reply = { status: 403, body: '{"error":"platform_read required"}' };
        await expect(
            getEngineAudit(baseUrl, 'identity', {}),
        ).rejects.toMatchObject({
            statusCode: 403,
            message: 'platform_read required',
        });
        reply = { status: 503, body: 'unavailable' };
        await expect(
            getEngineAudit(baseUrl, 'identity', {}),
        ).rejects.toMatchObject({
            statusCode: 500,
            message: 'Federation Engine audit failed with status 503',
        });
    });
});
