// ldq-write-confirmation-route: POST /api/v2/projects/{projectUuid}/write/confirmations mints a
// single-statement confirmation token (CONTRACTS §4.2) for users with platform_write.
import { createHash } from 'node:crypto';
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

const path = `/api/v2/projects/${PROJECT_UUID}/write/confirmations`;
const statement = "UPDATE refills SET status = 'cancelled' WHERE id = 42";

const app = (attributes: Record<string, string[]>, flavor = 'federation') =>
    buildRouteApp(
        buildFederationService(FederationService, {
            project: federationProject(engine.baseUrl, flavor),
            attributes,
        }),
    );

describe('POST write/confirmations', () => {
    it('returns a token bound to statement, user, project and a short expiry', async () => {
        const { call } = app({ platform_write: ['true'] });
        const before = Math.floor(Date.now() / 1000);
        const response = await call('POST', path, { statement });
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('ok');
        const { confirmationToken, expiresAt } = response.body.results;
        expect(hasValidSignature(confirmationToken)).toBe(true);
        const payload = decodeToken(confirmationToken);
        expect(payload).toMatchObject({
            v: 1,
            statement_sha256: createHash('sha256')
                .update(statement)
                .digest('hex'),
            sub: USER_UUID,
            project: PROJECT_UUID,
        });
        expect(Buffer.from(payload.nonce, 'base64url')).toHaveLength(16);
        expect(payload.exp).toBeGreaterThan(before);
        expect(payload.exp - before).toBeLessThanOrEqual(121);
        expect(expiresAt).toBe(new Date(payload.exp * 1000).toISOString());
        expect(engine.requests).toHaveLength(0);
    });

    it('never reuses a nonce', async () => {
        const { call } = app({ platform_write: ['true'] });
        const a = await call('POST', path, { statement });
        const b = await call('POST', path, { statement });
        expect(decodeToken(a.body.results.confirmationToken).nonce).not.toBe(
            decodeToken(b.body.results.confirmationToken).nonce,
        );
    });

    it('refuses users without platform_write', async () => {
        const { call } = app({ platform_write: ['false'], platform_read: ['true'] });
        const response = await call('POST', path, { statement });
        expect(response.status).toBe(403);
    });

    it('refuses projects that are not federation projects', async () => {
        const { call } = app({ platform_write: ['true'] }, 'postgres');
        const response = await call('POST', path, { statement });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
    });
});
