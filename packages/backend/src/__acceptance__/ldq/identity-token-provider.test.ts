// ldq-identity-token-provider: the backend hands FederationWarehouseClient a token provider
// (WarehouseClientOptions.getIdentityToken) that mints a fresh, valid token per query.
import { load } from './load';
import { decodeToken, hasValidSignature, TEST_SECRET } from './tokens';

let FederationIdentityService: any;

beforeAll(async () => {
    ({ FederationIdentityService } = await load(
        '../../services/FederationIdentity/FederationIdentityService',
    ));
}, 120_000);

describe('createTokenProvider', () => {
    it('mints a fresh signed token on every call', async () => {
        const service = new FederationIdentityService({
            userAttributesModel: {
                getAttributeValuesForOrgMember: vi.fn(async () => ({
                    platform_read: ['true'],
                })),
            },
        });
        const provider = service.createTokenProvider({
            secret: TEST_SECRET,
            user: {
                userUuid: 'user-uuid',
                email: 'support.person@example.com',
                organizationUuid: 'org-uuid',
            },
            projectUuid: 'project-uuid',
            audit: { source: 'investigate', description: 'Checking a refill' },
        });
        const first: string = await provider({ agent: false });
        const second: string = await provider({ agent: false });
        expect(first).not.toBe(second);
        for (const token of [first, second]) {
            expect(hasValidSignature(token)).toBe(true);
            expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        }
        expect(decodeToken(first).nonce).not.toBe(decodeToken(second).nonce);
        expect(decodeToken(first)).toMatchObject({
            sub: 'user-uuid',
            project: 'project-uuid',
            attrs: { platform_read: true },
            audit: { source: 'investigate', description: 'Checking a refill' },
        });
    });

    it('marks the token as an agent when the client reports an agent session', async () => {
        const service = new FederationIdentityService({
            userAttributesModel: {
                getAttributeValuesForOrgMember: vi.fn(async () => ({})),
            },
        });
        const provider = service.createTokenProvider({
            secret: TEST_SECRET,
            user: {
                userUuid: 'user-uuid',
                email: 'support.person@example.com',
                organizationUuid: 'org-uuid',
            },
            projectUuid: 'project-uuid',
            audit: { source: 'tile' },
        });
        expect(decodeToken(await provider({ agent: true })).agent).toBe(true);
    });
});
