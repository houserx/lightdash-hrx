import {
    defineUserAbility,
    ForbiddenError,
    OrganizationMemberRole,
    ParameterError,
    ProjectMemberRole,
    type AnyType,
    type SessionUser,
} from '@lightdash/common';
import { DashboardModel } from '../../models/DashboardModel/DashboardModel';
import { ResourceAccessModel } from '../../models/ResourceAccessModel';
import { SavedChartModel } from '../../models/SavedChartModel';
import { SpacePermissionService } from '../SpaceService/SpacePermissionService';
import { ResourceAccessService } from './ResourceAccessService';

const createGranter = ({
    projectRole,
    projectUuid = 'project-1',
    organizationUuid = 'org-1',
    userUuid = 'granter-1',
}: {
    projectRole?: ProjectMemberRole;
    projectUuid?: string;
    organizationUuid?: string;
    userUuid?: string;
} = {}): SessionUser =>
    ({
        userUuid,
        ability: defineUserAbility(
            {
                userUuid,
                role: OrganizationMemberRole.MEMBER,
                organizationUuid,
            },
            projectRole
                ? [
                      {
                          projectUuid,
                          role: projectRole,
                          userUuid,
                          roleUuid: undefined,
                      },
                  ]
                : [],
        ),
    }) as unknown as SessionUser;

const dashboardSummary = {
    uuid: 'dashboard-1',
    name: 'My dashboard',
    organizationUuid: 'org-1',
    projectUuid: 'project-1',
    spaceUuid: 'space-1',
};

const chartSummary = {
    uuid: 'chart-1',
    name: 'My chart',
    organizationUuid: 'org-1',
    projectUuid: 'project-1',
    spaceUuid: 'space-1',
};

describe('ResourceAccessService', () => {
    const buildService = ({
        dashboardModel = {
            getByIdOrSlug: vi.fn(async () => dashboardSummary),
        },
        savedChartModel = {
            getSummary: vi.fn(async () => chartSummary),
        },
        resourceAccessModel = {
            addUserAccess: vi.fn(async () => undefined),
            addGroupAccess: vi.fn(async () => undefined),
            removeUserAccess: vi.fn(async () => undefined),
            removeGroupAccess: vi.fn(async () => undefined),
            listAccessForResource: vi.fn(async () => []),
        },
        spacePermissionService = {
            getSpaceAccessContext: vi.fn(async () => ({
                access: null,
                inheritsFromOrgOrProject: true,
            })),
        },
    }: {
        dashboardModel?: AnyType;
        savedChartModel?: AnyType;
        resourceAccessModel?: AnyType;
        spacePermissionService?: AnyType;
    } = {}) => {
        const service = new ResourceAccessService({
            dashboardModel: dashboardModel as unknown as DashboardModel,
            savedChartModel: savedChartModel as unknown as SavedChartModel,
            resourceAccessModel:
                resourceAccessModel as unknown as ResourceAccessModel,
            spacePermissionService:
                spacePermissionService as unknown as SpacePermissionService,
        });
        return {
            service,
            dashboardModel,
            savedChartModel,
            resourceAccessModel,
        };
    };

    describe('grantUserAccess', () => {
        it('persists the grant when the granter already has the action being granted', async () => {
            const { service, resourceAccessModel } = buildService();
            const granter = createGranter({
                projectRole: ProjectMemberRole.VIEWER,
            });

            await service.grantUserAccess(
                granter,
                'Dashboard',
                'dashboard-1',
                'target-user-1',
                'view',
            );

            expect(resourceAccessModel.addUserAccess).toHaveBeenCalledWith({
                userUuid: 'target-user-1',
                resourceUuid: 'dashboard-1',
                resourceType: 'Dashboard',
                projectUuid: 'project-1',
                action: 'view',
                grantedByUserUuid: 'granter-1',
            });
        });

        it('rejects with ForbiddenError when the granter lacks the action being granted (confused deputy)', async () => {
            const { service, resourceAccessModel } = buildService();
            // A viewer can view the dashboard but cannot manage it.
            const granter = createGranter({
                projectRole: ProjectMemberRole.VIEWER,
            });

            await expect(
                service.grantUserAccess(
                    granter,
                    'Dashboard',
                    'dashboard-1',
                    'target-user-1',
                    'manage',
                ),
            ).rejects.toThrow(ForbiddenError);
            expect(resourceAccessModel.addUserAccess).not.toHaveBeenCalled();
        });

        it('rejects with ForbiddenError when the granter has no access to the resource at all', async () => {
            const { service, resourceAccessModel } = buildService();
            const granter = createGranter({ projectRole: undefined });

            await expect(
                service.grantUserAccess(
                    granter,
                    'Dashboard',
                    'dashboard-1',
                    'target-user-1',
                    'view',
                ),
            ).rejects.toThrow(ForbiddenError);
            expect(resourceAccessModel.addUserAccess).not.toHaveBeenCalled();
        });

        it('resolves the resource via SavedChartModel for a SavedChart grant', async () => {
            const { service, resourceAccessModel, savedChartModel } =
                buildService({
                    spacePermissionService: {
                        getSpaceAccessContext: vi.fn(async () => ({
                            access: [{ userUuid: 'granter-1', role: 'editor' }],
                            inheritsFromOrgOrProject: false,
                        })),
                    },
                });
            const granter = createGranter({
                projectRole: ProjectMemberRole.EDITOR,
            });

            await service.grantUserAccess(
                granter,
                'SavedChart',
                'chart-1',
                'target-user-1',
                'manage',
            );

            expect(savedChartModel.getSummary).toHaveBeenCalledWith('chart-1');
            expect(resourceAccessModel.addUserAccess).toHaveBeenCalledWith({
                userUuid: 'target-user-1',
                resourceUuid: 'chart-1',
                resourceType: 'SavedChart',
                projectUuid: 'project-1',
                action: 'manage',
                grantedByUserUuid: 'granter-1',
            });
        });
    });

    describe('grantGroupAccess', () => {
        it('persists the grant when the granter already has the action being granted', async () => {
            const { service, resourceAccessModel } = buildService({
                spacePermissionService: {
                    getSpaceAccessContext: vi.fn(async () => ({
                        access: [{ userUuid: 'granter-1', role: 'admin' }],
                        inheritsFromOrgOrProject: false,
                    })),
                },
            });
            const granter = createGranter({
                projectRole: ProjectMemberRole.EDITOR,
            });

            await service.grantGroupAccess(
                granter,
                'Dashboard',
                'dashboard-1',
                'target-group-1',
                'manage',
            );

            expect(resourceAccessModel.addGroupAccess).toHaveBeenCalledWith({
                groupUuid: 'target-group-1',
                resourceUuid: 'dashboard-1',
                resourceType: 'Dashboard',
                projectUuid: 'project-1',
                action: 'manage',
                grantedByUserUuid: 'granter-1',
            });
        });

        it('rejects with ForbiddenError on confused deputy', async () => {
            const { service, resourceAccessModel } = buildService();
            const granter = createGranter({
                projectRole: ProjectMemberRole.VIEWER,
            });

            await expect(
                service.grantGroupAccess(
                    granter,
                    'Dashboard',
                    'dashboard-1',
                    'target-group-1',
                    'manage',
                ),
            ).rejects.toThrow(ForbiddenError);
            expect(resourceAccessModel.addGroupAccess).not.toHaveBeenCalled();
        });
    });

    describe('revokeUserAccess', () => {
        it('removes the grant when the revoker holds the action being revoked', async () => {
            const { service, resourceAccessModel } = buildService();
            const granter = createGranter({
                projectRole: ProjectMemberRole.VIEWER,
            });

            await service.revokeUserAccess(
                granter,
                'Dashboard',
                'dashboard-1',
                'target-user-1',
                'view',
            );

            expect(resourceAccessModel.removeUserAccess).toHaveBeenCalledWith({
                userUuid: 'target-user-1',
                resourceUuid: 'dashboard-1',
                resourceType: 'Dashboard',
                action: 'view',
            });
        });

        it('rejects with ForbiddenError when the revoker lacks the action being revoked', async () => {
            const { service, resourceAccessModel } = buildService();
            const granter = createGranter({
                projectRole: ProjectMemberRole.VIEWER,
            });

            await expect(
                service.revokeUserAccess(
                    granter,
                    'Dashboard',
                    'dashboard-1',
                    'target-user-1',
                    'manage',
                ),
            ).rejects.toThrow(ForbiddenError);
            expect(resourceAccessModel.removeUserAccess).not.toHaveBeenCalled();
        });
    });

    describe('listAccessForResource', () => {
        it('returns the grant list when the requester can view the resource', async () => {
            const { service, resourceAccessModel } = buildService({
                resourceAccessModel: {
                    listAccessForResource: vi.fn(async () => [
                        {
                            userUuid: 'target-user-1',
                            groupUuid: null,
                            action: 'view' as const,
                            grantedByUserUuid: 'granter-1',
                            createdAt: new Date('2026-01-01T00:00:00Z'),
                        },
                    ]),
                },
            });
            const granter = createGranter({
                projectRole: ProjectMemberRole.VIEWER,
            });

            const result = await service.listAccessForResource(
                granter,
                'Dashboard',
                'dashboard-1',
            );

            expect(result).toHaveLength(1);
            expect(
                resourceAccessModel.listAccessForResource,
            ).toHaveBeenCalledWith({
                resourceUuid: 'dashboard-1',
                resourceType: 'Dashboard',
            });
        });

        it('rejects with ForbiddenError when the requester cannot view the resource', async () => {
            const { service, resourceAccessModel } = buildService();
            const granter = createGranter({ projectRole: undefined });

            await expect(
                service.listAccessForResource(
                    granter,
                    'Dashboard',
                    'dashboard-1',
                ),
            ).rejects.toThrow(ForbiddenError);
            expect(
                resourceAccessModel.listAccessForResource,
            ).not.toHaveBeenCalled();
        });
    });

    describe('unsupported resource types', () => {
        it('rejects with ParameterError before touching the database', async () => {
            const { service, resourceAccessModel } = buildService();
            const granter = createGranter({
                projectRole: ProjectMemberRole.ADMIN,
            });

            await expect(
                service.grantUserAccess(
                    granter,
                    // Cast to simulate a value that bypassed the tsoa/type
                    // boundary -- e.g. a future resource_type widening the
                    // CHECK constraint without updating the metadata-key map.
                    'Space' as unknown as 'Dashboard',
                    'space-1',
                    'target-user-1',
                    'view',
                ),
            ).rejects.toThrow(ParameterError);
            expect(resourceAccessModel.addUserAccess).not.toHaveBeenCalled();
        });
    });
});
