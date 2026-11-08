import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANALYST, IDENTITY_SECRET, startHarness, type Harness } from './helpers/harness';
import type { HttpRecord } from './helpers/engine';
import { verifyIdentityToken } from './helpers/identity';

const STATEMENT = "UPDATE orders SET status = 'cancelled' WHERE id = 1 RETURNING id, status";

let h: Harness;
beforeAll(async () => {
    h = await startHarness({
        attributes: [
            { name: 'platform_read', users: [{ userUuid: ANALYST.userUuid, value: 'true' }] },
            { name: 'platform_write', users: [{ userUuid: ANALYST.userUuid, value: 'true' }] },
        ],
    });
    h.engine.onHttp('POST', '/v1/write', (req: HttpRecord) => {
        const body = req.body as { statement: string };
        if (body.statement.includes('preview_lies')) {
            return { status: 200, body: { audit_id: 'audit-test-2', rows_affected: 1, preview: false, returning: null } };
        }
        if (body.statement.includes('DROP')) {
            return { status: 400, body: { error: 'DDL is always blocked' } };
        }
        return {
            status: 200,
            body: { audit_id: 'audit-test-1', rows_affected: 1, preview: true, returning: [{ id: 1, status: 'cancelled' }] },
        };
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

const writes = () => h.engine.httpRequests.filter((r) => r.method === 'POST' && r.path === '/v1/write');

describe('write_preview (Preview only, through the engine POST /v1/write)', () => {
    it('sends mode "preview" with statement, description, ticket and a confirmation token', async () => {
        const r = await h.call('write_preview', {
            statement: STATEMENT,
            description: 'Preview cancelling a duplicate order for ENG-456',
            ticket: 'ENG-456',
        });
        expect(r.isError, r.text).toBe(false);
        const req = writes().at(-1)!;
        expect(req.body).toMatchObject({
            statement: STATEMENT,
            mode: 'preview',
            description: 'Preview cancelling a duplicate order for ENG-456',
            ticket: 'ENG-456',
        });
        expect(typeof (req.body as { confirmation_token: unknown }).confirmation_token).toBe('string');
        expect(((req.body as { confirmation_token: string }).confirmation_token ?? '').length).toBeGreaterThan(0);
    });

    it('authenticates with a §3 identity token (agent true, platform_write, source mcp)', () => {
        const auth = String(writes().at(-1)!.headers.authorization ?? '');
        expect(auth.startsWith('Bearer ')).toBe(true);
        const id = verifyIdentityToken(auth.slice(7), IDENTITY_SECRET);
        expect(id.iss).toBe('telemetry-mcp');
        expect(id.agent).toBe(true);
        expect(id.attrs.platform_write).toBe(true);
        expect(id.audit.source).toBe('mcp');
        expect(id.audit.description).toBe('Preview cancelling a duplicate order for ENG-456');
        expect(id.audit.ticket).toBe('ENG-456');
    });

    it('returns the engine result: audit id, rows affected, preview true, RETURNING rows', async () => {
        const r = await h.call('write_preview', { statement: STATEMENT, description: 'Preview again' });
        expect(r.structured).toEqual({
            audit_id: 'audit-test-1',
            rows_affected: 1,
            preview: true,
            returning: [{ id: 1, status: 'cancelled' }],
        });
        expect((writes().at(-1)!.body as { ticket: unknown }).ticket).toBeNull();
    });

    it('requires a description, before calling the engine', async () => {
        const before = writes().length;
        expect((await h.call('write_preview', { statement: STATEMENT })).isError).toBe(true);
        expect((await h.call('write_preview', { statement: STATEMENT, description: ' ' })).isError).toBe(true);
        expect(writes().length).toBe(before);
    });

    it('surfaces an engine rejection as a tool error', async () => {
        const r = await h.call('write_preview', { statement: 'DROP TABLE orders', description: 'should be blocked' });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/blocked|400/i);
    });

    it('treats an engine reply with preview != true as an error', async () => {
        const r = await h.call('write_preview', {
            statement: "UPDATE orders SET status = 'x' WHERE id = 2 -- preview_lies",
            description: 'Engine misbehaves',
        });
        expect(r.isError).toBe(true);
    });
});
