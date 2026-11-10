/* eslint-disable */
// @ts-nocheck
// int-harness-engine: the e2e harness starts the real Federation Engine binary (built by cargo into
// tmp/cargo-target) on ephemeral 127.0.0.1 ports, a pg-wire login works, and stop() leaves no process.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { disposeAll, EXPECTED_ENGINE_BINARY, harness, isAlive, pgRun, REPO_ROOT, track, waitFor } from './support';

afterAll(disposeAll);

const cargoVersion = () => /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(REPO_ROOT, 'federation-engine/Cargo.toml'), 'utf8'))![1];

const portOpen = (port: number) =>
    new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('error', () => resolve(false));
    });

describe('int-harness-engine', () => {
    it('runs the real engine binary from tmp/cargo-target on ephemeral ports and stops it cleanly', async () => {
        const h = await harness();
        expect(path.resolve(h.ENGINE_BINARY)).toBe(EXPECTED_ENGINE_BINARY);
        expect(fs.existsSync(EXPECTED_ENGINE_BINARY)).toBe(true);

        const engine = track(await h.startEngine({}));
        expect(engine.binary).toBe(EXPECTED_ENGINE_BINARY);
        expect(engine.host).toBe('127.0.0.1');
        expect(engine.pgPort).toBeGreaterThan(1024);
        expect(engine.pgPort).not.toBe(5433);
        expect(engine.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(engine.httpUrl).not.toMatch(/:8088$/);
        expect(engine.user).toBe('lightdash-operations');
        expect(engine.database).toBe('operations');
        expect(isAlive(engine.pid)).toBe(true);
        // The config the harness wrote is the one the process runs.
        expect(engine.configToml).toContain(`listen_pg = "127.0.0.1:${engine.pgPort}"`);

        const version = await pgRun(engine, ['SELECT version() AS v']);
        expect(version.error).toBeUndefined();
        expect(version.rows[0].v).toBe(`PostgreSQL 16.0 (hrx-federation-engine ${cargoVersion()})`);

        const health = await fetch(`${engine.httpUrl}/healthz`);
        expect([200, 503]).toContain(health.status);

        const wrong = await pgRun({ ...engine, password: 'wrong-password-not-real' }, ['SELECT 1']);
        expect(wrong.error?.code).toBe('28P01');

        await engine.stop();
        await waitFor('engine process to exit', async () => !isAlive(engine.pid), 15_000);
        expect(await portOpen(engine.pgPort)).toBe(false);
    });

    it('two engines run side by side on different ports', async () => {
        const h = await harness();
        const a = track(await h.startEngine({}));
        const b = track(await h.startEngine({}));
        expect(a.pgPort).not.toBe(b.pgPort);
        expect(Number((await pgRun(a, ['SELECT 1 AS one'])).rows[0].one)).toBe(1);
        expect(Number((await pgRun(b, ['SELECT 2 AS two'])).rows[0].two)).toBe(2);
    });
});
