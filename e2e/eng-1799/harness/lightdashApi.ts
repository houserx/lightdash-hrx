/**
 * A fake Lightdash REST API for the MCP-only checks: just what the telemetry MCP server calls,
 * in the shapes the real routes answer (`{ status: 'ok', results }`), behind
 * `Authorization: ApiKey <apiToken>` like a personal access token.
 *
 *   GET /api/v1/org/users?searchQuery=<email>[&includeGroups=<n>]  (substring match, as Lightdash)
 *   GET /api/v1/org/attributes                                    (each user's value assigned directly)
 *   GET /api/v2/projects/{projectUuid}/alerting/state|history     (empty lists)
 */
import { jsonReply, startFakeServer, type FakeServer } from './fakeServer';

export type FakeLightdashUser = {
    userUuid: string;
    email: string;
    /** Default true. */
    isActive?: boolean;
    /** User attribute name → the value assigned to this user. */
    attributes: Record<string, string>;
};

export type StartFakeLightdashApiOptions = {
    projectUuid: string;
    organizationUuid: string;
    users: FakeLightdashUser[];
};

export type FakeLightdashApi = FakeServer & { apiToken: string };

const API_TOKEN = 'test-lightdash-api-token-not-real';

const notFound = (message: string) =>
    jsonReply(
        {
            status: 'error',
            error: { statusCode: 404, name: 'NotFoundError', message },
        },
        404,
    );

export async function startFakeLightdashApi(
    opts: StartFakeLightdashApiOptions,
): Promise<FakeLightdashApi> {
    const { projectUuid, organizationUuid, users } = opts;
    const attributeNames = [
        ...new Set(users.flatMap((u) => Object.keys(u.attributes))),
    ].sort();

    const server = await startFakeServer((request) => {
        if (request.headers.authorization !== `ApiKey ${API_TOKEN}`) {
            return jsonReply(
                {
                    status: 'error',
                    error: {
                        statusCode: 401,
                        name: 'AuthorizationError',
                        message: 'You are not authenticated',
                    },
                },
                401,
            );
        }
        if (request.method !== 'GET') return notFound('Route not found');

        if (request.path === '/api/v1/org/users') {
            const search = (request.params.searchQuery ?? '').toLowerCase();
            const withGroups = 'includeGroups' in request.params;
            const data = users
                .filter((u) => u.email.toLowerCase().includes(search))
                .map((u) => ({
                    userUuid: u.userUuid,
                    email: u.email,
                    firstName: 'E2E',
                    lastName: 'User',
                    organizationUuid,
                    role: 'viewer',
                    isActive: u.isActive ?? true,
                    isInviteExpired: false,
                    isPending: false,
                    ...(withGroups ? { groups: [] } : {}),
                }));
            return jsonReply({
                status: 'ok',
                results: {
                    data,
                    pagination: {
                        page: 1,
                        pageSize: Math.max(1, data.length),
                        totalResults: data.length,
                        totalPageCount: 1,
                    },
                },
            });
        }

        if (request.path === '/api/v1/org/attributes') {
            return jsonReply({
                status: 'ok',
                results: attributeNames.map((name, i) => ({
                    uuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    name,
                    organizationUuid,
                    users: users
                        .filter((u) => name in u.attributes)
                        .map((u) => ({
                            userUuid: u.userUuid,
                            email: u.email,
                            values: [u.attributes[name]],
                            value: u.attributes[name],
                        })),
                    groups: [],
                    attributeDefaults: null,
                    attributeDefault: null,
                })),
            });
        }

        const alerting =
            /^\/api\/v2\/projects\/([^/]+)\/alerting\/(state|history)$/.exec(
                request.path,
            );
        if (alerting) {
            if (decodeURIComponent(alerting[1]) !== projectUuid)
                return notFound('Project not found');
            return jsonReply({ status: 'ok', results: [] });
        }

        return notFound('Route not found');
    });

    return { ...server, apiToken: API_TOKEN };
}
