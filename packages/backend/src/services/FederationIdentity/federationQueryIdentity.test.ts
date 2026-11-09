import { QuerySurface } from '@lightdash/common';
import { FederationIdentityService } from './FederationIdentityService';
import {
    federationQueryAudit,
    withFederationQueryIdentity,
} from './federationQueryIdentity';
import { verifyIdentityToken } from './identityToken';

const SECRET = 'test-identity-secret-not-real';
const PROJECT_UUID = '0f6c1f7e-3333-4c4c-8a8a-000000000003';
const OTHER_PROJECT_UUID = '0f6c1f7e-3333-4c4c-8a8a-000000000009';
const USER_UUID = '0f6c1f7e-1111-4c4c-8a8a-000000000001';
const ORG_UUID = '0f6c1f7e-2222-4c4c-8a8a-000000000002';
const EMAIL = 'e2e.analyst@example.test';

const createService = (attributes: Record<string, string[]>) =>
    new FederationIdentityService({
        userAttributesModel: {
            getAttributeValuesForOrgMember: vi.fn(async () => attributes),
        },
        userModel: {
            getUserDetailsByUuid: vi.fn(
                async () => ({ email: EMAIL }) as never,
            ),
        },
    });

const identity = {
    userUuid: USER_UUID,
    organizationUuid: ORG_UUID,
    projectUuid: PROJECT_UUID,
    audit: federationQueryAudit(
        { audit: { description: 'Count widgets', ticket: 'ENG-1799' } },
        QuerySurface.APP,
    ),
};

describe('federationQueryAudit', () => {
    it('takes the description and ticket of an Audited Query', () => {
        expect(
            federationQueryAudit(
                { audit: { description: 'why', ticket: 'ENG-1' } },
                QuerySurface.APP,
            ),
        ).toEqual({
            description: 'why',
            ticket: 'ENG-1',
            source: 'investigate',
            resource_uuid: null,
        });
    });

    it('names the MCP surface and defaults the rest to null', () => {
        expect(federationQueryAudit(undefined, QuerySurface.MCP)).toEqual({
            description: null,
            ticket: null,
            source: 'mcp',
            resource_uuid: null,
        });
    });
});

describe('FederationIdentityService.createScopedTokenProvider', () => {
    it('mints a token for the query identity in scope', async () => {
        const provider = createService({
            platform_read: ['true'],
        }).createScopedTokenProvider({
            secret: SECRET,
            projectUuid: PROJECT_UUID,
        });
        const token = await withFederationQueryIdentity(identity, () =>
            provider({ agent: false }),
        );
        expect(token).not.toBeNull();
        expect(verifyIdentityToken(token!, { secret: SECRET })).toMatchObject({
            iss: 'lightdash',
            sub: USER_UUID,
            email: EMAIL,
            org: ORG_UUID,
            project: PROJECT_UUID,
            agent: false,
            attrs: { platform_read: true, telemetry_restricted: false },
            audit: {
                description: 'Count widgets',
                ticket: 'ENG-1799',
                source: 'investigate',
                resource_uuid: null,
            },
        });
    });

    it('has no identity outside a scope or for another project', async () => {
        const provider = createService({}).createScopedTokenProvider({
            secret: SECRET,
            projectUuid: OTHER_PROJECT_UUID,
        });
        expect(await provider({ agent: false })).toBeNull();
        expect(
            await withFederationQueryIdentity(identity, () =>
                provider({ agent: false }),
            ),
        ).toBeNull();
    });

    it('mints a sys token with the given attrs for a system identity', async () => {
        const provider = createService({}).createScopedTokenProvider({
            secret: SECRET,
            projectUuid: PROJECT_UUID,
        });
        const token = await withFederationQueryIdentity(
            {
                system: {
                    sub: 'system:alert-evaluator',
                    email: 'system:alert-evaluator',
                    attrs: {
                        telemetry_restricted: true,
                        platform_read: false,
                        platform_write: false,
                        platform_explain: false,
                    },
                },
                organizationUuid: ORG_UUID,
                projectUuid: PROJECT_UUID,
                audit: {
                    description: 'Queue depth above 100',
                    ticket: null,
                    source: 'alert_rule',
                    resource_uuid: USER_UUID,
                },
            },
            () => provider({ agent: true }),
        );
        expect(verifyIdentityToken(token!, { secret: SECRET })).toMatchObject({
            sub: 'system:alert-evaluator',
            email: 'system:alert-evaluator',
            org: ORG_UUID,
            project: PROJECT_UUID,
            agent: false,
            sys: true,
            attrs: { telemetry_restricted: true, platform_read: false },
            audit: {
                description: 'Queue depth above 100',
                source: 'alert_rule',
                resource_uuid: USER_UUID,
            },
        });
    });
});
