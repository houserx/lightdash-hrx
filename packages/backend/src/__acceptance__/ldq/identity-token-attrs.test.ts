// ldq-identity-token-user-attrs: the token is built from the requesting user and their
// Lightdash user attributes; only the value "true" is true (CONTRACTS §3).
import { load } from './load';
import { decodeToken, hasValidSignature, TEST_SECRET } from './tokens';

let FederationIdentityService: any;

beforeAll(async () => {
    ({ FederationIdentityService } = await load(
        '../../services/FederationIdentity/FederationIdentityService',
    ));
}, 120_000);

const user = {
    userUuid: '3f6e1a2b-0000-4000-8000-000000000001',
    email: 'support.person@example.com',
    organizationUuid: '0b1c2d3e-0000-4000-8000-0000000000aa',
};

const serviceWith = (attributes: Record<string, string[]>) => {
    const getAttributeValuesForOrgMember = vi.fn(async () => attributes);
    const service = new FederationIdentityService({
        userAttributesModel: { getAttributeValuesForOrgMember },
        clock: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    return { service, getAttributeValuesForOrgMember };
};

describe('FederationIdentityService.mintForUser attributes', () => {
    it('reads the user attributes of the requesting user in their org', async () => {
        const { service, getAttributeValuesForOrgMember } = serviceWith({
            telemetry_restricted: ['true'],
            platform_read: ['true'],
            platform_write: ['yes'],
            platform_explain: ['True'],
            department: ['support'],
        });
        const token = await service.mintForUser({
            secret: TEST_SECRET,
            user,
            projectUuid: '7a8b9c0d-0000-4000-8000-0000000000bb',
            audit: { source: 'investigate' },
        });
        expect(getAttributeValuesForOrgMember).toHaveBeenCalledWith({
            organizationUuid: user.organizationUuid,
            userUuid: user.userUuid,
        });
        expect(hasValidSignature(token)).toBe(true);
        const payload = decodeToken(token);
        expect(payload).toMatchObject({
            v: 1,
            iss: 'lightdash',
            sub: user.userUuid,
            email: user.email,
            org: user.organizationUuid,
            project: '7a8b9c0d-0000-4000-8000-0000000000bb',
            sys: false,
            iat: 1767225600,
            exp: 1767225900,
        });
        expect(payload.attrs).toEqual({
            telemetry_restricted: true,
            platform_read: true,
            platform_write: false,
            platform_explain: false,
        });
    });

    it('treats missing attributes as false', async () => {
        const { service } = serviceWith({});
        const payload = decodeToken(
            await service.mintForUser({
                secret: TEST_SECRET,
                user,
                projectUuid: 'project-uuid',
                audit: { source: 'tile' },
            }),
        );
        expect(payload.attrs).toEqual({
            telemetry_restricted: false,
            platform_read: false,
            platform_write: false,
            platform_explain: false,
        });
    });

    it('maps attribute values directly', async () => {
        const identity = await load(
            '../../services/FederationIdentity/identityToken',
        );
        expect(
            identity.identityAttrsFromUserAttributes({
                platform_read: ['false', 'true'],
                platform_write: [],
                platform_explain: ['true'],
            }),
        ).toEqual({
            telemetry_restricted: false,
            platform_read: true,
            platform_write: false,
            platform_explain: true,
        });
    });
});
