// ENG-1799 demo: the fake incident.io receiver (served from the telemetry-fakes process on an ephemeral port;
// stack.json `incidentIo.url`). It stands in for incident.io's Alertmanager alert source: Lightdash's incident_io
// Contact Point posts Alertmanager v4 webhooks to it (CONTRACTS 4.3) and the walkthrough shows its page.
//
//   POST /webhook        an Alertmanager v4 payload (`version: "4"`, `status` firing|resolved, `alerts[]` each with
//                        `status`, `labels`, `annotations`, `startsAt`, `endsAt`, `fingerprint`) with an
//                        `Authorization: Bearer <token>` header, like incident.io's alert source. Any non-empty
//                        token is accepted (the demo's token is not a real secret); a missing one -> 401, a payload
//                        that is not v4 -> 400. Accepted -> 202 {status: "success", message, deduplication_key}.
//   GET  /api/received   {notifications: [{receivedAt, payload}]}, oldest first, every accepted webhook as sent.
//   GET  /               an HTML page (title "incident.io (fake)"): one table row per received alert, newest
//                        first, with its status, alertname, labels, summary and times; it refreshes every 5 s.
//   GET  /ready          200 "ready".
// Notifications live as long as the telemetry-fakes process (down.sh discards them); the newest
// MAX_NOTIFICATIONS are kept.
import type http from 'node:http';

export type Notification = { receivedAt: string; payload: AlertmanagerPayload };

type AlertStatus = 'firing' | 'resolved';
type Alert = {
    status: AlertStatus;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    endsAt: string;
    fingerprint: string;
    [key: string]: unknown;
};
type AlertmanagerPayload = {
    version: '4';
    status: AlertStatus;
    groupKey: string;
    alerts: Alert[];
    [key: string]: unknown;
};

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_NOTIFICATIONS = 1000;
const REFRESH_SECONDS = 5;

export class IncidentIoInbox {
    private readonly received: Notification[] = [];

    add(payload: AlertmanagerPayload): Notification {
        const notification = { receivedAt: new Date().toISOString(), payload };
        this.received.push(notification);
        if (this.received.length > MAX_NOTIFICATIONS) this.received.splice(0, this.received.length - MAX_NOTIFICATIONS);
        return notification;
    }

    list(): Notification[] {
        return [...this.received];
    }
}

class BadRequest extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringMap = (v: unknown): v is Record<string, string> =>
    isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
const isStatus = (v: unknown): v is AlertStatus => v === 'firing' || v === 'resolved';

/** Checks the Alertmanager v4 webhook shape; throws BadRequest naming the first field that is wrong. */
export function parsePayload(body: unknown): AlertmanagerPayload {
    if (!isRecord(body)) throw new BadRequest(400, 'body must be a JSON object');
    if (body.version !== '4') throw new BadRequest(400, `version must be "4" (got ${JSON.stringify(body.version)})`);
    if (!isStatus(body.status)) throw new BadRequest(400, 'status must be "firing" or "resolved"');
    if (typeof body.groupKey !== 'string') throw new BadRequest(400, 'groupKey must be a string');
    if (!Array.isArray(body.alerts) || body.alerts.length === 0) throw new BadRequest(400, 'alerts must be a non-empty array');
    body.alerts.forEach((a, i) => {
        if (!isRecord(a)) throw new BadRequest(400, `alerts[${i}] must be an object`);
        if (!isStatus(a.status)) throw new BadRequest(400, `alerts[${i}].status must be "firing" or "resolved"`);
        if (!isStringMap(a.labels)) throw new BadRequest(400, `alerts[${i}].labels must map names to strings`);
        if (!isStringMap(a.annotations)) throw new BadRequest(400, `alerts[${i}].annotations must map names to strings`);
        for (const key of ['startsAt', 'endsAt', 'fingerprint'] as const) {
            if (typeof a[key] !== 'string') throw new BadRequest(400, `alerts[${i}].${key} must be a string`);
        }
    });
    return body as AlertmanagerPayload;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new BadRequest(413, 'request body too large');
        chunks.push(chunk as Buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
        throw new BadRequest(400, `body must be JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

const escapeHtml = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Alertmanager's "zero" endsAt for a firing alert. */
const showTime = (t: string) => (t.startsWith('0001-01-01') ? '' : t);

export function renderPage(notifications: Notification[]): string {
    const rows = notifications
        .slice()
        .reverse()
        .flatMap((n) =>
            n.payload.alerts.map((a) => {
                const { alertname = '', ...labels } = a.labels;
                const labelText = Object.entries(labels)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ');
                const cells = [
                    `<td class="status ${a.status}">${escapeHtml(a.status)}</td>`,
                    `<td>${escapeHtml(alertname)}</td>`,
                    `<td>${escapeHtml(labelText)}</td>`,
                    `<td>${escapeHtml(a.annotations.summary ?? '')}</td>`,
                    `<td>${escapeHtml(a.startsAt)}</td>`,
                    `<td>${escapeHtml(showTime(a.endsAt))}</td>`,
                    `<td>${escapeHtml(n.receivedAt)}</td>`,
                ];
                return `<tr>${cells.join('')}</tr>`;
            }),
        );
    const body =
        rows.length === 0
            ? '<p class="empty">No alerts received yet.</p>'
            : `<table>
<thead><tr><th>Status</th><th>Alert</th><th>Labels</th><th>Summary</th><th>Started</th><th>Ended</th><th>Received</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>incident.io (fake) - received alerts</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #1f2933; }
h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
p.note { color: #616e7c; margin-top: 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e4e7eb; vertical-align: top; }
th { background: #f5f7fa; }
td.status { font-weight: 600; text-transform: uppercase; }
td.status.firing { color: #c81e1e; }
td.status.resolved { color: #0e7c3a; }
</style>
</head>
<body>
<h1>incident.io (fake): received alerts</h1>
<p class="note">Alertmanager v4 webhooks posted to /webhook, newest first. ${notifications.length} notification(s); this page refreshes every ${REFRESH_SECONDS} s.</p>
${body}
</body>
</html>
`;
}

export function incidentIoHandler(inbox: IncidentIoInbox): http.RequestListener {
    return (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
        switch (route) {
            case 'POST /webhook': {
                const auth = req.headers.authorization ?? '';
                if (!/^Bearer\s+\S+/i.test(auth)) {
                    sendJson(res, 401, { status: 'authentication_error', message: 'missing Authorization: Bearer <token>' });
                    req.resume();
                    return;
                }
                readJson(req)
                    .then(parsePayload)
                    .then(
                        (payload) => {
                            inbox.add(payload);
                            console.log(
                                `incident.io (fake): ${payload.status} ${payload.alerts.length} alert(s) for ${payload.groupKey}`,
                            );
                            sendJson(res, 202, {
                                status: 'success',
                                message: 'Event accepted for processing',
                                deduplication_key: payload.groupKey,
                            });
                        },
                        (e: unknown) => {
                            const status = e instanceof BadRequest ? e.status : 500;
                            sendJson(res, status, { status: 'invalid_request_error', message: e instanceof Error ? e.message : String(e) });
                        },
                    );
                return;
            }
            case 'GET /api/received':
                sendJson(res, 200, { notifications: inbox.list() });
                return;
            case 'GET /':
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(renderPage(inbox.list()));
                return;
            case 'GET /ready':
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('ready');
                return;
            default:
                sendJson(res, 404, { status: 'not_found', message: `no route ${route}` });
        }
    };
}
