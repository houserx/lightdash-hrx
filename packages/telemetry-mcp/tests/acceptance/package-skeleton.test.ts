import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, PKG_DIR, read, REPO_ROOT } from './helpers/files';

async function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
    });
}

const DUMMY_ENV = {
    MCP_HOST: '127.0.0.1',
    MCP_PUBLIC_URL: 'https://telemetry-mcp.example.test',
    OKTA_ISSUER: 'http://127.0.0.1:9/oauth2/default',
    OKTA_AUDIENCE: 'api://telemetry-mcp-test',
    LIGHTDASH_URL: 'http://127.0.0.1:9',
    LIGHTDASH_API_TOKEN: 'test-service-token-not-real',
    LIGHTDASH_PROJECT_UUID: '5c0f8d2e-6b7a-4c1d-9e8f-0a1b2c3d4e5f',
    ENGINE_PG_HOST: '127.0.0.1',
    ENGINE_PG_USER: 'lightdash-operations',
    ENGINE_PG_PASSWORD: 'test-pg-password-not-real',
    ENGINE_HTTP_URL: 'http://127.0.0.1:9',
    HRX_IDENTITY_SECRET: 'test-identity-secret-not-real',
};

describe('package skeleton', () => {
    it('is the @lightdash/telemetry-mcp workspace package on the official MCP TypeScript SDK', () => {
        const pkg = JSON.parse(read('package.json')) as {
            name: string;
            dependencies?: Record<string, string>;
            scripts?: Record<string, string>;
        };
        expect(pkg.name).toBe('@lightdash/telemetry-mcp');
        expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBeTruthy();
        expect(pkg.dependencies?.pg).toBeTruthy();
        // Keep the dependency set small.
        expect(Object.keys(pkg.dependencies ?? {}).length).toBeLessThanOrEqual(8);
        expect(pkg.scripts?.build).toBeTruthy();
        expect(pkg.scripts?.test).toBeTruthy();
    });

    it('is recorded in the lockfile as a workspace importer', () => {
        const lock = read('pnpm-lock.yaml', REPO_ROOT);
        expect(lock).toMatch(/^ {2}packages\/telemetry-mcp:\s*$/m);
    });

    it('builds to dist/main.js, which starts from env and answers /healthz without auth', async () => {
        expect(exists('dist/main.js')).toBe(true);
        const port = await freePort();
        const child = spawn(process.execPath, [path.join(PKG_DIR, 'dist/main.js')], {
            env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...DUMMY_ENV, MCP_PORT: String(port) },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (c: Buffer) => {
            stderr += c.toString();
        });
        try {
            let status = 0;
            let body: unknown = null;
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline) {
                try {
                    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
                    status = res.status;
                    body = await res.json();
                    break;
                } catch {
                    await new Promise((r) => setTimeout(r, 200));
                }
            }
            expect(status, `server did not answer /healthz; stderr: ${stderr.slice(-500)}`).toBe(200);
            expect(body).toMatchObject({ status: 'ok' });
        } finally {
            child.kill('SIGTERM');
        }
    }, 30_000);
});
