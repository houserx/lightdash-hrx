/* eslint-disable */
// @ts-nocheck
// int-harness-platform-database: the harness runs a throwaway Postgres (in tmp/, 127.0.0.1, an
// ephemeral port, no unix socket) playing the Platform Database with engine read/write roles and
// synthetic widgets; the real engine's platform_query() reads it; stop() removes the server.
import * as net from 'node:net';
import { WIDGET_COUNT } from './fixtures';
import { disposeAll, harness, mintBackendToken, pgRun, setIdentity, track, waitFor } from './support';

afterAll(disposeAll);

const portOpen = (port: number) =>
    new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('error', () => resolve(false));
    });

describe('int-harness-platform-database', () => {
    it('serves synthetic widgets to platform_query() through the read role', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        expect(platform.port).toBeGreaterThan(1024);
        expect(platform.port).not.toBe(5432);
        expect(platform.readUrl).toContain(`127.0.0.1:${platform.port}`);
        expect(platform.readUrl).toContain('engine_read');
        expect(platform.writeUrl).toContain('engine_write');
        const seeded = await platform.query('SELECT count(*)::int AS n, min(id) AS lo, max(id) AS hi FROM public.widgets');
        expect(seeded[0]).toEqual({ n: WIDGET_COUNT, lo: 1, hi: WIDGET_COUNT });

        const engine = track(await h.startEngine({ platform }));
        const token = await mintBackendToken({ attrs: { platform_read: true }, audit: { description: 'e2e harness check', source: 'investigate' } });
        const result = await pgRun(engine, [setIdentity(token), `SELECT count(*) AS n FROM platform_query('SELECT id, name FROM widgets')`]);
        expect(result.error).toBeUndefined();
        expect(Number(result.rows[0].n)).toBe(WIDGET_COUNT);

        // The read role really is read-only.
        const write = await pgRun(engine, [setIdentity(token), `SELECT * FROM platform_query('WITH d AS (DELETE FROM widgets RETURNING id) SELECT * FROM d')`]);
        expect(write.error?.code).toBeDefined();
        expect((await platform.query('SELECT count(*)::int AS n FROM public.widgets'))[0].n).toBe(WIDGET_COUNT);

        await platform.stop();
        await waitFor('the Platform Database to stop', async () => !(await portOpen(platform.port)), 20_000);
    });
});
