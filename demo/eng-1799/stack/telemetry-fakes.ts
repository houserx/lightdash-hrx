// ENG-1799 demo: the scenario + telemetry fakes process (started by up.sh, stopped by down.sh).
//
//   node --import tsx stack/telemetry-fakes.ts --ready-file <.state/run/telemetry-fakes.json>
//
// Environment: DEMO_INCIDENT_AT, DEMO_RECOVERY_AT (seconds after start; up.sh has validated them).
// Every server listens on an ephemeral 127.0.0.1 port. Once all of them listen, the process writes
// the ready file ({"scenario": {"url": ...}}) atomically; up.sh waits for it.
//
// Scenario API:
//   GET  /scenario          -> {startedAt, incidentAt, recoveryAt, now, phase, ...}
//   POST /scenario/restart  {incidentAfterSeconds, recoveryAfterSeconds} (may be negative) -> same shape
//
// The telemetry fakes (Prometheus, Loki, Tempo, CloudWatch) join this process on their own ports and
// read the one ScenarioClock below.
import { renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { ScenarioClock, validateOffsets } from './clock.js';

const { values: args } = parseArgs({ options: { 'ready-file': { type: 'string' } } });
const readyFile = args['ready-file'];
if (!readyFile) {
    console.error('telemetry-fakes: --ready-file is required');
    process.exit(2);
}

function envSeconds(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
        console.error(`telemetry-fakes: ${name} must be a whole number of seconds (got '${raw}')`);
        process.exit(2);
    }
    return value;
}

const clock = new ScenarioClock(envSeconds('DEMO_INCIDENT_AT', 90), envSeconds('DEMO_RECOVERY_AT', 300));

const MAX_BODY_BYTES = 64 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(text);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new Error('request body too large');
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
}

const scenarioServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    switch (route) {
        case 'GET /scenario':
            send(res, 200, clock.view());
            return;
        case 'POST /scenario/restart':
            readJson(req).then(
                (body) => {
                    const { incidentAfterSeconds, recoveryAfterSeconds } = (body ?? {}) as Record<string, unknown>;
                    const error = validateOffsets(incidentAfterSeconds, recoveryAfterSeconds);
                    if (error) {
                        send(res, 400, { error });
                        return;
                    }
                    clock.restart(incidentAfterSeconds as number, recoveryAfterSeconds as number);
                    const view = clock.view();
                    console.log(
                        `scenario restarted: incident at ${view.incidentAt}, recovery at ${view.recoveryAt} (phase ${view.phase})`,
                    );
                    send(res, 200, view);
                },
                (e: unknown) => send(res, 400, { error: `body must be JSON: ${e instanceof Error ? e.message : String(e)}` }),
            );
            return;
        case 'GET /healthz':
            send(res, 200, { ok: true });
            return;
        default:
            send(res, url.pathname.replace(/\/+$/, '').startsWith('/scenario') ? 405 : 404, {
                error: `no route ${route}`,
            });
    }
});

function listen(server: http.Server): Promise<string> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

const servers = [scenarioServer];

function shutdown(signal: string): void {
    console.log(`telemetry-fakes: ${signal}, stopping`);
    for (const s of servers) s.close();
    // Keep-alive sockets would hold close() open; the process has nothing else to flush.
    setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function main(file: string): Promise<void> {
    const scenarioUrl = await listen(scenarioServer);
    const ready = { scenario: { url: scenarioUrl } };
    writeFileSync(`${file}.tmp`, `${JSON.stringify(ready, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    const view = clock.view();
    console.log(
        `telemetry-fakes: scenario clock at ${scenarioUrl} (started ${view.startedAt}, incident ${view.incidentAt}, recovery ${view.recoveryAt})`,
    );
}

main(readyFile).catch((e: unknown) => {
    console.error('telemetry-fakes: failed to start:', e);
    process.exit(1);
});
