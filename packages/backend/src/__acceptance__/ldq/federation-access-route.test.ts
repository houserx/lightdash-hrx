// ldq-federation-access-route: the frontend learns whether a project is a federation project
// and which ldq claims the current user holds, from their Lightdash user attributes.
import type { RequestHandler } from 'express';
import { load } from './load';
import {
    buildFederationService,
    buildRouteApp,
    federationProject,
    PROJECT_UUID,
} from './routeHarness';

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

beforeAll(async () => {
    ({ FederationService } = await load(
        '../../services/FederationService/FederationService',
    ));
}, 120_000);

const path = `/api/v2/projects/${PROJECT_UUID}/federation/access`;

describe('GET /api/v2/projects/{projectUuid}/federation/access', () => {
    it('maps user attributes to claims: only "true" is true', async () => {
        const service = buildFederationService(FederationService, {
            project: federationProject('http://127.0.0.1:1'),
            attributes: {
                telemetry_restricted: ['false'],
                platform_read: ['true'],
                platform_write: ['TRUE'],
                platform_explain: ['true'],
                unrelated: ['true'],
            },
        });
        const { call } = buildRouteApp(service);
        const response = await call('GET', path);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            status: 'ok',
            results: {
                isFederation: true,
                attrs: {
                    telemetry_restricted: false,
                    platform_read: true,
                    platform_write: false,
                    platform_explain: true,
                },
            },
        });
    });

    it('reports a plain Postgres project as not federation', async () => {
        const service = buildFederationService(FederationService, {
            project: federationProject('http://127.0.0.1:1', 'postgres'),
            attributes: {},
        });
        const { call } = buildRouteApp(service);
        const response = await call('GET', path);
        expect(response.status).toBe(200);
        expect(response.body.results).toEqual({
            isFederation: false,
            attrs: {
                telemetry_restricted: false,
                platform_read: false,
                platform_write: false,
                platform_explain: false,
            },
        });
    });

    it('never returns the signing secret', async () => {
        const service = buildFederationService(FederationService, {
            project: federationProject('http://127.0.0.1:1'),
            attributes: {},
        });
        const { call } = buildRouteApp(service);
        const response = await call('GET', path);
        expect(JSON.stringify(response.body)).not.toContain(
            'test-secret-not-real',
        );
    });
});
