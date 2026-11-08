import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/harness';

let h: Harness;
beforeAll(async () => {
    // Default attributes: the analyst has platform_read but not platform_write.
    h = await startHarness();
    h.engine.onHttp('POST', '/v1/write', {
        status: 200,
        body: { audit_id: 'audit-x', rows_affected: 1, preview: true, returning: null },
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('write_preview needs the platform_write user attribute', () => {
    it('refuses a user without platform_write, without calling the engine', async () => {
        const r = await h.call('write_preview', {
            statement: "UPDATE orders SET status = 'x' WHERE id = 1",
            description: 'Should be refused',
        });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/platform_write/);
        expect(h.engine.httpRequests.filter((x) => x.path === '/v1/write')).toHaveLength(0);
    });
});
