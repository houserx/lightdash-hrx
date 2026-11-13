import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditBrowserError, auditPath, createEngineAuditBrowser } from './audit.js';

const TOKEN = 'eyJ2IjoxfQ.c2lnbmF0dXJlLW5vdC1yZWFs';

interface Seen {
    url: string;
    authorization: string | undefined;
}

let server: http.Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: string } = { status: 200, body: '{"items":[],"nextCursor":null}' };

beforeAll(async () => {
    server = http.createServer((req, res) => {
        seen.push({ url: req.url ?? '', authorization: req.headers.authorization });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    seen = [];
    reply = { status: 200, body: '{"items":[],"nextCursor":null}' };
});

const audits: unknown[] = [];
const session = {
    async identityToken(audit: unknown) {
        audits.push(audit);
        return TOKEN;
    },
};

describe('auditPath', () => {
    it('sends only the given §1.3 filters', () => {
        expect(auditPath()).toBe('/v1/audit');
        expect(auditPath({ month: '2026-11', cursor: 'a b' })).toBe('/v1/audit?month=2026-11&cursor=a+b');
        expect(auditPath({ ticket: 'ENG-1', user: 'u@example.test' })).toBe(
            '/v1/audit?ticket=ENG-1&user=u%40example.test',
        );
    });
});

describe('createEngineAuditBrowser', () => {
    it('calls GET /v1/audit with the caller identity token as a bearer and returns the page', async () => {
        reply = { status: 200, body: JSON.stringify({ items: [{ id: 'e1' }], nextCursor: 'c1' }) };
        const browser = createEngineAuditBrowser(baseUrl, session);

        const page = await browser.list({ cursor: 'c0' });

        expect(page).toEqual({ items: [{ id: 'e1' }], nextCursor: 'c1' });
        expect(seen).toEqual([{ url: '/v1/audit?cursor=c0', authorization: `Bearer ${TOKEN}` }]);
        expect(audits.at(-1)).toBeNull();
    });

    it('treats a missing or empty nextCursor as the last page', async () => {
        const browser = createEngineAuditBrowser(baseUrl, session);
        reply = { status: 200, body: '{"items":[]}' };
        expect((await browser.list()).nextCursor).toBeNull();
        reply = { status: 200, body: '{"items":[],"nextCursor":""}' };
        expect((await browser.list()).nextCursor).toBeNull();
    });

    it('names the status and engine message of a failed call, without the token or secrets', async () => {
        reply = {
            status: 403,
            body: JSON.stringify({ error: `access denied: platform_read missing for ${TOKEN} test-secret-not-real` }),
        };
        const browser = createEngineAuditBrowser(baseUrl, session, ['test-secret-not-real']);

        const err = await browser.list().catch((e: unknown) => e);

        expect(err).toBeInstanceOf(AuditBrowserError);
        const message = (err as Error).message;
        expect(message).toMatch(/HTTP 403: access denied: platform_read missing/);
        expect(message).not.toContain(TOKEN);
        expect(message).not.toContain('test-secret-not-real');
    });

    it('rejects a body that is not an audit page', async () => {
        reply = { status: 200, body: '{"executions":[]}' };
        await expect(createEngineAuditBrowser(baseUrl, session).list()).rejects.toThrow(/unexpected response/);
    });

    it('fails without a request when the caller cannot be identified', async () => {
        const browser = createEngineAuditBrowser(baseUrl, {
            identityToken: () => Promise.reject(new Error('user is not mapped')),
        });
        await expect(browser.list()).rejects.toThrow('user is not mapped');
        expect(seen).toHaveLength(0);
    });

    it('fails clearly when the engine cannot be reached', async () => {
        await expect(createEngineAuditBrowser('http://127.0.0.1:1', session).list()).rejects.toThrow(
            /could not reach the Federation Engine/,
        );
    });
});
