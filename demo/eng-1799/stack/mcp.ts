// ENG-1799 demo: write telemetry-mcp's environment under .state (run by up.sh after the seed, before it starts
// packages/telemetry-mcp/dist/main.js).
//
//   node --import tsx stack/mcp.ts --dir <.state/mcp> --engine-file <.state/run/engine-config.json> \
//       --fakes-file <.state/run/telemetry-fakes.json> --seed-file <.state/run/seed.json> \
//       --lightdash-url <url> --ready-file <.state/run/mcp.json>
//
// Picks a free 127.0.0.1 port and writes into --dir:
//   mcp.env   the server's whole environment (mode 0600): the fake Okta issuer and audience, Lightdash (the URL, the
//             Operations Project and the seed's personal access token as the service-account token), the engine's
//             pg-wire login `telemetry-mcp` and HTTP port, the shared hrx.identity secret and MCP_SOURCES;
//   home/     its HOME and TMPDIR.
// and the ready file: {"mcp": {"url"}} (the MCP endpoint is <url>/mcp, health <url>/healthz).
// No ANTHROPIC_API_KEY: the demo has no credentials, so ask_data reports that AI is not configured.
// Every secret here is a demo value (`...-not-real`) or the throwaway Lightdash's own token.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { OKTA_AUDIENCE } from './okta.js';

const HOST = '127.0.0.1';

const { values: args } = parseArgs({
    options: {
        dir: { type: 'string' },
        'engine-file': { type: 'string' },
        'fakes-file': { type: 'string' },
        'seed-file': { type: 'string' },
        'lightdash-url': { type: 'string' },
        'ready-file': { type: 'string' },
    },
});

type EngineFile = {
    engine: { host: string; pgPort: number; httpUrl: string; database: string; identitySecret: string };
    telemetryMcp: { user: string; password: string; sources: unknown[] };
};

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, HOST, () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
    });
}

const readJson = <T>(file: string) => JSON.parse(readFileSync(file, 'utf8')) as T;

async function main(): Promise<void> {
    const { dir, 'engine-file': engineFile, 'fakes-file': fakesFile, 'seed-file': seedFile } = args;
    const { 'lightdash-url': lightdashUrl, 'ready-file': readyFile } = args;
    if (!dir || !engineFile || !fakesFile || !seedFile || !lightdashUrl || !readyFile) {
        throw new Error('--dir, --engine-file, --fakes-file, --seed-file, --lightdash-url and --ready-file are required');
    }
    const { engine, telemetryMcp } = readJson<EngineFile>(engineFile);
    const { okta } = readJson<{ okta?: { issuer?: string } }>(fakesFile);
    if (!okta?.issuer) throw new Error(`${fakesFile} has no okta.issuer`);
    const seeded = readJson<{ lightdash: { projectUuid: string; apiToken: string } }>(seedFile);

    const home = path.join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const port = await freePort();
    const url = `http://${HOST}:${port}`;

    const env: Record<string, string> = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: home,
        TMPDIR: home,
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        MCP_HOST: HOST,
        MCP_PORT: String(port),
        MCP_PUBLIC_URL: url,
        OKTA_ISSUER: okta.issuer,
        OKTA_AUDIENCE,
        LIGHTDASH_URL: lightdashUrl,
        LIGHTDASH_API_TOKEN: seeded.lightdash.apiToken,
        LIGHTDASH_PROJECT_UUID: seeded.lightdash.projectUuid,
        ENGINE_PG_HOST: engine.host,
        ENGINE_PG_PORT: String(engine.pgPort),
        ENGINE_PG_USER: telemetryMcp.user,
        ENGINE_PG_PASSWORD: telemetryMcp.password,
        ENGINE_PG_DATABASE: engine.database,
        ENGINE_HTTP_URL: engine.httpUrl,
        HRX_IDENTITY_SECRET: engine.identitySecret,
        MCP_SOURCES: JSON.stringify(telemetryMcp.sources),
        MCP_PLATFORM_SOURCE: 'platform',
        // A change of user attributes in Lightdash shows within seconds in the demo.
        MCP_USER_CACHE_TTL_MS: '5000',
    };
    for (const [key, value] of Object.entries(env)) {
        if (!value || /[\n\r]/.test(value)) throw new Error(`${key} is empty or contains a newline`);
    }

    const write = (file: string, text: string, mode: number) => {
        writeFileSync(`${file}.tmp`, text, { mode });
        renameSync(`${file}.tmp`, file);
    };
    write(
        path.join(dir, 'mcp.env'),
        Object.entries(env)
            .map(([k, v]) => `${k}=${v}\n`)
            .join(''),
        0o600,
    );
    write(readyFile, `${JSON.stringify({ mcp: { url } }, null, 2)}\n`, 0o600);
}

main().catch((e: unknown) => {
    console.error('mcp: failed:', e instanceof Error ? e.message : e);
    process.exit(1);
});
