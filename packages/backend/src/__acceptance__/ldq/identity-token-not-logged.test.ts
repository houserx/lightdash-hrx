// ldq-identity-token-not-logged: identity tokens never reach a log, on success or failure.
import type { RequestHandler } from 'express';
import Logger from '../../logging/logger';
import { startFakeEngine, type FakeEngine } from './fakeEngine';
import { load } from './load';
import {
    buildFederationService,
    buildRouteApp,
    federationProject,
    PROJECT_UUID,
} from './routeHarness';
import { TEST_SECRET } from './tokens';

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
let FederationIdentityService: any;
let engine: FakeEngine;
const captured: string[] = [];

const capture = (...args: unknown[]) => {
    captured.push(
        args
            .map((arg) => {
                if (typeof arg === 'string') return arg;
                try {
                    return JSON.stringify(arg);
                } catch {
                    return String(arg);
                }
            })
            .join(' '),
    );
};

beforeAll(async () => {
    vi.unstubAllGlobals();
    ({ FederationService } = await load(
        '../../services/FederationService/FederationService',
    ));
    ({ FederationIdentityService } = await load(
        '../../services/FederationIdentity/FederationIdentityService',
    ));
    engine = await startFakeEngine();
}, 120_000);

beforeEach(() => {
    captured.length = 0;
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
        vi.spyOn(console, method).mockImplementation(capture);
    }
    for (const method of ['debug', 'info', 'warn', 'error', 'log', 'verbose', 'http'] as const) {
        const logger = Logger as unknown as Record<string, unknown>;
        if (typeof logger[method] === 'function') {
            vi.spyOn(logger as any, method).mockImplementation(((...args: unknown[]) => {
                capture(...args);
                return Logger;
            }) as never);
        }
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        capture(String(chunk));
        return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
        capture(String(chunk));
        return true;
    }) as never);
});

afterEach(() => {
    vi.restoreAllMocks();
});

afterAll(async () => {
    await engine?.close();
});

const bearer = (index: number) =>
    String(engine.requests[index].headers.authorization).slice('Bearer '.length);

describe('identity tokens stay out of logs', () => {
    it('when minting through the service and the provider', async () => {
        const service = new FederationIdentityService({
            userAttributesModel: {
                getAttributeValuesForOrgMember: vi.fn(async () => ({
                    platform_read: ['true'],
                })),
            },
        });
        const args = {
            secret: TEST_SECRET,
            user: {
                userUuid: 'user-uuid',
                email: 'support.person@example.com',
                organizationUuid: 'org-uuid',
            },
            projectUuid: 'project-uuid',
            audit: { source: 'investigate', description: 'why' },
        };
        const token: string = await service.mintForUser(args);
        const provided: string = await service.createTokenProvider(args)({
            agent: false,
        });
        const text = captured.join('\n');
        expect(text).not.toContain(token);
        expect(text).not.toContain(provided);
        expect(text).not.toContain(TEST_SECRET);
    });

    it('when the engine refuses or fails a write', async () => {
        const { call } = buildRouteApp(
            buildFederationService(FederationService, {
                project: federationProject(engine.baseUrl),
                attributes: { platform_write: ['true'], platform_read: ['true'] },
            }),
        );
        engine.requests.length = 0;
        engine.reply('POST', '/v1/write', {
            status: 500,
            body: { error: 'engine exploded' },
        });
        const write = await call('POST', `/api/v2/projects/${PROJECT_UUID}/write`, {
            statement: 'DELETE FROM refill_locks WHERE refill_id = 1',
            mode: 'preview',
            confirmationToken: 'confirmation-token',
            description: 'Testing failure logging',
        });
        expect(write.status).toBeGreaterThanOrEqual(400);
        engine.reply('GET', '/v1/audit', {
            status: 503,
            body: { error: 'audit store unavailable' },
        });
        const audit = await call(
            'GET',
            `/api/v2/projects/${PROJECT_UUID}/federation/audit?month=2026-11`,
        );
        expect(audit.status).toBeGreaterThanOrEqual(400);
        expect(engine.requests).toHaveLength(2);
        const text = captured.join('\n') + JSON.stringify([write.body, audit.body]);
        expect(text).not.toContain(bearer(0));
        expect(text).not.toContain(bearer(1));
        expect(text).not.toContain(bearer(0).split('.')[1]);
        expect(text).not.toContain(TEST_SECRET);
    });
});
