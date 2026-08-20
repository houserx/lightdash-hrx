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
