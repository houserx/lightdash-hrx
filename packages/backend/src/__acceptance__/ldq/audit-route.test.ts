// ldq-audit-route: GET /api/v2/projects/{projectUuid}/federation/audit lists executions from the
// engine's GET /v1/audit, filtered by ticket, user and month, with cursor pagination.
import type { RequestHandler } from 'express';
import { startFakeEngine, type FakeEngine } from './fakeEngine';
import { load } from './load';
import {
    buildFederationService,
    buildRouteApp,
    federationProject,
    PROJECT_UUID,
    USER_UUID,
} from './routeHarness';
import { decodeToken, hasValidSignature } from './tokens';

vi.mock('../../controllers/authentication', async (importOriginal) => {
    const original = await importOriginal<any>();
    const pass: RequestHandler = (_request, _response, next) => next();
    return {
        ...original,
        allowApiKeyAuthentication: pass,
        isAuthenticated: pass,
        unauthorisedInDemo: pass,
    };
});

let FederationService: any;
let engine: FakeEngine;

const page = {
    items: [
        {
            id: 'exec-1',
            sql: 'SELECT status FROM refills WHERE id = 42',
            mode: 'read',
            description: 'Check a refill status',
            database: 'platform',
            linearTicketId: 'ENG-123',
            executedByEmail: 'support.one@example.com',
            executedBySub: 'user-sub-1',
            status: 'success',
            rowCount: 1,
            durationMs: 12,
            errorMessage: null,
            preview: false,
            action: 'query',
            integrityHash: 'synthetic-hash',
            createdAt: '2026-11-03T12:00:00.000Z',
            createdAtMonth: '2026-11',
        },
    ],
    nextCursor: 'cursor-2',
};

beforeAll(async () => {
    vi.unstubAllGlobals();
    ({ FederationService } = await load(
        '../../services/FederationService/FederationService',
    ));
    engine = await startFakeEngine();
    engine.reply('GET', '/v1/audit', { status: 200, body: page });
}, 120_000);

afterAll(async () => {
    await engine?.close();
});

beforeEach(() => {
    engine.requests.length = 0;
});

const base = `/api/v2/projects/${PROJECT_UUID}/federation/audit`;

const app = (attributes: Record<string, string[]>) =>
    buildRouteApp(
        buildFederationService(FederationService, {
            project: federationProject(engine.baseUrl),
            attributes,
        }),
    );

describe('GET federation/audit', () => {
    it('forwards filters and cursor and returns the page', async () => {
        const { call, touched } = app({ platform_read: ['true'] });
        const response = await call(
            'GET',
            `${base}?ticket=ENG-123&user=support.one%40example.com&month=2026-11&cursor=cursor-1`,
        );
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: 'ok', results: page });
        expect(touched).toEqual([]);
        expect(engine.requests).toHaveLength(1);
        const [request] = engine.requests;
        expect(request.method).toBe('GET');
        expect(request.path).toBe('/v1/audit');
        expect(request.query).toEqual({
            ticket: 'ENG-123',
            user: 'support.one@example.com',
            month: '2026-11',
            cursor: 'cursor-1',
        });
        const token = String(request.headers.authorization).slice(
            'Bearer '.length,
        );
        expect(hasValidSignature(token)).toBe(true);
        expect(decodeToken(token)).toMatchObject({
            sub: USER_UUID,
            attrs: { platform_read: true },
        });
    });

    it('omits filters that were not given', async () => {
        const { call } = app({ platform_read: ['true'] });
        const response = await call('GET', base);
        expect(response.status).toBe(200);
        expect(engine.requests[0].query).toEqual({});
    });

    it('needs platform_read', async () => {
        const { call } = app({ platform_explain: ['true'] });
        const response = await call('GET', `${base}?month=2026-11`);
        expect(response.status).toBe(403);
        expect(engine.requests).toHaveLength(0);
    });

    it('rejects a malformed month', async () => {
        const { call } = app({ platform_read: ['true'] });
        const response = await call('GET', `${base}?month=2026-13`);
        expect(response.status).toBe(400);
        expect(engine.requests).toHaveLength(0);
    });
});
