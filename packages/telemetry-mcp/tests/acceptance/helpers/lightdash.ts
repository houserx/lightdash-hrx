/**
 * Fake Lightdash REST API for acceptance tests. Implements only what the telemetry MCP server is
 * allowed to rely on (see PROGRESS.md "Contract assumptions"):
 *
 *   GET /api/v1/org/users?searchQuery=<email>[&includeGroups=<n>]   (ListOrganizationMembers)
 *   GET /api/v1/org/attributes                                     (getUserAttributes)
 *   GET /api/v2/projects/{projectUuid}/alerting/state              (alerting line, CONTRACTS §7)
 *   GET /api/v2/projects/{projectUuid}/alerting/history
 *
 * Every route requires `Authorization: ApiKey <service token>`, as real Lightdash personal access
 * tokens do. Node built-ins only. PROTECTED: do not edit.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUser {
    userUuid: string;
    email: string;
    firstName?: string;
    lastName?: string;
    organizationUuid: string;
    isActive?: boolean;
    groups?: { uuid: string; name: string }[];
}

export interface FakeAttribute {
    name: string;
    users?: { userUuid: string; value: string }[];
    groups?: { groupUuid: string; value: string }[];
    attributeDefault?: string | null;
}

export interface LightdashRequest {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: http.IncomingHttpHeaders;
}

export interface FakeLightdash {
    url: string;
    serviceToken: string;
    requests: LightdashRequest[];
    /** Count of user lookups (GET /api/v1/org/users). */
    userLookups(): number;
    setUsers(users: FakeUser[]): void;
    setAttributes(attrs: FakeAttribute[]): void;
    setAlerting(projectUuid: string, kind: 'state' | 'history', results: unknown): void;
    /** Make every alerting route answer with this status/body. */
    failAlerting(status: number, message: string): void;
    close(): Promise<void>;
}

export async function startFakeLightdash(opts: {
    serviceToken?: string;
    users?: FakeUser[];
    attributes?: FakeAttribute[];
}): Promise<FakeLightdash> {
    const serviceToken = opts.serviceToken ?? 'test-service-token-not-real';
    let users = opts.users ?? [];
    let attributes = opts.attributes ?? [];
    const alerting = new Map<string, unknown>();
    let alertingFailure: { status: number; message: string } | null = null;
    const requests: LightdashRequest[] = [];

    const send = (res: http.ServerResponse, status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const error = (res: http.ServerResponse, status: number, name: string, message: string): void =>
        send(res, status, { status: 'error', error: { statusCode: status, name, message } });

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        requests.push({
            method: req.method ?? 'GET',
            path: url.pathname,
            query: Object.fromEntries(url.searchParams.entries()),
            headers: req.headers,
        });
        if (req.headers.authorization !== `ApiKey ${serviceToken}`) {
            error(res, 401, 'AuthorizationError', 'You are not authenticated');
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/org/users') {
            const search = (url.searchParams.get('searchQuery') ?? '').toLowerCase();
            const includeGroups = url.searchParams.has('includeGroups');
            const data = users
                .filter((u) => !search || u.email.toLowerCase().includes(search))
                .map((u) => ({
                    userUuid: u.userUuid,
                    email: u.email,
                    firstName: u.firstName ?? 'Test',
                    lastName: u.lastName ?? 'User',
                    organizationUuid: u.organizationUuid,
                    role: 'viewer',
                    isActive: u.isActive ?? true,
                    isInviteExpired: false,
                    isPending: false,
                    ...(includeGroups ? { groups: u.groups ?? [] } : {}),
                }));
            send(res, 200, {
                status: 'ok',
                results: {
                    data,
                    pagination: { page: 1, pageSize: Math.max(1, data.length), totalResults: data.length, totalPageCount: 1 },
                },
            });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/org/attributes') {
            send(res, 200, {
                status: 'ok',
                results: attributes.map((a, i) => ({
                    uuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    name: a.name,
                    organizationUuid: users[0]?.organizationUuid ?? '',
                    users: (a.users ?? []).map((u) => ({
                        userUuid: u.userUuid,
                        email: users.find((x) => x.userUuid === u.userUuid)?.email ?? '',
                        values: [u.value],
                        value: u.value,
                    })),
                    groups: (a.groups ?? []).map((g) => ({ groupUuid: g.groupUuid, values: [g.value], value: g.value })),
                    attributeDefaults: a.attributeDefault == null ? null : [a.attributeDefault],
                    attributeDefault: a.attributeDefault ?? null,
                })),
            });
            return;
        }
        const m = /^\/api\/v2\/projects\/([^/]+)\/alerting\/(state|history)$/.exec(url.pathname);
        if (req.method === 'GET' && m) {
            if (alertingFailure) {
                error(res, alertingFailure.status, 'AlertingError', alertingFailure.message);
                return;
            }
            const key = `${m[1]}:${m[2]}`;
            if (!alerting.has(key)) {
                error(res, 404, 'NotFoundError', 'Project not found');
                return;
            }
            send(res, 200, { status: 'ok', results: alerting.get(key) });
            return;
        }
        error(res, 404, 'NotFoundError', 'Route not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    return {
        url: `http://127.0.0.1:${port}`,
        serviceToken,
        requests,
        userLookups: () => requests.filter((r) => r.path === '/api/v1/org/users').length,
        setUsers: (u) => {
            users = u;
        },
        setAttributes: (a) => {
            attributes = a;
        },
        setAlerting: (projectUuid, kind, results) => {
            alerting.set(`${projectUuid}:${kind}`, results);
        },
        failAlerting: (status, message) => {
            alertingFailure = { status, message };
        },
        async close() {
            server.closeAllConnections?.();
            await new Promise<void>((r) => server.close(() => r()));
        },
    };
}
