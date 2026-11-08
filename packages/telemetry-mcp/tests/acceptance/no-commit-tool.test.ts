import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANALYST, startHarness, type Harness } from './helpers/harness';
import type { HttpRecord } from './helpers/engine';
import { installPlatformCatalog } from './helpers/platform';

let h: Harness;
beforeAll(async () => {
    h = await startHarness({
        attributes: [
            { name: 'platform_read', users: [{ userUuid: ANALYST.userUuid, value: 'true' }] },
            { name: 'platform_write', users: [{ userUuid: ANALYST.userUuid, value: 'true' }] },
        ],
    });
    installPlatformCatalog(h.engine);
    h.engine.onHttp('POST', '/v1/write', (req: HttpRecord) => ({
        status: 200,
        body: {
            audit_id: 'audit-y',
            rows_affected: 1,
            preview: (req.body as { mode: string }).mode === 'preview',
            returning: null,
        },
    }));
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('no tool can commit a write', () => {
    it('exposes no commit/execute/write tool other than write_preview', async () => {
        const names = (await h.listTools()).map((t) => t.name);
        expect(names).toContain('write_preview');
        for (const n of names) {
            if (n === 'write_preview') continue;
            expect(n).not.toMatch(/commit|write|execute|mutate|update|delete|insert/i);
        }
    });

    it('gives write_preview no mode or commit argument', async () => {
        const tool = (await h.listTools()).find((t) => t.name === 'write_preview');
        const props = Object.keys(tool.inputSchema.properties ?? {});
        expect(props).not.toContain('mode');
        expect(props.some((p) => /commit|confirm/i.test(p))).toBe(false);
    });

    it('never sends mode "commit" to the engine, whatever arguments any tool is given', async () => {
        const smuggle = { mode: 'commit', commit: true, confirm: true };
        const tools = (await h.listTools()).map((t) => t.name);
        for (const name of tools) {
            await h.call(name, {
                statement: "UPDATE orders SET status = 'x' WHERE id = 1",
                sql: "UPDATE orders SET status = 'x' WHERE id = 1",
                description: 'Attempt to smuggle a commit',
                question: 'Please commit this update',
                ...smuggle,
            });
        }
        const writeCalls = h.engine.httpRequests.filter((r) => r.path === '/v1/write');
        for (const w of writeCalls) expect((w.body as { mode: string }).mode).toBe('preview');
    });
});
