// ldq-identity-token-audit-block: the audit block carries the Audited Query description, the
// optional Linear ticket, the source and the tile/rule uuid.
import { load } from './load';
import { decodeToken, TEST_SECRET } from './tokens';

let FederationIdentityService: any;

beforeAll(async () => {
    ({ FederationIdentityService } = await load(
        '../../services/FederationIdentity/FederationIdentityService',
    ));
}, 120_000);

const service = () =>
    new FederationIdentityService({
        userAttributesModel: {
            getAttributeValuesForOrgMember: vi.fn(async () => ({})),
        },
    });

const user = {
    userUuid: 'user-uuid',
    email: 'support.person@example.com',
    organizationUuid: 'org-uuid',
};

describe('audit block', () => {
    it('carries an Investigate description and ticket', async () => {
        const payload = decodeToken(
            await service().mintForUser({
                secret: TEST_SECRET,
                user,
                projectUuid: 'project-uuid',
                audit: {
                    source: 'investigate',
                    description: 'Why did refill 42 fail?',
                    ticket: 'ENG-123',
                },
            }),
        );
        expect(payload.audit).toEqual({
            description: 'Why did refill 42 fail?',
            ticket: 'ENG-123',
            source: 'investigate',
            resource_uuid: null,
        });
    });

    it('carries the tile uuid for a tile query', async () => {
        const payload = decodeToken(
            await service().mintForUser({
                secret: TEST_SECRET,
                user,
                projectUuid: 'project-uuid',
                audit: {
                    source: 'tile',
                    resource_uuid: '9d8c7b6a-0000-4000-8000-0000000000cc',
                },
            }),
        );
        expect(payload.audit).toEqual({
            description: null,
            ticket: null,
            source: 'tile',
            resource_uuid: '9d8c7b6a-0000-4000-8000-0000000000cc',
        });
    });

    it('rejects an unknown audit source', async () => {
        await expect(
            service().mintForUser({
                secret: TEST_SECRET,
                user,
                projectUuid: 'project-uuid',
                audit: { source: 'dashboard' },
            }),
        ).rejects.toThrow();
    });
});
