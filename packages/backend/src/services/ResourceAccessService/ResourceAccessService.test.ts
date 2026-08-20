import {
    defineUserAbility,
    ForbiddenError,
    OrganizationMemberRole,
    ParameterError,
    type SessionUser,
} from '@lightdash/common';
import { lightdashConfigMock } from '../../config/lightdashConfig.mock';
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
    resourceGrantsEnabled = true,
}: {
    granterRole?: OrganizationMemberRole;
    userInOrganization?: boolean;
    groupInOrganization?: boolean;
    resourceGrantsEnabled?: boolean;
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
        lightdashConfig: {
            ...lightdashConfigMock,
            resourceGrants: { enabled: resourceGrantsEnabled },
        },
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

    describe('given the granter can manage the resource', () => {
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

        it('then their own access is resolved for the resource, so a manage grant counts toward granting authority', async () => {
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

    describe('given the granter can only view the resource', () => {
        // The case that matters most, and the one this suite did not have. Before
        // administering grants required `manage`, a viewer passed the check for a
        // `view` grant simply by being able to see the resource -- so anyone who
        // could open a dashboard could widen access to it, and a user whose own
        // way in was a view grant could pass it on. Space sharing has never
        // allowed that: it requires manage on the space.
        it('then granting view is forbidden, even though they can view', async () => {
            const { service, granter } = buildService({
                granterRole: OrganizationMemberRole.VIEWER,
            });

            await expect(
                service.grantUserAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetUserUuid: GRANTEE_UUID,
                    action: 'view',
                }),
            ).rejects.toThrowError(ForbiddenError);
        });

        it('then nothing is persisted and membership is never probed', async () => {
            const { service, resourceAccessModel, granter } = buildService({
                granterRole: OrganizationMemberRole.VIEWER,
            });

            await expect(
                service.grantUserAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetUserUuid: GRANTEE_UUID,
                    action: 'view',
                }),
            ).rejects.toThrowError(ForbiddenError);

            expect(resourceAccessModel.addUserAccess).not.toHaveBeenCalled();
            expect(
                resourceAccessModel.isUserInOrganization,
            ).not.toHaveBeenCalled();
        });

        it('then granting view to a group is forbidden too', async () => {
            const { service, resourceAccessModel, granter } = buildService({
                granterRole: OrganizationMemberRole.VIEWER,
            });

            await expect(
                service.grantGroupAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetGroupUuid: GROUP_UUID,
                    action: 'view',
                }),
            ).rejects.toThrowError(ForbiddenError);

            expect(resourceAccessModel.addGroupAccess).not.toHaveBeenCalled();
        });

        it("then revoking somebody else's view grant is forbidden", async () => {
            // The other half: revoke authority was the action being revoked, so a
            // viewer could strip other people's access to anything they could see.
            const { service, resourceAccessModel, granter } = buildService({
                granterRole: OrganizationMemberRole.VIEWER,
            });

            await expect(
                service.revokeUserAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetUserUuid: GRANTEE_UUID,
                    action: 'view',
                }),
            ).rejects.toThrowError(ForbiddenError);

            expect(resourceAccessModel.removeUserAccess).not.toHaveBeenCalled();
        });

        it('then they cannot read who else has access', async () => {
            // Reading is held to the same bar as writing: this is a grant
            // administration surface, and the list names who was individually
            // singled out plus who granted it. Item J only offers it behind the
            // same manage check, so there is no product surface this closes.
            const { service, granter } = buildService({
                granterRole: OrganizationMemberRole.VIEWER,
            });

            await expect(
                service.listResourceAccess(
                    granter,
                    'Dashboard',
                    DASHBOARD_UUID,
                ),
            ).rejects.toThrowError(ForbiddenError);
        });
    });

    describe('given the granter cannot manage the resource', () => {
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
        it('then a manager may revoke any action, including one they were not granted', async () => {
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

        it('then a revoker who cannot manage the resource is forbidden', async () => {
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
        it('then it requires manage on the resource', async () => {
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

    describe('given direct resource grants are disabled', () => {
        // While the feature is off, permission resolution skips the grant lookup
        // entirely -- so a grant written now changes nobody's access. Accepting the
        // write anyway is worse than refusing it: it reports success for something
        // that silently does nothing, and leaves rows behind that start mattering
        // the moment an operator flips the flag.
        it('then granting is refused even for an admin', async () => {
            const { service, resourceAccessModel, granter } = buildService({
                resourceGrantsEnabled: false,
            });

            await expect(
                service.grantUserAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetUserUuid: GRANTEE_UUID,
                    action: 'view',
                }),
            ).rejects.toThrowError(ForbiddenError);

            expect(resourceAccessModel.addUserAccess).not.toHaveBeenCalled();
        });

        it('then granting to a group is refused', async () => {
            const { service, resourceAccessModel, granter } = buildService({
                resourceGrantsEnabled: false,
            });

            await expect(
                service.grantGroupAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetGroupUuid: GROUP_UUID,
                    action: 'view',
                }),
            ).rejects.toThrowError(ForbiddenError);

            expect(resourceAccessModel.addGroupAccess).not.toHaveBeenCalled();
        });

        it('then revoking is refused too, and no resource is even resolved', async () => {
            // Refused before the resource is looked up, so a disabled instance
            // cannot be used to probe which uuids exist.
            const { service, resourceAccessModel, granter } = buildService({
                resourceGrantsEnabled: false,
            });

            await expect(
                service.revokeUserAccess(granter, {
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_UUID,
                    targetUserUuid: GRANTEE_UUID,
                    action: 'view',
                }),
            ).rejects.toThrowError(ForbiddenError);

            expect(resourceAccessModel.removeUserAccess).not.toHaveBeenCalled();
        });

        it('then listing is refused', async () => {
            const { service, resourceAccessModel, granter } = buildService({
                resourceGrantsEnabled: false,
            });

            await expect(
                service.listResourceAccess(
                    granter,
                    'Dashboard',
                    DASHBOARD_UUID,
                ),
            ).rejects.toThrowError(ForbiddenError);

            expect(
                resourceAccessModel.listResourceAccess,
            ).not.toHaveBeenCalled();
        });
    });
});
