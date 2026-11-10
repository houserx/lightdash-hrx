// ldq-write-agent-refused: an AI agent context may Preview but never commit (ADR 0004).
// Agent contexts are detected from agentExecutionContext, the same signal that makes
// WarehouseClientFactory open agent sessions on PostgresWarehouseClient.
import type { RequestHandler } from 'express';
import { AgentActorSurface } from '@lightdash/common';
import {
    agentExecutionContext,
    createAgentExecutionContext,
} from '../../services/AiAccessService/agentExecutionContext';
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
    engine.reply('POST', '/v1/write', {
        status: 200,
        body: { audit_id: 'audit-3', rows_affected: 1, preview: true, returning: [] },
    });
}, 120_000);

afterAll(async () => {
    await engine?.close();
});

beforeEach(() => {
    engine.requests.length = 0;
});

const path = `/api/v2/projects/${PROJECT_UUID}/write`;

const asAgent = <T>(account: any, run: () => T): T =>
    agentExecutionContext.run(
        createAgentExecutionContext({
            account,
            surface: AgentActorSurface.IN_APP_AGENT,
            clientId: null,
            agentUuid: 'ldq-test-agent',
            agentIdentityEnabled: true,
        }),
        run,
    );

const body = (mode: 'preview' | 'commit') => ({
    statement: "UPDATE refills SET status = 'cancelled' WHERE id = 7",
    mode,
    confirmationToken: `confirmation-${mode}`,
    description: 'Agent suggested fix',
});

describe('Write Mode from an AI agent context', () => {
    const app = () =>
        buildRouteApp(
            buildFederationService(FederationService, {
                project: federationProject(engine.baseUrl),
                attributes: { platform_write: ['true'] },
            }),
        );

    it('refuses commit without calling the engine', async () => {
        const { call, account } = app();
        const response = await asAgent(account, () =>
            call('POST', path, body('commit')),
        );
        expect(response.status).toBe(403);
        expect(engine.requests).toHaveLength(0);
    });

    it('allows preview, marking the identity as an agent', async () => {
        const { call, account } = app();
        const response = await asAgent(account, () =>
            call('POST', path, body('preview')),
        );
        expect(response.status).toBe(200);
        expect(engine.requests).toHaveLength(1);
        const token = String(engine.requests[0].headers.authorization).slice(
            'Bearer '.length,
        );
        expect(decodeToken(token).agent).toBe(true);
    });

    it('still lets a person commit outside the agent context', async () => {
        const { call } = app();
        const response = await call('POST', path, body('commit'));
        expect(response.status).toBe(200);
        expect(engine.requests).toHaveLength(1);
    });
});
