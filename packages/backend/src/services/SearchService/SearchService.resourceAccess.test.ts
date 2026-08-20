import {
    defineUserAbility,
    OrganizationMemberRole,
    SpaceMemberRole,
    type SessionUser,
} from '@lightdash/common';
import { analyticsMock } from '../../analytics/LightdashAnalytics.mock';
import { ProjectModel } from '../../models/ProjectModel/ProjectModel';
import { SearchModel } from '../../models/SearchModel';
import { SpaceModel } from '../../models/SpaceModel';
import { UserAttributesModel } from '../../models/UserAttributesModel';
import { SpacePermissionService } from '../SpaceService/SpacePermissionService';
import { SearchService } from './SearchService';

const ORGANIZATION_UUID = 'org-1';
const PROJECT_UUID = 'project-1';
const SPACE_UUID = 'space-1';
const DASHBOARD_UUID = 'dashboard-1';
const CHART_UUID = 'chart-1';

const user = {
    userUuid: 'user-1',
    organizationUuid: ORGANIZATION_UUID,
    role: OrganizationMemberRole.ADMIN,
    ability: defineUserAbility(
        {
            userUuid: 'user-1',
            role: OrganizationMemberRole.ADMIN,
            organizationUuid: ORGANIZATION_UUID,
            roleUuid: undefined,
        },
        [],
    ),
} as unknown as SessionUser;

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
        getSpacesAccessContext: vi.fn(async () => ({
            [SPACE_UUID]: accessContext,
        })),
        getResourceAccessContexts: vi.fn(
            async (
                _userUuid: string,
                _resourceType: string,
                resources: { resourceUuid: string; spaceUuid: string }[],
            ) =>
                Object.fromEntries(
                    resources.map(({ resourceUuid }) => [
                        resourceUuid,
                        accessContext,
                    ]),
                ),
        ),
    };
    const service = new SearchService({
        analytics: analyticsMock,
        searchModel: {
            searchDashboards: vi.fn(async () => [
                {
                    uuid: DASHBOARD_UUID,
                    name: 'Revenue',
                    spaceUuid: SPACE_UUID,
                    charts: [],
                },
            ]),
            searchAllCharts: vi.fn(async () => [
                {
                    uuid: CHART_UUID,
                    name: 'Orders',
                    spaceUuid: SPACE_UUID,
                },
            ]),
        } as unknown as SearchModel,
        projectModel: {
            getSummary: vi.fn(async () => ({
                organizationUuid: ORGANIZATION_UUID,
                projectUuid: PROJECT_UUID,
                name: 'Analytics',
            })),
        } as unknown as ProjectModel,
        spaceModel: {} as unknown as SpaceModel,
        userAttributesModel: {} as unknown as UserAttributesModel,
        spacePermissionService:
            spacePermissionService as unknown as SpacePermissionService,
    });
    return { service, spacePermissionService };
};

describe('SearchService resource access resolution', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('given results of both types, then access is resolved per resource', async () => {
        const { service, spacePermissionService } = buildService();

        await service.findContent(user, PROJECT_UUID, 'rev', false);

        expect(
            spacePermissionService.getResourceAccessContexts,
        ).toHaveBeenCalledWith(
            user.userUuid,
            'Dashboard',
            expect.arrayContaining([
                expect.objectContaining({ resourceUuid: DASHBOARD_UUID }),
            ]),
        );
        expect(
            spacePermissionService.getResourceAccessContexts,
        ).toHaveBeenCalledWith(
            user.userUuid,
            'SavedChart',
            expect.arrayContaining([
                expect.objectContaining({ resourceUuid: CHART_UUID }),
            ]),
        );
    });

    it('given a mixed result set, then it costs one resolution per resource type, not per item', async () => {
        const { service, spacePermissionService } = buildService();

        await service.findContent(user, PROJECT_UUID, 'rev', false);

        // Dashboards and charts are separate grant lookups because resource_type
        // is part of the key -- but each is batched, so search does not scale in
        // round trips with the number of hits.
        expect(
            spacePermissionService.getResourceAccessContexts,
        ).toHaveBeenCalledTimes(2);
    });

    it('given results, then they are still returned', async () => {
        const { service } = buildService();

        const { content } = await service.findContent(
            user,
            PROJECT_UUID,
            'rev',
            false,
        );

        expect(content.map((item) => item.uuid).sort()).toEqual([
            CHART_UUID,
            DASHBOARD_UUID,
        ]);
    });
});
