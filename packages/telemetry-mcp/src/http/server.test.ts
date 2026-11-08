import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startServer, type RunningServer } from './server.js';

describe('http server', () => {
    let server: RunningServer | undefined;
    afterEach(async () => {
        await server?.close();
        server = undefined;
    });

    it('answers /healthz without auth', async () => {
        server = await startServer({ config: loadConfig({ MCP_HOST: '127.0.0.1', MCP_PORT: '0' }) });
        const res = await fetch(`${server.url}/healthz`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('returns 404 for unknown paths', async () => {
        server = await startServer({ config: loadConfig({ MCP_HOST: '127.0.0.1', MCP_PORT: '0' }) });
        const res = await fetch(`${server.url}/nope`);
        expect(res.status).toBe(404);
    });
});

describe('loadConfig (listen address)', () => {
    it('defaults to 0.0.0.0:8080', () => {
        expect(loadConfig({})).toEqual({ host: '0.0.0.0', port: 8080 });
    });

    it('rejects a bad port and names MCP_PORT', () => {
        expect(() => loadConfig({ MCP_PORT: 'abc' })).toThrow(/MCP_PORT/);
    });
});
