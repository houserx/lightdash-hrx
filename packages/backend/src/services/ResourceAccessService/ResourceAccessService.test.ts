import {
    defineUserAbility,
    ForbiddenError,
    OrganizationMemberRole,
    ParameterError,
    type SessionUser,
} from '@lightdash/common';
import { DashboardModel } from '../../models/DashboardModel/DashboardModel';
import { ResourceAccessModel } from '../../models/ResourceAccessModel';
import { SavedChartModel } from '../../models/SavedChartModel';
import { SpacePermissionService } from '../SpaceService/SpacePermissionService';
import { ResourceAccessService } from './ResourceAccessService';

const ORGANIZATION_UUID = 'org-1';
const PROJECT_UUID = 'project-1';
const SPACE_UUID = 'space-1';
const DASHBOARD_UUID = 'dashboard-1';
const GRANTEE_UUID = 'grantee-1';
const GROUP_UUID = 'group-1';

const userWithRole = (role: OrganizationMemberRole): SessionUser =>
    ({
        userUuid: 'granter-1',
        organizationUuid: ORGANIZATION_UUID,
        role,
        ability: defineUserAbility(
            {
                userUuid: 'granter-1',
                role,
                organizationUuid: ORGANIZATION_UUID,
            },
            [],
        ),
    }) as unknown as SessionUser;

const buildService = ({
    granterRole = OrganizationMemberRole.ADMIN,
    userInOrganization = true,
    groupInOrganization = true,
}: {
    granterRole?: OrganizationMemberRole;
    userInOrganization?: boolean;
    groupInOrganization?: boolean;
} = {}) => {
    const resourceAccessModel = {
        addUserAccess: vi.fn(async () => undefined),
        addGroupAccess: vi.fn(async () => undefined),
        removeUserAccess: vi.fn(async () => undefined),
        removeGroupAccess: vi.fn(async () => undefined),
        listResourceAccess: vi.fn(async () => ({ users: [], groups: [] })),
        isUserInOrganization: vi.fn(async () => userInOrganization),
        isGroupInOrganization: vi.fn(async () => groupInOrganization),
    };
    const spacePermissionService = {
        getResourceAccessContext: vi.fn(async () => ({
            organizationUuid: ORGANIZATION_UUID,
            projectUuid: PROJECT_UUID,
            inheritsFromOrgOrProject: true,
            access: [],
            admins: [],
        })),
    };
    const service = new ResourceAccessService({
        dashboardModel: {
            getByIdOrSlug: vi.fn(async () => ({
                uuid: DASHBOARD_UUID,
                name: 'Revenue',
                spaceUuid: SPACE_UUID,
                projectUuid: PROJECT_UUID,
                organizationUuid: ORGANIZATION_UUID,
            })),
        } as unknown as DashboardModel,
        savedChartModel: {} as unknown as SavedChartModel,
        resourceAccessModel:
            resourceAccessModel as unknown as ResourceAccessModel,
        spacePermissionService:
            spacePermissionService as unknown as SpacePermissionService,
    });
    return {
        service,
        resourceAccessModel,
        spacePermissionService,
        granter: userWithRole(granterRole),
    };
};

describe('ResourceAccessService', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('given the granter holds the action they are granting', () => {
        it('then the grant is persisted against the resource own project', async () => {
            const { service, resourceAccessModel, granter } = buildService();

            await service.grantUserAccess(granter, {
                resourceType: 'Dashboard',
                resourceUuid: DASHBOARD_UUID,
                targetUserUuid: GRANTEE_UUID,
                action: 'view',
            });

            expect(resourceAccessModel.addUserAccess).toHaveBeenCalledWith({
                resourceType: 'Dashboard',
                resourceUuid: DASHBOARD_UUID,
                projectUuid: PROJECT_UUID,
                targetUserUuid: GRANTEE_UUID,
                action: 'view',
                grantedByUserUuid: granter.userUuid,
            });
        });

        it('then their own access is resolved for the resource, so a grant counts toward granting authority', async () => {
            const { service, spacePermissionService, granter } = buildService();

            await service.grantUserAccess(granter, {
                resourceType: 'Dashboard',
                resourceUuid: DASHBOARD_UUID,
                targetUserUuid: GRANTEE_UUID,
                action: 'view',
            });

            expect(
                spacePermissionService.getResourceAccessContext,
            ).toHaveBeenCalledWith(
                granter.userUuid,
                'Dashboard',
                expect.objectContaining({
                    resourceUuid: DASHBOARD_UUID,
                    spaceUuid: SPACE_UUID,
                }),
            );
        });
    });

    describe('given the granter does not hold the action', () => {
        it('then the grant is forbidden', async () => {
            const { service, granter } = buildService({
                granterRole: OrganizationMemberRole.MEMBER,
            });

            await expect(
                service.grantUserAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetUserUuid: GRANTEE_UUID,
                    action: 'manage',
                }),
            ).rejects.toThrowError(ForbiddenError);
        });

        it('then nothing is persisted and membership is never probed', async () => {
            const { service, resourceAccessModel, granter } = buildService({
                granterRole: OrganizationMemberRole.MEMBER,
            });

            await expect(
                service.grantUserAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetUserUuid: GRANTEE_UUID,
                    action: 'manage',
                }),
            ).rejects.toThrowError(ForbiddenError);

            expect(resourceAccessModel.addUserAccess).not.toHaveBeenCalled();
            // Ordered after the permission check so this endpoint cannot be
            // used to probe whether a uuid belongs to an organization.
            expect(
                resourceAccessModel.isUserInOrganization,
            ).not.toHaveBeenCalled();
        });
    });

    describe('given the recipient is outside the resource organization', () => {
        it('then a user grant is rejected and nothing is persisted', async () => {
            const { service, resourceAccessModel, granter } = buildService({
                userInOrganization: false,
            });

            await expect(
                service.grantUserAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetUserUuid: GRANTEE_UUID,
                    action: 'view',
                }),
            ).rejects.toThrowError(ParameterError);

            expect(resourceAccessModel.addUserAccess).not.toHaveBeenCalled();
        });

        it('then membership is checked against the resource organization', async () => {
            const { service, resourceAccessModel, granter } = buildService();

            await service.grantUserAccess(granter, {
                resourceType: 'Dashboard',
                resourceUuid: DASHBOARD_UUID,
                targetUserUuid: GRANTEE_UUID,
                action: 'view',
            });

            expect(
                resourceAccessModel.isUserInOrganization,
            ).toHaveBeenCalledWith(ORGANIZATION_UUID, GRANTEE_UUID);
        });

        it('then a group grant is rejected and nothing is persisted', async () => {
            const { service, resourceAccessModel, granter } = buildService({
                groupInOrganization: false,
            });

            await expect(
                service.grantGroupAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetGroupUuid: GROUP_UUID,
                    action: 'view',
                }),
            ).rejects.toThrowError(ParameterError);

            expect(resourceAccessModel.addGroupAccess).not.toHaveBeenCalled();
        });
    });

    describe('given a revoke', () => {
        it('then it requires the same action being revoked, not blanket manage', async () => {
            const { service, resourceAccessModel, granter } = buildService();

            await service.revokeUserAccess(granter, {
                resourceType: 'Dashboard',
                resourceUuid: DASHBOARD_UUID,
                targetUserUuid: GRANTEE_UUID,
                action: 'view',
            });

            expect(resourceAccessModel.removeUserAccess).toHaveBeenCalledWith({
                resourceType: 'Dashboard',
                resourceUuid: DASHBOARD_UUID,
                targetUserUuid: GRANTEE_UUID,
                action: 'view',
            });
        });

        it('then a revoker without the action is forbidden', async () => {
            const { service, granter } = buildService({
                granterRole: OrganizationMemberRole.MEMBER,
            });

            await expect(
                service.revokeUserAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetUserUuid: GRANTEE_UUID,
                    action: 'manage',
                }),
            ).rejects.toThrowError(ForbiddenError);
        });

        it('then revoking does not require the recipient to still be an org member', async () => {
            // Offboarded users must remain revocable.
            const { service, resourceAccessModel, granter } = buildService({
                userInOrganization: false,
            });

            await service.revokeUserAccess(granter, {
                resourceType: 'Dashboard',
                resourceUuid: DASHBOARD_UUID,
                targetUserUuid: GRANTEE_UUID,
                action: 'view',
            });

            expect(resourceAccessModel.removeUserAccess).toHaveBeenCalled();
        });
    });

    describe('given a listing', () => {
        it('then it requires view on the resource', async () => {
            const { service, granter } = buildService({
                granterRole: OrganizationMemberRole.MEMBER,
            });

            await expect(
                service.listResourceAccess(
                    granter,
                    'Dashboard',
                    DASHBOARD_UUID,
                ),
            ).rejects.toThrowError(ForbiddenError);
        });

        it('then it returns the grants held on the resource', async () => {
            const { service, resourceAccessModel, granter } = buildService();

            const result = await service.listResourceAccess(
                granter,
                'Dashboard',
                DASHBOARD_UUID,
            );

            expect(resourceAccessModel.listResourceAccess).toHaveBeenCalledWith(
                'Dashboard',
                DASHBOARD_UUID,
            );
            expect(result).toEqual({ users: [], groups: [] });
        });
    });
});
