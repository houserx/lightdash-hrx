/**
 * Feature viz-registry-client-install: served over HTTP, the built
 * registry is read by the real ChartRegistryClient (the one
 * LIGHTDASH_CHART_REGISTRY_URL configures): index, per-version entries and
 * digest-checked artifact downloads, on both channels.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { DIST, REPO_ROOT, loadIndex, type Entry } from './harness';

const CONTENT_TYPES: Record<string, string> = {
    '.json': 'application/json',
    '.tar': 'application/x-tar',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
};

let server: Server;
let baseUrl: string;
const requests: string[] = [];

// The client's logger reads backend config at import; these are obviously
// fake values for a process that never serves anything.
Object.assign(process.env, {
    LIGHTDASH_SECRET: 'test-secret-not-real',
    SITE_URL: 'http://localhost:3000',
    PGCONNECTIONURI: 'postgres://user:test-secret-not-real@127.0.0.1:1/none',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_BUCKET: 'test-bucket-not-real',
    S3_REGION: 'us-east-1',
    LIGHTDASH_MODE: 'development',
});

const makeClient = async (channel: 'stable' | 'next') => {
    const { ChartRegistryClient } = await import(
        path.join(REPO_ROOT, 'packages/backend/src/ee/clients/ChartRegistryClient.ts')
    );
    return new ChartRegistryClient({
        lightdashConfig: {
            appRuntime: {
                chartRegistry: {
                    url: baseUrl,
                    allowInsecure: true,
                    allowPrivateHosts: true,
                    authorizationHeader: null,
                    channel,
                },
            },
        },
    });
};

beforeAll(async () => {
    server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        requests.push(url.pathname);
        const file = path.join(DIST, decodeURIComponent(url.pathname));
        if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, {
            'content-type':
                CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        });
        createReadStream(file).pipe(res);
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise((resolve) => {
        server.close(resolve);
    });
});

describe('ChartRegistryClient against the built registry', () => {
    const { index } = loadIndex();

    it('reads the index', async () => {
        const client = await makeClient('stable');
        const remote = await client.getIndex();
        expect(remote.charts.map((c: Entry) => c.slug).sort()).toEqual(
            index.charts.map((c: Entry) => c.slug).sort(),
        );
        expect(requests).toContain('/index.json');
    });

    it('resolves every published version and downloads its artifacts', async () => {
        const client = await makeClient('stable');
        for (const chart of index.charts) {
            // eslint-disable-next-line no-await-in-loop
            const entry = await client.getVersionEntry(chart.slug, chart.version);
            expect(entry, chart.slug).toBeDefined();
            expect(entry.vizSchema).toEqual(chart.vizSchema);
            // downloadArtifact throws on a digest mismatch
            // eslint-disable-next-line no-await-in-loop
            const source = await client.downloadArtifact(entry, 'source');
            // eslint-disable-next-line no-await-in-loop
            const dist = await client.downloadArtifact(entry, 'dist');
            expect(source.length).toBeGreaterThan(0);
            expect(dist.length).toBeGreaterThan(0);
        }
    });

    it('proxies each listed image as an allowed image type', async () => {
        const client = await makeClient('stable');
        for (const chart of index.charts) {
            for (const image of chart.screenshots ?? []) {
                // eslint-disable-next-line no-await-in-loop
                const asset = await client.getAsset(image);
                expect(asset, image).toBeDefined();
                expect(asset.contentType).toMatch(/^image\/(png|jpeg|webp|gif)$/);
            }
        }
    });

    it('serves the next channel too', async () => {
        const client = await makeClient('next');
        const remote = await client.getIndex();
        expect(remote.charts.length).toBe(index.charts.length);
        expect(requests).toContain('/index-next.json');
    });
});
