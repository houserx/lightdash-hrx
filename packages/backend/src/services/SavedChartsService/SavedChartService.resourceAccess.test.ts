import {
    defineUserAbility,
    OrganizationMemberRole,
    SpaceMemberRole,
    type SessionUser,
} from '@lightdash/common';
import { analyticsMock } from '../../analytics/LightdashAnalytics.mock';
import { GoogleDriveClient } from '../../clients/Google/GoogleDriveClient';
import { SlackClient } from '../../clients/Slack/SlackClient';
import { lightdashConfigMock } from '../../config/lightdashConfig.mock';
import { AnalyticsModel } from '../../models/AnalyticsModel';
import { CatalogModel } from '../../models/CatalogModel/CatalogModel';
import { ContentVerificationModel } from '../../models/ContentVerificationModel';
import { DashboardModel } from '../../models/DashboardModel/DashboardModel';
import { OrganizationModel } from '../../models/OrganizationModel';
import { PinnedListModel } from '../../models/PinnedListModel';
import { ProjectModel } from '../../models/ProjectModel/ProjectModel';
import { ResourceAccessModel } from '../../models/ResourceAccessModel';
import { SavedChartModel } from '../../models/SavedChartModel';
import { SchedulerModel } from '../../models/SchedulerModel';
import { SpaceModel } from '../../models/SpaceModel';
import { SchedulerClient } from '../../scheduler/SchedulerClient';
import { PermissionsService } from '../PermissionsService/PermissionsService';
import { SchedulerService } from '../SchedulerService/SchedulerService';
import { SpacePermissionService } from '../SpaceService/SpacePermissionService';
import { UserService } from '../UserService';
import { SavedChartService } from './SavedChartService';

const ORGANIZATION_UUID = 'org-uuid';
const PROJECT_UUID = 'project-uuid';
const SPACE_UUID = 'space-uuid';
const CHART_UUID = 'chart-uuid';

const user = {
    userUuid: 'user-uuid',
    organizationUuid: ORGANIZATION_UUID,
    role: OrganizationMemberRole.ADMIN,
    ability: defineUserAbility(
        {
            userUuid: 'user-uuid',
            role: OrganizationMemberRole.ADMIN,
            organizationUuid: ORGANIZATION_UUID,
        },
        [],
    ),
} as unknown as SessionUser;

const account = {
    user,
    organization: { organizationUuid: ORGANIZATION_UUID },
    authentication: { type: 'session' },
    isAnonymousUser: () => false,
    isAuthenticated: () => true,
    isJwtUser: () => false,
    isOauthUser: () => false,
    isPatUser: () => false,
    isRegisteredUser: () => true,
    isServiceAccount: () => false,
    isSessionUser: () => true,
} as never;

const chart = {
    uuid: CHART_UUID,
    name: 'Orders',
    slug: 'orders',
    spaceUuid: SPACE_UUID,
    projectUuid: PROJECT_UUID,
    organizationUuid: ORGANIZATION_UUID,
    dashboardUuid: null,
    updatedByUser: undefined,
    metricQuery: {},
    chartConfig: {},
    tableConfig: {},
};

const accessContext = {
    organizationUuid: ORGANIZATION_UUID,
    projectUuid: PROJECT_UUID,
    inheritsFromOrgOrProject: true,
    access: [
        {
            userUuid: user.userUuid,
            role: SpaceMemberRole.ADMIN,
            hasDirectAccess: true,
            projectRole: undefined,
            inheritedRole: undefined,
            inheritedFrom: undefined,
        },
    ],
    admins: [],
};

const buildService = () => {
    const spacePermissionService = {
        getSpaceAccessContext: vi.fn(async () => accessContext),
        getResourceAccessContext: vi.fn(async () => accessContext),
        getAllSpaceAccessContext: vi.fn(async () => accessContext),
    };
    const savedChartModel = {
        get: vi.fn(async () => chart),
        getSummary: vi.fn(async () => chart),
    };
    const service = new SavedChartService({
        resourceAccessModel: {
            removeAllForResource: vi.fn(async () => undefined),
        } as unknown as ResourceAccessModel,
        analytics: analyticsMock,
        lightdashConfig: lightdashConfigMock,
        projectModel: {
            getSummary: vi.fn(async () => ({
                organizationUuid: ORGANIZATION_UUID,
                projectUuid: PROJECT_UUID,
            })),
        } as unknown as ProjectModel,
        savedChartModel: savedChartModel as unknown as SavedChartModel,
        spaceModel: {
            getSpaceSummary: vi.fn(async () => ({
                uuid: SPACE_UUID,
                projectUuid: PROJECT_UUID,
                organizationUuid: ORGANIZATION_UUID,
            })),
        } as unknown as SpaceModel,
        analyticsModel: {
            addChartViewEvent: vi.fn(async () => undefined),
        } as unknown as AnalyticsModel,
        pinnedListModel: {} as unknown as PinnedListModel,
        schedulerModel: {} as unknown as SchedulerModel,
        schedulerService: {} as unknown as SchedulerService,
        schedulerClient: {} as unknown as SchedulerClient,
        slackClient: {} as unknown as SlackClient,
        dashboardModel: {} as unknown as DashboardModel,
        catalogModel: {} as unknown as CatalogModel,
        permissionsService: {} as unknown as PermissionsService,
        googleDriveClient: {} as unknown as GoogleDriveClient,
        userService: {} as unknown as UserService,
        spacePermissionService:
            spacePermissionService as unknown as SpacePermissionService,
        contentVerificationModel: {
            getByContent: vi.fn(async () => null),
        } as unknown as ContentVerificationModel,
        organizationModel: {} as unknown as OrganizationModel,
    });
    return { service, spacePermissionService };
};

describe('SavedChartService resource access resolution', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('given a chart is read, then access is resolved for the chart, not just its space', async () => {
        const { service, spacePermissionService } = buildService();

        await service.get(CHART_UUID, account);

        expect(
            spacePermissionService.getResourceAccessContext,
        ).toHaveBeenCalledWith(
            user.userUuid,
            'SavedChart',
            expect.objectContaining({
                resourceUuid: CHART_UUID,
                spaceUuid: SPACE_UUID,
            }),
        );
    });

    it('given an update is gated, then access is resolved for the chart', async () => {
        const { service, spacePermissionService } = buildService();

        await service
            .rollback(user, CHART_UUID, 'version-uuid')
            .catch(() => undefined);

        expect(
            spacePermissionService.getResourceAccessContext,
        ).toHaveBeenCalledWith(
            user.userUuid,
            'SavedChart',
            expect.objectContaining({
                resourceUuid: CHART_UUID,
                spaceUuid: SPACE_UUID,
            }),
        );
    });
});
