import {
    ForbiddenError,
    ParameterError,
    SpaceMemberRole,
    type SessionUser,
} from '@lightdash/common';
import { analyticsMock } from '../../analytics/LightdashAnalytics.mock';
import { lightdashConfigMock } from '../../config/lightdashConfig.mock';
import { OrganizationModel } from '../../models/OrganizationModel';
import { PinnedListModel } from '../../models/PinnedListModel';
import { ProjectModel } from '../../models/ProjectModel/ProjectModel';
import { SpaceModel } from '../../models/SpaceModel';
import { DashboardService } from '../DashboardService/DashboardService';
import { SavedChartService } from '../SavedChartsService/SavedChartService';
import { SpacePermissionService } from './SpacePermissionService';
import { SpaceService } from './SpaceService';
import { createTestUser } from './SpaceService.mock';

const SPACE_UUID = 'test-space-uuid';
const GRANTEE_UUID = 'grantee-user-uuid';
const GRANTEE_GROUP_UUID = 'grantee-group-uuid';

describe('SpaceService grantee organization validation', () => {
    const mockCan = vi.fn();
    const mockIsOrganizationMemberForSpace = vi.fn();
    const mockIsGroupInSpaceOrganization = vi.fn();
    const mockAddSpaceAccess = vi.fn();
    const mockAddSpaceGroupAccess = vi.fn();
    let service: SpaceService;
    let manager: SessionUser;

    beforeEach(() => {
        mockCan.mockReset();
        mockIsOrganizationMemberForSpace.mockReset();
        mockIsGroupInSpaceOrganization.mockReset();
        mockAddSpaceAccess.mockReset();
        mockAddSpaceGroupAccess.mockReset();

        manager = createTestUser() as unknown as SessionUser;

        service = new SpaceService({
            analytics: analyticsMock,
            lightdashConfig: lightdashConfigMock,
            projectModel: {} as ProjectModel,
            spaceModel: {
                addSpaceAccess: mockAddSpaceAccess,
                addSpaceGroupAccess: mockAddSpaceGroupAccess,
            } as unknown as SpaceModel,
            organizationModel: {} as OrganizationModel,
            pinnedListModel: {} as PinnedListModel,
            spacePermissionService: {
                can: mockCan,
                isOrganizationMemberForSpace: mockIsOrganizationMemberForSpace,
                isGroupInSpaceOrganization: mockIsGroupInSpaceOrganization,
            } as unknown as SpacePermissionService,
            savedChartService: {} as SavedChartService,
            dashboardService: {} as DashboardService,
            appGenerateService: undefined,
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('given the grantee belongs to the space organization', () => {
        beforeEach(() => {
            mockCan.mockResolvedValue(true);
            mockIsOrganizationMemberForSpace.mockResolvedValue(true);
        });

        it('then the access grant is persisted', async () => {
            await service.addSpaceUserAccess(
                manager,
                SPACE_UUID,
                GRANTEE_UUID,
                SpaceMemberRole.VIEWER,
            );

            expect(mockAddSpaceAccess).toHaveBeenCalledWith(
                SPACE_UUID,
                GRANTEE_UUID,
                SpaceMemberRole.VIEWER,
            );
        });

        it('then membership is checked against the space, not the caller organization', async () => {
            await service.addSpaceUserAccess(
                manager,
                SPACE_UUID,
                GRANTEE_UUID,
                SpaceMemberRole.EDITOR,
            );

            expect(mockIsOrganizationMemberForSpace).toHaveBeenCalledWith(
                SPACE_UUID,
                GRANTEE_UUID,
            );
        });
    });

    describe('given the grantee belongs to a different organization', () => {
        beforeEach(() => {
            mockCan.mockResolvedValue(true);
            mockIsOrganizationMemberForSpace.mockResolvedValue(false);
        });

        it('then the grant is rejected', async () => {
            await expect(
                service.addSpaceUserAccess(
                    manager,
                    SPACE_UUID,
                    GRANTEE_UUID,
                    SpaceMemberRole.VIEWER,
                ),
            ).rejects.toThrowError(ParameterError);
        });

        it('then nothing is persisted', async () => {
            await expect(
                service.addSpaceUserAccess(
                    manager,
                    SPACE_UUID,
                    GRANTEE_UUID,
                    SpaceMemberRole.VIEWER,
                ),
            ).rejects.toThrowError(ParameterError);

            expect(mockAddSpaceAccess).not.toHaveBeenCalled();
        });
    });

    describe('given the caller cannot manage the space', () => {
        beforeEach(() => {
            mockCan.mockResolvedValue(false);
            mockIsOrganizationMemberForSpace.mockResolvedValue(true);
        });

        it('then the grant is forbidden', async () => {
            await expect(
                service.addSpaceUserAccess(
                    manager,
                    SPACE_UUID,
                    GRANTEE_UUID,
                    SpaceMemberRole.VIEWER,
                ),
            ).rejects.toThrowError(ForbiddenError);
        });

        it('then the grantee organization is not disclosed by a membership lookup', async () => {
            await expect(
                service.addSpaceUserAccess(
                    manager,
                    SPACE_UUID,
                    GRANTEE_UUID,
                    SpaceMemberRole.VIEWER,
                ),
            ).rejects.toThrowError(ForbiddenError);

            expect(mockIsOrganizationMemberForSpace).not.toHaveBeenCalled();
        });
    });

    describe('given the grantee group belongs to the space organization', () => {
        beforeEach(() => {
            mockCan.mockResolvedValue(true);
            mockIsGroupInSpaceOrganization.mockResolvedValue(true);
        });

        it('then the group access grant is persisted', async () => {
            await service.addSpaceGroupAccess(
                manager,
                SPACE_UUID,
                GRANTEE_GROUP_UUID,
                SpaceMemberRole.VIEWER,
            );

            expect(mockAddSpaceGroupAccess).toHaveBeenCalledWith(
                SPACE_UUID,
                GRANTEE_GROUP_UUID,
                SpaceMemberRole.VIEWER,
            );
        });

        it('then the group is checked against the space organization', async () => {
            await service.addSpaceGroupAccess(
                manager,
                SPACE_UUID,
                GRANTEE_GROUP_UUID,
                SpaceMemberRole.EDITOR,
            );

            expect(mockIsGroupInSpaceOrganization).toHaveBeenCalledWith(
                SPACE_UUID,
                GRANTEE_GROUP_UUID,
            );
        });
    });

    describe('given the grantee group belongs to a different organization', () => {
        beforeEach(() => {
            mockCan.mockResolvedValue(true);
            mockIsGroupInSpaceOrganization.mockResolvedValue(false);
        });

        it('then the group grant is rejected', async () => {
            await expect(
                service.addSpaceGroupAccess(
                    manager,
                    SPACE_UUID,
                    GRANTEE_GROUP_UUID,
                    SpaceMemberRole.VIEWER,
                ),
            ).rejects.toThrowError(ParameterError);
        });

        it('then nothing is persisted', async () => {
            await expect(
                service.addSpaceGroupAccess(
                    manager,
                    SPACE_UUID,
                    GRANTEE_GROUP_UUID,
                    SpaceMemberRole.VIEWER,
                ),
            ).rejects.toThrowError(ParameterError);

            expect(mockAddSpaceGroupAccess).not.toHaveBeenCalled();
        });
    });

    describe('given the caller cannot manage the space for a group grant', () => {
        beforeEach(() => {
            mockCan.mockResolvedValue(false);
            mockIsGroupInSpaceOrganization.mockResolvedValue(true);
        });

        it('then the group grant is forbidden without a group lookup', async () => {
            await expect(
                service.addSpaceGroupAccess(
                    manager,
                    SPACE_UUID,
                    GRANTEE_GROUP_UUID,
                    SpaceMemberRole.VIEWER,
                ),
            ).rejects.toThrowError(ForbiddenError);

            expect(mockIsGroupInSpaceOrganization).not.toHaveBeenCalled();
        });
    });
});
