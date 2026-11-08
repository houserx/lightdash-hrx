import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintIdentityToken } from '../identity/token.js';
import { EngineWriteError, createEngineWriter } from './write.js';

const SECRET = 'test-secret-not-real';
const NOW_MS = 1_800_000_000_000;
const STATEMENT = "UPDATE orders SET status = 'x' WHERE id = 1 RETURNING id";

interface Seen {
    method: string;
    url: string;
    authorization: string | undefined;
    body: Record<string, unknown>;
}

let server: http.Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: string };
const OK = '{"audit_id":"a-1","rows_affected":1,"preview":true,"returning":[{"id":1}]}';

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
        req.on('end', () => {
            seen.push({
                method: req.method ?? '',
                url: req.url ?? '',
                authorization: req.headers.authorization,
                body: JSON.parse(raw) as Record<string, unknown>,
            });
            res.writeHead(reply.status, { 'content-type': 'application/json' });
            res.end(reply.body);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    seen = [];
    reply = { status: 200, body: OK };
});

const audits: unknown[] = [];
const minted: string[] = [];
const session = {
    statementTimeoutMs: 1_000,
    async identityToken(audit: { description?: string | null; ticket?: string | null } | null) {
        audits.push(audit);
        const token = mintIdentityToken({
            secret: SECRET,
            sub: 'user-uuid-1',
            email: 'analyst@example.test',
            org: 'org-uuid-1',
            project: 'project-uuid-1',
            attrs: { telemetry_restricted: false, platform_read: true, platform_write: true, platform_explain: false },
            audit,
            nowSeconds: NOW_MS / 1000,
        });
        minted.push(token);
        return token;
    },
};

const writer = () => createEngineWriter({ httpUrl: baseUrl, session, identitySecret: SECRET, now: () => NOW_MS });
const request = { statement: STATEMENT, description: 'Why', ticket: 'ENG-1' };

describe('createEngineWriter', () => {
    it('POSTs /v1/write with mode preview, the audit block in the identity token and a confirmation token', async () => {
        const result = await writer().preview(request);
        expect(result).toEqual({ audit_id: 'a-1', rows_affected: 1, preview: true, returning: [{ id: 1 }] });
        expect(seen).toHaveLength(1);
        expect(seen[0].method).toBe('POST');
        expect(seen[0].url).toBe('/v1/write');
        expect(seen[0].authorization).toBe(`Bearer ${minted.at(-1)}`);
        expect(audits.at(-1)).toEqual({ description: 'Why', ticket: 'ENG-1' });
        const { confirmation_token: confirmation, ...rest } = seen[0].body;
        expect(rest).toEqual({ statement: STATEMENT, mode: 'preview', description: 'Why', ticket: 'ENG-1' });

        const [payloadB64, signature] = String(confirmation).split('.');
        expect(signature).toBe(crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64url'));
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        expect(Object.keys(payload)).toEqual(['v', 'stmt_sha256', 'sub', 'project', 'exp', 'nonce']);
        expect(payload).toMatchObject({
            v: 1,
            stmt_sha256: crypto.createHash('sha256').update(STATEMENT).digest('hex'),
            sub: 'user-uuid-1',
            project: 'project-uuid-1',
            exp: NOW_MS / 1000 + 60,
        });
    });

    it('sends ticket null and returns returning null as given', async () => {
        reply = { status: 200, body: '{"audit_id":"a-2","rows_affected":0,"preview":true,"returning":null}' };
        const result = await writer().preview({ ...request, ticket: null });
        expect(seen[0].body.ticket).toBeNull();
        expect(result.returning).toBeNull();
    });

    it('turns a non-2xx reply into an error naming the status and engine message, without tokens', async () => {
        reply = { status: 403, body: JSON.stringify({ error: `missing platform_write ${'eyJhbGciOi.abc.def'}` }) };
        const err = await writer().preview(request).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EngineWriteError);
        expect((err as Error).message).toMatch(/HTTP 403: missing platform_write \[redacted\]/);
        expect((err as Error).message).not.toContain(minted.at(-1));
    });

    it.each([
        ['preview false', '{"audit_id":"a","rows_affected":1,"preview":false,"returning":null}'],
        ['preview missing', '{"audit_id":"a","rows_affected":1,"returning":null}'],
        ['a non-JSON body', 'ok'],
    ])('refuses a reply with %s', async (_label, body) => {
        reply = { status: 200, body };
        await expect(writer().preview(request)).rejects.toThrow(/did not confirm the statement ran as a Preview/);
    });

    it('refuses a Preview reply of an unexpected shape', async () => {
        reply = { status: 200, body: '{"audit_id":"a","rows_affected":"1","preview":true,"returning":null}' };
        await expect(writer().preview(request)).rejects.toThrow(/unexpected response/);
    });

    it('reports an unreachable engine without its address', async () => {
        const w = createEngineWriter({
            httpUrl: 'http://127.0.0.1:1',
            session,
            identitySecret: SECRET,
            now: () => NOW_MS,
        });
        await expect(w.preview(request)).rejects.toThrow('The Preview failed: could not reach the Federation Engine');
    });

    it('fails before any HTTP call when the caller cannot be identified', async () => {
        const w = createEngineWriter({
            httpUrl: baseUrl,
            session: { statementTimeoutMs: 1_000, identityToken: () => Promise.reject(new Error('no user')) },
            identitySecret: SECRET,
            now: () => NOW_MS,
        });
        await expect(w.preview(request)).rejects.toThrow(EngineWriteError);
        expect(seen).toHaveLength(0);
    });
});
