// ENG-1799 demo: the scenario + telemetry fakes process (started by up.sh, stopped by down.sh).
//
//   node --import tsx stack/telemetry-fakes.ts --endpoints-file <.state/run/engine-config.json> \
//       --ready-file <.state/run/telemetry-fakes.json>
//
// Environment: DEMO_INCIDENT_AT, DEMO_RECOVERY_AT (seconds after start; up.sh has validated them).
// The scenario API listens on an ephemeral 127.0.0.1 port; each telemetry fake listens exactly on the
// endpoint the engine config reserved for it (`endpoints.*` of --endpoints-file). Once all of them listen,
// the process writes the ready file ({"scenario": {"url": ...}, "prometheus": {"url": ...}, "loki": {"url": ...},
// "tempo": {"url": ...}, "cloudwatch": {"url": ...}, "cloudwatchLogs": {"url": ...}, "auditDynamodb": {"url": ...},
// "auditS3": {"url": ...}, "incidentIo": {"url": ...}, "lightdashS3": {"url": ...}, "okta": {"url": ..., "issuer": ...}})
// atomically; up.sh waits for it.
// The fake incident.io receiver (stack/incident-io.ts), Lightdash's results S3 (stack/results-s3.ts) and the fake
// Okta that telemetry-mcp trusts (stack/okta.ts) are not engine endpoints and listen on ephemeral ports.
//
// Scenario API:
//   GET  /scenario          -> {startedAt, incidentAt, recoveryAt, now, phase, ...}
//   POST /scenario/restart  {incidentAfterSeconds, recoveryAfterSeconds} (may be negative) -> same shape
//
// The telemetry fakes read the one ScenarioClock below per request. Prometheus (stack/prometheus.ts), Loki
// (stack/loki.ts), Tempo (stack/tempo.ts), CloudWatch metrics (stack/cloudwatch.ts) and CloudWatch Logs
// Insights (stack/cloudwatch-logs.ts) are here, and the engine's audit store (stack/audit-store.ts: DynamoDB and
// S3 Object Lock, one in-memory store on two endpoints) that Audited Queries and the audit browser need, and the
// fake incident.io receiver that the alerting Contact Point posts Alertmanager webhooks to, and the S3-compatible
// store Lightdash keeps query results and exports in.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { AuditStore, auditDynamodbHandler, auditS3Handler } from './audit-store.js';
import { ScenarioClock, validateOffsets } from './clock.js';
import { cloudwatchHandler } from './cloudwatch.js';
import { cloudwatchLogsHandler } from './cloudwatch-logs.js';
import { IncidentIoInbox, incidentIoHandler } from './incident-io.js';
import { lokiHandler } from './loki.js';
import { FakeOkta, OKTA_ISSUER_PATH, oktaHandler } from './okta.js';
import { prometheusHandler } from './prometheus.js';
import { ResultsStore, resultsS3Handler } from './results-s3.js';
import { tempoHandler } from './tempo.js';

const { values: args } = parseArgs({
    options: { 'ready-file': { type: 'string' }, 'endpoints-file': { type: 'string' } },
});
const readyFile = args['ready-file'];
const endpointsFile = args['endpoints-file'];
if (!readyFile || !endpointsFile) {
    console.error('telemetry-fakes: --endpoints-file and --ready-file are required');
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

const prometheusServer = http.createServer(prometheusHandler(() => clock.current()));
const lokiServer = http.createServer(lokiHandler(() => clock.current()));
const tempoServer = http.createServer(tempoHandler(() => clock.current()));
const cloudwatchServer = http.createServer(cloudwatchHandler(() => clock.current()));
const cloudwatchLogsServer = http.createServer(cloudwatchLogsHandler(() => clock.current()));
const auditStore = new AuditStore();
const auditDynamodbServer = http.createServer(auditDynamodbHandler(auditStore));
const auditS3Server = http.createServer(auditS3Handler(auditStore));
const incidentIoServer = http.createServer(incidentIoHandler(new IncidentIoInbox()));
const lightdashS3Server = http.createServer(resultsS3Handler(new ResultsStore()));
const okta = new FakeOkta();
const oktaServer = http.createServer(oktaHandler(okta));

/** Listens on 127.0.0.1:<port> (0 = ephemeral) and resolves with the server's URL. */
function listen(server: http.Server, port = 0): Promise<string> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

const servers = [
    scenarioServer,
    prometheusServer,
    lokiServer,
    tempoServer,
    cloudwatchServer,
    cloudwatchLogsServer,
    auditDynamodbServer,
    auditS3Server,
    incidentIoServer,
    lightdashS3Server,
    oktaServer,
];

function shutdown(signal: string): void {
    console.log(`telemetry-fakes: ${signal}, stopping`);
    for (const s of servers) s.close();
    // Keep-alive sockets would hold close() open; the process has nothing else to flush.
    setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/** The reserved port of one endpoint in the engine config's ready file. */
function reservedPort(endpoints: Record<string, unknown>, name: string): number {
    const url = endpoints[name];
    const port = typeof url === 'string' ? Number(new URL(url).port) : NaN;
    if (!Number.isInteger(port) || port <= 0) throw new Error(`${endpointsFile} has no endpoints.${name} URL with a port`);
    return port;
}

async function main(file: string, endpointsPath: string): Promise<void> {
    const { endpoints } = JSON.parse(readFileSync(endpointsPath, 'utf8')) as { endpoints: Record<string, unknown> };
    const scenarioUrl = await listen(scenarioServer);
    const prometheusUrl = await listen(prometheusServer, reservedPort(endpoints, 'prometheus'));
    const lokiUrl = await listen(lokiServer, reservedPort(endpoints, 'loki'));
    const tempoUrl = await listen(tempoServer, reservedPort(endpoints, 'tempo'));
    const cloudwatchUrl = await listen(cloudwatchServer, reservedPort(endpoints, 'cloudwatch'));
    const cloudwatchLogsUrl = await listen(cloudwatchLogsServer, reservedPort(endpoints, 'cloudwatchLogs'));
    const auditDynamodbUrl = await listen(auditDynamodbServer, reservedPort(endpoints, 'auditDynamodb'));
    const auditS3Url = await listen(auditS3Server, reservedPort(endpoints, 'auditS3'));
    const incidentIoUrl = await listen(incidentIoServer);
    const lightdashS3Url = await listen(lightdashS3Server);
    const oktaUrl = await listen(oktaServer);
    okta.issuer = `${oktaUrl}${OKTA_ISSUER_PATH}`;
    const ready = {
        scenario: { url: scenarioUrl },
        prometheus: { url: prometheusUrl },
        loki: { url: lokiUrl },
        tempo: { url: tempoUrl },
        cloudwatch: { url: cloudwatchUrl },
        cloudwatchLogs: { url: cloudwatchLogsUrl },
        auditDynamodb: { url: auditDynamodbUrl },
        auditS3: { url: auditS3Url },
        incidentIo: { url: incidentIoUrl },
        lightdashS3: { url: lightdashS3Url },
        okta: { url: oktaUrl, issuer: okta.issuer },
    };
    writeFileSync(`${file}.tmp`, `${JSON.stringify(ready, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    const view = clock.view();
    console.log(
        `telemetry-fakes: scenario clock at ${scenarioUrl} (started ${view.startedAt}, incident ${view.incidentAt}, recovery ${view.recoveryAt})`,
    );
    console.log(`telemetry-fakes: Prometheus at ${prometheusUrl}`);
    console.log(`telemetry-fakes: Loki at ${lokiUrl}`);
    console.log(`telemetry-fakes: Tempo at ${tempoUrl}`);
    console.log(`telemetry-fakes: CloudWatch (GetMetricData) at ${cloudwatchUrl}`);
    console.log(`telemetry-fakes: CloudWatch Logs Insights at ${cloudwatchLogsUrl}`);
    console.log(`telemetry-fakes: audit store at ${auditDynamodbUrl} (DynamoDB) and ${auditS3Url} (S3 Object Lock)`);
    console.log(`telemetry-fakes: incident.io receiver at ${incidentIoUrl}`);
    console.log(`telemetry-fakes: Lightdash results S3 at ${lightdashS3Url}`);
    console.log(`telemetry-fakes: Okta (fake) issuer ${okta.issuer}`);
}

main(readyFile, endpointsFile).catch((e: unknown) => {
    console.error('telemetry-fakes: failed to start:', e);
    process.exit(1);
});
