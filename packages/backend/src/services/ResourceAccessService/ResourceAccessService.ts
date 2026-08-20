import { subject } from '@casl/ability';
import {
    ForbiddenError,
    ParameterError,
    type KnexPaginateArgs,
    type KnexPaginatedData,
    type ResourceAccessAction,
    type ResourceAccessListFilters,
    type ResourceAccessResourceType,
    type ResourceShare,
    type SessionUser,
} from '@lightdash/common';
import { DashboardModel } from '../../models/DashboardModel/DashboardModel';
import { ResourceAccessModel } from '../../models/ResourceAccessModel';
import { SavedChartModel } from '../../models/SavedChartModel';
import { BaseService } from '../BaseService';
import { SpacePermissionService } from '../SpaceService/SpacePermissionService';

type ResourceAccessServiceArguments = {
    dashboardModel: DashboardModel;
    savedChartModel: SavedChartModel;
    resourceAccessModel: ResourceAccessModel;
    spacePermissionService: SpacePermissionService;
};

type ResourceContext = {
    organizationUuid: string;
    projectUuid: string;
    spaceUuid: string;
    resourceUuid: string;
};

/**
 * The `metadata` key each resource type's real permission check carries. Not
 * uniform, so it cannot be derived. Exhaustive over the union, so a new resource
 * type is a compile error here rather than a silently malformed subject.
 */
const METADATA_KEY: Record<ResourceAccessResourceType, string> = {
    Dashboard: 'dashboardUuid',
    SavedChart: 'savedChartUuid',
};

/**
 * Create, list and revoke direct grants on a single Dashboard or SavedChart,
 * without needing a dedicated Space for it.
 *
 * Confused-deputy-resistant by design: a granter may only grant an action they
 * themselves already hold on that resource, checked by building the same subject
 * shape the real read and update gates build -- so they pass here if and only if
 * they would pass the real check. Being an org admin is not the test.
 *
 * A user holding only a direct grant can therefore grant that same action onward,
 * the transitive property space sharing already has. Two things bound it here
 * that do not bound space sharing: the recipient must already hold the underlying
 * scope from a role for the grant to do anything, and losing that role silently
 * neutralises every grant they hold.
 */
export class ResourceAccessService extends BaseService {
    private readonly dashboardModel: DashboardModel;

    private readonly savedChartModel: SavedChartModel;

    private readonly resourceAccessModel: ResourceAccessModel;

    private readonly spacePermissionService: SpacePermissionService;

    constructor({
        dashboardModel,
        savedChartModel,
        resourceAccessModel,
        spacePermissionService,
    }: ResourceAccessServiceArguments) {
        super();
        this.dashboardModel = dashboardModel;
        this.savedChartModel = savedChartModel;
        this.resourceAccessModel = resourceAccessModel;
        this.spacePermissionService = spacePermissionService;
    }

    /**
     * Resolves the resource and confirms the route's project actually owns it.
     *
     * Every endpoint is declared project-scoped, so without this the path
     * parameter is decorative: a caller could address a resource in one project
     * through another project's url. The authorization decision would still be
     * safe -- assertRequesterCan checks the resource's own context, not the url --
     * but anything keyed off the route's project would be misattributed.
     */
    private async getResourceContext(
        projectUuid: string,
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
    ): Promise<ResourceContext> {
        const context = await (async (): Promise<ResourceContext> => {
            if (resourceType === 'Dashboard') {
                const dashboard =
                    await this.dashboardModel.getByIdOrSlug(resourceUuid);
                return {
                    organizationUuid: dashboard.organizationUuid,
                    projectUuid: dashboard.projectUuid,
                    spaceUuid: dashboard.spaceUuid,
                    resourceUuid: dashboard.uuid,
                };
            }
            const chart = await this.savedChartModel.getSummary(resourceUuid);
            return {
                organizationUuid: chart.organizationUuid,
                projectUuid: chart.projectUuid,
                spaceUuid: chart.spaceUuid,
                resourceUuid: chart.uuid,
            };
        })();

        if (context.projectUuid !== projectUuid) {
            throw new ParameterError(
                `This ${resourceType} does not belong to project ${projectUuid}`,
            );
        }

        return context;
    }

    /**
     * Mirrors the subject shape DashboardService and SavedChartService build at
     * their real check sites, so the granter passes if and only if they would pass
     * the real check for this action on this resource.
     *
     * Resolves through the resource-aware context, so a grant the requester holds
     * counts toward their authority to grant onward.
     */
    private async assertRequesterCan(
        requester: SessionUser,
        action: ResourceAccessAction,
        resourceType: ResourceAccessResourceType,
        context: ResourceContext,
    ): Promise<void> {
        const { access, inheritsFromOrgOrProject } =
            await this.spacePermissionService.getResourceAccessContext(
                requester.userUuid,
                resourceType,
                {
                    resourceUuid: context.resourceUuid,
                    spaceUuid: context.spaceUuid,
                },
            );

        const auditedAbility = this.createAuditedAbility(requester);
        if (
            auditedAbility.cannot(
                action,
                subject(resourceType, {
                    organizationUuid: context.organizationUuid,
                    projectUuid: context.projectUuid,
                    inheritsFromOrgOrProject,
                    access,
                    metadata: {
                        [METADATA_KEY[resourceType]]: context.resourceUuid,
                    },
                }),
            )
        ) {
            throw new ForbiddenError(
                `You don't have ${action} access to this ${resourceType}`,
            );
        }
    }

    /**
     * Checked only after the permission check, so these endpoints cannot be used
     * to probe whether a uuid belongs to an organization.
     */
    private async assertRecipientInOrganization(
        organizationUuid: string,
        recipient: { targetUserUuid: string } | { targetGroupUuid: string },
    ): Promise<void> {
        const isMember =
            'targetUserUuid' in recipient
                ? await this.resourceAccessModel.isUserInOrganization(
                      organizationUuid,
                      recipient.targetUserUuid,
                  )
                : await this.resourceAccessModel.isGroupInOrganization(
                      organizationUuid,
                      recipient.targetGroupUuid,
                  );

        if (!isMember) {
            throw new ParameterError(
                'Cannot grant access to a recipient outside this organization',
            );
        }
    }

    async grantUserAccess(
        granter: SessionUser,
        {
            projectUuid,
            resourceType,
            resourceUuid,
            targetUserUuid,
            action,
        }: {
            projectUuid: string;
            resourceType: ResourceAccessResourceType;
            resourceUuid: string;
            targetUserUuid: string;
            action: ResourceAccessAction;
        },
    ): Promise<void> {
        const context = await this.getResourceContext(
            projectUuid,
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(granter, action, resourceType, context);
        await this.assertRecipientInOrganization(context.organizationUuid, {
            targetUserUuid,
        });

        await this.resourceAccessModel.addUserAccess({
            resourceType,
            resourceUuid: context.resourceUuid,
            projectUuid: context.projectUuid,
            targetUserUuid,
            action,
            grantedByUserUuid: granter.userUuid,
        });
    }

    async grantGroupAccess(
        granter: SessionUser,
        {
            projectUuid,
            resourceType,
            resourceUuid,
            targetGroupUuid,
            action,
        }: {
            projectUuid: string;
            resourceType: ResourceAccessResourceType;
            resourceUuid: string;
            targetGroupUuid: string;
            action: ResourceAccessAction;
        },
    ): Promise<void> {
        const context = await this.getResourceContext(
            projectUuid,
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(granter, action, resourceType, context);
        await this.assertRecipientInOrganization(context.organizationUuid, {
            targetGroupUuid,
        });

        await this.resourceAccessModel.addGroupAccess({
            resourceType,
            resourceUuid: context.resourceUuid,
            projectUuid: context.projectUuid,
            targetGroupUuid,
            action,
            grantedByUserUuid: granter.userUuid,
        });
    }

    /**
     * Symmetric with granting: revoking an action requires holding that same
     * action, not blanket `manage`. Deliberately does not require the recipient to
     * still be an organization member -- offboarded users must remain revocable.
     */
    async revokeUserAccess(
        revoker: SessionUser,
        {
            projectUuid,
            resourceType,
            resourceUuid,
            targetUserUuid,
            action,
        }: {
            projectUuid: string;
            resourceType: ResourceAccessResourceType;
            resourceUuid: string;
            targetUserUuid: string;
            action: ResourceAccessAction;
        },
    ): Promise<void> {
        const context = await this.getResourceContext(
            projectUuid,
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(revoker, action, resourceType, context);

        await this.resourceAccessModel.removeUserAccess({
            resourceType,
            resourceUuid: context.resourceUuid,
            targetUserUuid,
            action,
        });
    }

    async revokeGroupAccess(
        revoker: SessionUser,
        {
            projectUuid,
            resourceType,
            resourceUuid,
            targetGroupUuid,
            action,
        }: {
            projectUuid: string;
            resourceType: ResourceAccessResourceType;
            resourceUuid: string;
            targetGroupUuid: string;
            action: ResourceAccessAction;
        },
    ): Promise<void> {
        const context = await this.getResourceContext(
            projectUuid,
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(revoker, action, resourceType, context);

        await this.resourceAccessModel.removeGroupAccess({
            resourceType,
            resourceUuid: context.resourceUuid,
            targetGroupUuid,
            action,
        });
    }

    async listResourceAccess(
        requester: SessionUser,
        projectUuid: string,
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
    ) {
        const context = await this.getResourceContext(
            projectUuid,
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(requester, 'view', resourceType, context);

        return this.resourceAccessModel.listResourceAccess(
            resourceType,
            context.resourceUuid,
        );
    }

    /**
     * The resolved access list for a resource -- who can reach it, at what role,
     * and where that came from -- as opposed to `listResourceAccess`, which
     * returns the persisted grant rows alone.
     *
     * Mirrors `SpaceService.getSpaceAccessList` guard for guard, so the sharing
     * UI can treat a resource and a space as the same kind of thing.
     */
    async getResourceAccessList(
        requester: SessionUser,
        {
            projectUuid,
            resourceType,
            resourceUuid,
            paginateArgs,
            filters,
        }: {
            projectUuid: string;
            resourceType: ResourceAccessResourceType;
            resourceUuid: string;
            paginateArgs?: KnexPaginateArgs;
            filters?: ResourceAccessListFilters;
        },
    ): Promise<KnexPaginatedData<ResourceShare[]>> {
        const context = await this.getResourceContext(
            projectUuid,
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(requester, 'view', resourceType, context);

        if (filters?.userUuids && filters.userUuids.length > 100) {
            throw new ParameterError('userUuids accepts at most 100 values');
        }

        // Asking about nobody is not the same as asking about everybody.
        if (filters?.userUuids?.length === 0) {
            return {
                data: [],
                ...(paginateArgs
                    ? {
                          pagination: {
                              ...paginateArgs,
                              totalPageCount: 0,
                              totalResults: 0,
                          },
                      }
                    : {}),
            };
        }

        return this.spacePermissionService.getPaginatedResourceAccess(
            resourceType,
            {
                resourceUuid: context.resourceUuid,
                spaceUuid: context.spaceUuid,
            },
            { paginateArgs, filters, currentUserUuid: requester.userUuid },
        );
    }
}
