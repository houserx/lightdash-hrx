// ldq-write-commit-route: mode "commit" is forwarded the same way; the engine's refusals
// (409 reused confirmation, 403 guard) come back with their status.
import type { RequestHandler } from 'express';
import { startFakeEngine, type FakeEngine } from './fakeEngine';
import { load } from './load';
import {
    buildFederationService,
    buildRouteApp,
    federationProject,
    PROJECT_UUID,
} from './routeHarness';
import { decodeToken } from './tokens';

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
const statement = 'DELETE FROM refill_locks WHERE refill_id = 42';

const app = () =>
    buildRouteApp(
        buildFederationService(FederationService, {
            project: federationProject(engine.baseUrl),
            attributes: { platform_write: ['true'] },
        }),
    );

describe('POST write (commit)', () => {
    it('commits through the engine, with a null ticket when none is given', async () => {
        const result = {
            audit_id: 'audit-0002',
            rows_affected: 1,
            preview: false,
            returning: null,
        };
        engine.reply('POST', '/v1/write', { status: 200, body: result });
        const { call, touched } = app();
        const response = await call('POST', path, {
            statement,
            mode: 'commit',
            confirmationToken: 'confirmation-token-commit',
            description: 'Release a stuck refill lock',
        });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: 'ok', results: result });
        expect(touched).toEqual([]);
        expect(engine.requests).toHaveLength(1);
        expect(engine.requests[0].body).toEqual({
            statement,
            mode: 'commit',
            confirmation_token: 'confirmation-token-commit',
            description: 'Release a stuck refill lock',
            ticket: null,
        });
        const token = String(engine.requests[0].headers.authorization).slice(
            'Bearer '.length,
        );
        expect(decodeToken(token).audit).toEqual({
            description: 'Release a stuck refill lock',
            ticket: null,
            source: 'write_mode',
            resource_uuid: null,
        });
    });

    it('returns 409 when the engine rejects a reused confirmation', async () => {
        engine.reply('POST', '/v1/write', {
            status: 409,
            body: { error: 'confirmation token already used' },
        });
        const { call } = app();
        const response = await call('POST', path, {
            statement,
            mode: 'commit',
            confirmationToken: 'confirmation-token-used',
            description: 'Release a stuck refill lock',
        });
        expect(response.status).toBe(409);
    });

    it('returns the engine guard refusal status', async () => {
        engine.reply('POST', '/v1/write', {
            status: 403,
            body: { error: 'DDL is always blocked' },
        });
        const { call } = app();
        const response = await call('POST', path, {
            statement: 'DROP TABLE refills',
            mode: 'commit',
            confirmationToken: 'confirmation-token-ddl',
            description: 'Should be blocked',
        });
        expect(response.status).toBe(403);
    });

    it('rejects an unknown mode without calling the engine', async () => {
        const { call } = app();
        const response = await call('POST', path, {
            statement,
            mode: 'force',
            confirmationToken: 'confirmation-token',
            description: 'Unknown mode',
        });
        expect(response.status).toBe(400);
        expect(engine.requests).toHaveLength(0);
    });
});
