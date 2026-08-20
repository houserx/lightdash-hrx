import { fc, test } from '@fast-check/vitest';
import {
    DirectResourceAccessOrigin,
    OrganizationMemberRole,
    SpaceMemberRole,
} from '@lightdash/common';
import { lightdashConfigMock } from '../../config/lightdashConfig.mock';
import { ResourceAccessModel } from '../../models/ResourceAccessModel';
import { SpaceModel } from '../../models/SpaceModel';
import { SpacePermissionModel } from '../../models/SpacePermissionModel';
import { SpacePermissionService } from './SpacePermissionService';

const USER_UUID = 'user-1';
const ORGANIZATION_UUID = 'org-1';
const PROJECT_UUID = 'project-1';
const SPACE_UUID = 'space-1';
const DASHBOARD_A = 'dashboard-a';
const DASHBOARD_B = 'dashboard-b';

/** Enough of SpacePermissionModel for getSpacesCaslContext to resolve one space. */
const createMockPermissionModel = (spaceUuids: string[]) => ({
    getInheritanceChains: vi.fn(async () =>
        Object.fromEntries(
            spaceUuids.map((spaceUuid) => [
                spaceUuid,
                {
                    chain: [
                        {
                            spaceUuid,
                            spaceName: 'Space',
                            inheritParentPermissions: true,
                        },
                    ],
                    inheritsFromOrgOrProject: true,
                },
            ]),
        ),
    ),
    getSpaceInfo: vi.fn(async () =>
        Object.fromEntries(
            spaceUuids.map((spaceUuid) => [
                spaceUuid,
                {
                    projectUuid: PROJECT_UUID,
                    organizationUuid: ORGANIZATION_UUID,
                    inheritParentPermissions: true,
                },
            ]),
        ),
    ),
    getDirectSpaceAccess: vi.fn(async () => ({})),
    getProjectSpaceAccess: vi.fn(async () => ({})),
    getOrganizationSpaceAccess: vi.fn(async () =>
        Object.fromEntries(
            spaceUuids.map((spaceUuid) => [
                spaceUuid,
                [
                    {
                        userUuid: USER_UUID,
                        spaceUuid,
                        role: OrganizationMemberRole.VIEWER,
                        roleUuid: null,
                        // main spreads this when collecting custom-role uuids,
                        // so omitting it is a TypeError, not a missing field.
                        extraRoleUuids: [],
                    },
                ],
            ]),
        ),
    ),
    getRoleScopes: vi.fn(async () => ({})),
});

const grant = (resourceUuid: string, action: 'view' | 'manage') => ({
    userUuid: USER_UUID,
    resourceUuid,
    groupUuid: null,
    action,
    from: DirectResourceAccessOrigin.USER_ACCESS,
});

const buildService = ({
    enabled,
    grants = {},
    spaceUuids = [SPACE_UUID],
}: {
    enabled: boolean;
    grants?: Record<string, ReturnType<typeof grant>[]>;
    spaceUuids?: string[];
}) => {
    const permissionModel = createMockPermissionModel(spaceUuids);
    const getDirectResourceAccess = vi.fn(async () => grants);
    const service = new SpacePermissionService(
        {} as SpaceModel,
        permissionModel as unknown as SpacePermissionModel,
        { getDirectResourceAccess } as unknown as ResourceAccessModel,
        {
            ...lightdashConfigMock,
            resourceGrants: { enabled },
        },
    );
    return { service, getDirectResourceAccess };
};

describe('SpacePermissionService resource access context', () => {
    afterEach(() => {
        vi.resetAllMocks();
    });

    describe('given resource grants are disabled', () => {
        it('then no grant query is issued', async () => {
            const { service, getDirectResourceAccess } = buildService({
                enabled: false,
            });

            await service.getResourceAccessContext(USER_UUID, 'Dashboard', {
                resourceUuid: DASHBOARD_A,
                spaceUuid: SPACE_UUID,
            });

            expect(getDirectResourceAccess).not.toHaveBeenCalled();
        });

        it('then the context is exactly the space access context', async () => {
            const { service } = buildService({ enabled: false });

            const context = await service.getResourceAccessContext(
                USER_UUID,
                'Dashboard',
                { resourceUuid: DASHBOARD_A, spaceUuid: SPACE_UUID },
            );

            expect(context.access).toHaveLength(1);
            expect(context.access[0]).toEqual(
                expect.objectContaining({
                    userUuid: USER_UUID,
                    role: SpaceMemberRole.VIEWER,
                }),
            );
        });
    });

    describe('given resource grants are enabled but none exist', () => {
        it('then the resolved access is unchanged', async () => {
            const { service } = buildService({ enabled: true, grants: {} });

            const context = await service.getResourceAccessContext(
                USER_UUID,
                'Dashboard',
                { resourceUuid: DASHBOARD_A, spaceUuid: SPACE_UUID },
            );

            expect(context.access).toHaveLength(1);
            expect(context.access[0].role).toBe(SpaceMemberRole.VIEWER);
        });
    });

    describe('given a manage grant on the resource', () => {
        it('then the resolved role is upgraded and attributed to the resource', async () => {
            const { service } = buildService({
                enabled: true,
                grants: { [DASHBOARD_A]: [grant(DASHBOARD_A, 'manage')] },
            });

            const context = await service.getResourceAccessContext(
                USER_UUID,
                'Dashboard',
                { resourceUuid: DASHBOARD_A, spaceUuid: SPACE_UUID },
            );

            expect(context.access).toHaveLength(1);
            expect(context.access[0].role).toBe(SpaceMemberRole.EDITOR);
            expect(context.access[0].inheritedFrom).toBe('direct_resource');
        });

        it('then the organization and project of the space are preserved', async () => {
            const { service } = buildService({
                enabled: true,
                grants: { [DASHBOARD_A]: [grant(DASHBOARD_A, 'manage')] },
            });

            const context = await service.getResourceAccessContext(
                USER_UUID,
                'Dashboard',
                { resourceUuid: DASHBOARD_A, spaceUuid: SPACE_UUID },
            );

            expect(context.organizationUuid).toBe(ORGANIZATION_UUID);
            expect(context.projectUuid).toBe(PROJECT_UUID);
        });
    });

    describe('given two resources in the same space', () => {
        it('then each gets its own context keyed by resource uuid', async () => {
            const { service } = buildService({
                enabled: true,
                grants: { [DASHBOARD_A]: [grant(DASHBOARD_A, 'manage')] },
            });

            const contexts = await service.getResourceAccessContexts(
                USER_UUID,
                'Dashboard',
                [
                    { resourceUuid: DASHBOARD_A, spaceUuid: SPACE_UUID },
                    { resourceUuid: DASHBOARD_B, spaceUuid: SPACE_UUID },
                ],
            );

            // Sharing a space must not mean sharing a grant.
            expect(contexts[DASHBOARD_A].access[0].role).toBe(
                SpaceMemberRole.EDITOR,
            );
            expect(contexts[DASHBOARD_B].access[0].role).toBe(
                SpaceMemberRole.VIEWER,
            );
        });

        it('then the grants for the whole batch are read in one call', async () => {
            const { service, getDirectResourceAccess } = buildService({
                enabled: true,
            });

            await service.getResourceAccessContexts(USER_UUID, 'Dashboard', [
                { resourceUuid: DASHBOARD_A, spaceUuid: SPACE_UUID },
                { resourceUuid: DASHBOARD_B, spaceUuid: SPACE_UUID },
            ]);

            expect(getDirectResourceAccess).toHaveBeenCalledTimes(1);
        });
    });

    describe('given a resource whose space has no access context', () => {
        it('then it is omitted rather than defaulting open', async () => {
            const { service } = buildService({
                enabled: true,
                spaceUuids: [],
            });

            const contexts = await service.getResourceAccessContexts(
                USER_UUID,
                'Dashboard',
                [{ resourceUuid: DASHBOARD_A, spaceUuid: 'missing-space' }],
            );

            expect(contexts[DASHBOARD_A]).toBeUndefined();
        });
    });
});

/**
 * The resolved, paginated access list behind the sharing UI.
 *
 * Pagination runs over user metadata scoped to an already-resolved uuid set, not
 * over space-access rows -- so grant-derived principals must be folded in BEFORE
 * that call, or page counts describe a different population than the page does.
 */
describe('SpacePermissionService paginated resource access', () => {
    afterEach(() => {
        vi.resetAllMocks();
    });

    const SPACE_USER = 'space-user';
    const GRANT_USER = 'grant-user';

    const buildPaginatedService = ({
        enabled,
        grants = [],
        spaceUsers = [SPACE_USER],
    }: {
        enabled: boolean;
        grants?: ReturnType<typeof grant>[];
        spaceUsers?: string[];
    }) => {
        const permissionModel = {
            ...createMockPermissionModel([SPACE_UUID]),
            getPaginatedUserMetadata: vi.fn(async (userUuids: string[]) => ({
                data: userUuids.map((userUuid) => ({
                    userUuid,
                    firstName: 'A',
                    lastName: 'B',
                    email: `${userUuid}@example.com`,
                })),
            })),
        };
        const getAllDirectResourceAccess = vi.fn(async () => grants);
        const service = new SpacePermissionService(
            {} as SpaceModel,
            permissionModel as unknown as SpacePermissionModel,
            {
                getAllDirectResourceAccess,
            } as unknown as ResourceAccessModel,
            {
                ...lightdashConfigMock,
                resourceGrants: { enabled },
            },
        );
        return { service, permissionModel, getAllDirectResourceAccess };
    };

    const list = (
        service: SpacePermissionService,
        filters?: { userUuids?: string[]; directOnly?: boolean },
    ) =>
        service.getPaginatedResourceAccess(
            'Dashboard',
            { resourceUuid: DASHBOARD_A, spaceUuid: SPACE_UUID },
            { filters },
        );

    describe('given resource grants are disabled', () => {
        it('then no grant lookup is issued', async () => {
            const { service, getAllDirectResourceAccess } =
                buildPaginatedService({ enabled: false });

            await list(service);

            expect(getAllDirectResourceAccess).not.toHaveBeenCalled();
        });
    });

    describe('given a grant to someone with no access to the space', () => {
        const outsiderGrant = {
            ...grant(DASHBOARD_A, 'view'),
            userUuid: GRANT_USER,
        };

        it('then they appear in the list', async () => {
            const { service } = buildPaginatedService({
                enabled: true,
                grants: [outsiderGrant],
            });

            const { data } = await list(service);

            expect(data.map(({ userUuid }) => userUuid)).toContain(GRANT_USER);
        });

        it('then the entry is attributed to the resource, not the space', async () => {
            const { service } = buildPaginatedService({
                enabled: true,
                grants: [outsiderGrant],
            });

            const { data } = await list(service);
            const entry = data.find(({ userUuid }) => userUuid === GRANT_USER);

            // The field the sharing UI reads to label where access came from.
            expect(entry?.inheritedFrom).toBe('direct_resource');
            expect(entry?.hasDirectAccess).toBe(true);
        });

        it('then they are counted before metadata is paginated', async () => {
            const { service, permissionModel } = buildPaginatedService({
                enabled: true,
                grants: [outsiderGrant],
            });

            await list(service);

            const [paginatedUuids] =
                permissionModel.getPaginatedUserMetadata.mock.calls[0];
            expect(paginatedUuids).toContain(GRANT_USER);
        });
    });

    describe('given a grant to someone who already reaches the resource', () => {
        it('then they appear once, attributed to whichever source decided the role', async () => {
            // USER_UUID already resolves to VIEWER through the organisation, so
            // a `view` grant adds nothing and must not re-label where access
            // came from -- only a grant that raises the role does that.
            const { service } = buildPaginatedService({
                enabled: true,
                grants: [grant(DASHBOARD_A, 'view')],
            });

            const { data } = await list(service);
            const entries = data.filter(
                ({ userUuid }) => userUuid === USER_UUID,
            );

            expect(entries).toHaveLength(1);
            expect(entries[0].inheritedFrom).toBe('organization');
        });

        it('then a grant that raises their role is attributed to the resource', async () => {
            const { service } = buildPaginatedService({
                enabled: true,
                grants: [grant(DASHBOARD_A, 'manage')],
            });

            const { data } = await list(service);
            const entry = data.find(({ userUuid }) => userUuid === USER_UUID);

            expect(entry?.role).toBe(SpaceMemberRole.EDITOR);
            expect(entry?.inheritedFrom).toBe('direct_resource');
        });
    });

    describe('given a userUuids filter', () => {
        it('then a grant holder outside it does not leak in', async () => {
            // The space side is filtered in SQL, but grants are read for the
            // whole resource -- so the filter has to be re-applied after merging.
            const { service } = buildPaginatedService({
                enabled: true,
                grants: [grant(DASHBOARD_A, 'view')],
            });

            const { data } = await list(service, {
                userUuids: [GRANT_USER],
            });

            expect(data.map(({ userUuid }) => userUuid)).not.toContain(
                USER_UUID,
            );
        });
    });

    // The single-grant scenarios above pin the ordering for one shape. This
    // generalises them: however many principals hold a grant, and whoever they
    // are, all of them must be present in the uuid set pagination counts over.
    // Folding grants in after that call would satisfy every example test above
    // and still fail this one as soon as a second grant holder exists.
    test.prop([
        fc.uniqueArray(
            fc
                .string({ minLength: 1, maxLength: 12 })
                .map((s) => `grantee-${s}`),
            { minLength: 1, maxLength: 15 },
        ),
    ])(
        'counts every grant holder, whoever and however many they are',
        async (granteeUuids) => {
            const { service, permissionModel } = buildPaginatedService({
                enabled: true,
                grants: granteeUuids.map((userUuid) => ({
                    ...grant(DASHBOARD_A, 'view'),
                    userUuid,
                })),
            });

            await list(service);

            const [paginatedUuids] =
                permissionModel.getPaginatedUserMetadata.mock.calls[0];

            expect(
                granteeUuids.every((uuid) => paginatedUuids.includes(uuid)),
            ).toBe(true);
            // And nobody is counted twice, or the totals overstate the page.
            expect(new Set(paginatedUuids).size).toBe(paginatedUuids.length);
        },
    );

    describe('given every entry that comes back', () => {
        it('then each one carries a recognised provenance', async () => {
            const { service } = buildPaginatedService({
                enabled: true,
                grants: [grant(DASHBOARD_A, 'manage')],
            });

            const { data } = await list(service);

            const known = [
                'organization',
                'project',
                'group',
                'space_group',
                'parent_space',
                'direct_resource',
                undefined,
            ];
            expect(
                data.every((entry) => known.includes(entry.inheritedFrom)),
            ).toBe(true);
        });
    });
});
