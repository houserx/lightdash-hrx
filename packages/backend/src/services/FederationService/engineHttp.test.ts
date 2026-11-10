import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { redactIdentityToken, requestEngine } from './engineHttp';

const TOKEN =
    'aGVhZGVyLXBhcnQ.cGF5bG9hZC1wYXJ0LXdpdGgtY2xhaW1z.c2lnbmF0dXJlLXBhcnQ';
const [, PAYLOAD, SIGNATURE] = TOKEN.split('.');

describe('redactIdentityToken', () => {
    it('removes the whole token and each of its parts', () => {
        const text = `bad token ${TOKEN}; payload ${PAYLOAD}; sig ${SIGNATURE}`;
        const redacted = redactIdentityToken(text, TOKEN);
        expect(redacted).toBe(
            'bad token [redacted]; payload [redacted]; sig [redacted]',
        );
    });

    it('leaves text without the token as it is', () => {
        expect(redactIdentityToken('engine exploded', TOKEN)).toBe(
            'engine exploded',
        );
    });
});

describe('requestEngine', () => {
    let server: Server;
    let baseUrl: string;
    let reply: { status: number; body: string };

    beforeAll(async () => {
        // The unit test setup stubs fetch; these tests talk to a real local server.
        vi.unstubAllGlobals();
        server = createServer((_request, response) => {
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

    const call = () =>
        requestEngine({
            httpBaseUrl: baseUrl,
            identityToken: TOKEN,
            method: 'GET',
            path: '/v1/audit',
            timeoutMs: 5_000,
            label: 'audit',
        });

    it.each([403, 500])(
        'redacts a token the engine echoes in a %i error',
        async (status) => {
            reply = {
                status,
                body: JSON.stringify({
                    error: `invalid identity token ${TOKEN} (payload ${PAYLOAD})`,
                }),
            };
            const error = await call().catch((caught: Error) => caught);
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe(
                'invalid identity token [redacted] (payload [redacted])',
            );
            expect(JSON.stringify(error)).not.toContain(PAYLOAD);
        },
    );
});
