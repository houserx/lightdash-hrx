// ldq-identity-token-agent: AI agent sessions set agent = true. Detection matches how
// PostgresWarehouseClient sessions become agent sessions: an explicit agentSession flag
// (WarehouseClientFactory's option) or, when absent, a live agentExecutionContext.
import { AgentActorSurface } from '@lightdash/common';
import { buildAccount } from '../../auth/account/account.mock';
import {
    agentExecutionContext,
    createAgentExecutionContext,
} from '../../services/AiAccessService/agentExecutionContext';
import { load } from './load';
import { decodeToken, TEST_SECRET } from './tokens';

let FederationIdentityService: any;

beforeAll(async () => {
    ({ FederationIdentityService } = await load(
        '../../services/FederationIdentity/FederationIdentityService',
    ));
}, 120_000);

const user = {
    userUuid: 'user-uuid',
    email: 'support.person@example.com',
    organizationUuid: 'org-uuid',
};

const service = () =>
    new FederationIdentityService({
        userAttributesModel: {
            getAttributeValuesForOrgMember: vi.fn(async () => ({
                telemetry_restricted: ['true'],
            })),
        },
    });

const mint = (extra: Record<string, unknown> = {}) =>
    service().mintForUser({
        secret: TEST_SECRET,
        user,
        projectUuid: 'project-uuid',
        audit: { source: 'investigate' },
        ...extra,
    });

describe('agent flag', () => {
    it('is false for a person', async () => {
        expect(decodeToken(await mint()).agent).toBe(false);
        expect(decodeToken(await mint({ agentSession: false })).agent).toBe(
            false,
        );
    });

    it('is true for an explicit agent session', async () => {
        expect(decodeToken(await mint({ agentSession: true })).agent).toBe(
            true,
        );
    });

    it('is true inside an agent execution context', async () => {
        const token = await agentExecutionContext.run(
            createAgentExecutionContext({
                account: buildAccount(),
                surface: AgentActorSurface.MCP,
                clientId: null,
                agentUuid: 'ldq-test-agent',
                agentIdentityEnabled: true,
            }),
            () => mint(),
        );
        const payload = decodeToken(token);
        expect(payload.agent).toBe(true);
        expect(payload.sys).toBe(false);
        // The attribute is still reported; the engine refuses restricted reads to agents.
        expect(payload.attrs.telemetry_restricted).toBe(true);
    });
});
