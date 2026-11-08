// ldq-write-preview-route: POST /api/v2/projects/{projectUuid}/write with mode "preview" forwards
// to the engine's POST /v1/write with a fresh identity token, outside AsyncQueryService.
import type { RequestHandler } from 'express';
import { startFakeEngine, type FakeEngine } from './fakeEngine';
import { load } from './load';
import {
    buildFederationService,
    buildRouteApp,
    federationProject,
    ORGANIZATION_UUID,
    PROJECT_UUID,
    USER_EMAIL,
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

beforeAll(async () => {
    vi.unstubAllGlobals();
    ({ FederationService } = await load(
        '../../services/FederationService/FederationService',
    ));
    engine = await startFakeEngine();
}, 120_000);

afterAll(async () => {
    await engine?.close();
});

beforeEach(() => {
    engine.requests.length = 0;
});

const path = `/api/v2/projects/${PROJECT_UUID}/write`;
const statement =
    "UPDATE refills SET status = 'cancelled' WHERE id = 42 RETURNING id, status";
const engineResult = {
    audit_id: 'audit-0001',
    rows_affected: 1,
    preview: true,
    returning: [{ id: 42, status: 'cancelled' }],
};

const app = (attributes: Record<string, string[]> = { platform_write: ['true'] }) =>
    buildRouteApp(
        buildFederationService(FederationService, {
            project: federationProject(engine.baseUrl),
            attributes,
        }),
    );

describe('POST write (preview)', () => {
    it('forwards to the engine with a signed identity and returns its result', async () => {
        engine.reply('POST', '/v1/write', { status: 200, body: engineResult });
        const { call, touched } = app();
        const response = await call('POST', path, {
            statement,
            mode: 'preview',
            confirmationToken: 'confirmation-token-from-client',
            description: 'Cancel a duplicate refill',
            ticket: 'ENG-123',
        });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: 'ok', results: engineResult });
        expect(touched).toEqual([]);

        expect(engine.requests).toHaveLength(1);
        const [request] = engine.requests;
        expect(request.method).toBe('POST');
        expect(request.path).toBe('/v1/write');
        expect(request.body).toEqual({
            statement,
            mode: 'preview',
            confirmation_token: 'confirmation-token-from-client',
            description: 'Cancel a duplicate refill',
            ticket: 'ENG-123',
        });
        const authorization = String(request.headers.authorization);
        expect(authorization.startsWith('Bearer ')).toBe(true);
        const token = authorization.slice('Bearer '.length);
        expect(hasValidSignature(token)).toBe(true);
        const payload = decodeToken(token);
        expect(payload).toMatchObject({
            v: 1,
            iss: 'lightdash',
            sub: USER_UUID,
            email: USER_EMAIL,
            org: ORGANIZATION_UUID,
            project: PROJECT_UUID,
            agent: false,
            sys: false,
            attrs: {
                telemetry_restricted: false,
                platform_read: false,
                platform_write: true,
                platform_explain: false,
            },
            audit: {
                description: 'Cancel a duplicate refill',
                ticket: 'ENG-123',
                source: 'write_mode',
                resource_uuid: null,
            },
        });
        expect(payload.exp - payload.iat).toBeLessThanOrEqual(300);
        expect(payload.exp - payload.iat).toBeGreaterThan(0);
    });

    it('requires a description before calling the engine', async () => {
        engine.reply('POST', '/v1/write', { status: 200, body: engineResult });
        const { call } = app();
        const response = await call('POST', path, {
            statement,
            mode: 'preview',
            confirmationToken: 'confirmation-token-from-client',
            description: '   ',
        });
        expect(response.status).toBe(400);
        expect(engine.requests).toHaveLength(0);
    });

    it('refuses users without platform_write', async () => {
        engine.reply('POST', '/v1/write', { status: 200, body: engineResult });
        const { call } = app({ platform_read: ['true'] });
        const response = await call('POST', path, {
            statement,
            mode: 'preview',
            confirmationToken: 'confirmation-token-from-client',
            description: 'Cancel a duplicate refill',
        });
        expect(response.status).toBe(403);
        expect(engine.requests).toHaveLength(0);
    });
});
