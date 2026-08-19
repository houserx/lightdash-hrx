import { subject } from '@casl/ability';
import {
    ForbiddenError,
    ParameterError,
    RESOURCE_ACCESS_METADATA_KEY,
    type ResourceAccessAction,
    type ResourceAccessGrantSummary,
    type ResourceAccessResourceType,
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
    resourceName: string;
};

/**
 * Direct, resource-scoped access grants -- create/list/revoke a
 * grant on a single Dashboard or SavedChart for a user or group, without
 * requiring a dedicated Space. Confused-deputy-resistant by design: a
 * granter can only grant the exact action they themselves already hold on
 * the resource (checked via the same subject shape DashboardService/
 * SavedChartService use at their real `view`/`update` check sites), not
 * merely org-admin status.
 *
 * This does mean a user holding only a *direct grant* (not space/org/
 * project access) on a resource can grant that same access onward to
 * someone else -- the same transitive property space sharing already has
 * (anyone who can `manage` a space can add/remove other members of it).
 * Accepted as consistent with existing precedent, not an oversight.
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
     * The metadata-key map is the invariant that actually matters here --
     * not the migration's CHECK constraint. A resource_type that passed the
     * CHECK constraint but had no entry here would persist fine and then produce
     * an unmatchable `metadata.undefined` CASL condition. Checked first, so
     * a bad resource_type never reaches the database (never a silent no-op
     * grant).
     */
    private static assertSupportedResourceType(
        resourceType: ResourceAccessResourceType,
    ): string {
        const metadataKey = RESOURCE_ACCESS_METADATA_KEY[resourceType];
        if (!metadataKey) {
            throw new ParameterError(
                `Unsupported resource type for direct access grants: ${resourceType}`,
            );
        }
        return metadataKey;
    }

    private async getResourceContext(
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
    ): Promise<ResourceContext> {
        if (resourceType === 'Dashboard') {
            const dashboard =
                await this.dashboardModel.getByIdOrSlug(resourceUuid);
            return {
                organizationUuid: dashboard.organizationUuid,
                projectUuid: dashboard.projectUuid,
                spaceUuid: dashboard.spaceUuid,
                resourceUuid: dashboard.uuid,
                resourceName: dashboard.name,
            };
        }
        const chart = await this.savedChartModel.getSummary(resourceUuid);
        return {
            organizationUuid: chart.organizationUuid,
            projectUuid: chart.projectUuid,
            spaceUuid: chart.spaceUuid,
            resourceUuid: chart.uuid,
            resourceName: chart.name,
        };
    }

    /**
     * Mirrors the exact subject shape DashboardService/SavedChartService's
     * real permission checks build (organizationUuid, projectUuid,
     * inheritsFromOrgOrProject, access, metadata.<key>) -- so a granter
     * passes this check if and only if they'd pass the real check for
     * `action` on this resource.
     */
    private async assertRequesterCan(
        requester: SessionUser,
        action: ResourceAccessAction,
        resourceType: ResourceAccessResourceType,
        metadataKey: string,
        context: ResourceContext,
    ): Promise<void> {
        const { access, inheritsFromOrgOrProject } =
            await this.spacePermissionService.getSpaceAccessContext(
                requester.userUuid,
                context.spaceUuid,
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
                    metadata: { [metadataKey]: context.resourceUuid },
                }),
            )
        ) {
            throw new ForbiddenError(
                `You don't have ${action} access to this ${resourceType}`,
            );
        }
    }

    async grantUserAccess(
        granter: SessionUser,
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
        targetUserUuid: string,
        action: ResourceAccessAction,
    ): Promise<void> {
        const metadataKey =
            ResourceAccessService.assertSupportedResourceType(resourceType);
        const context = await this.getResourceContext(
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(
            granter,
            action,
            resourceType,
            metadataKey,
            context,
        );
        await this.resourceAccessModel.addUserAccess({
            userUuid: targetUserUuid,
            resourceUuid: context.resourceUuid,
            resourceType,
            projectUuid: context.projectUuid,
            action,
            grantedByUserUuid: granter.userUuid,
        });
    }

    async grantGroupAccess(
        granter: SessionUser,
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
        targetGroupUuid: string,
        action: ResourceAccessAction,
    ): Promise<void> {
        const metadataKey =
            ResourceAccessService.assertSupportedResourceType(resourceType);
        const context = await this.getResourceContext(
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(
            granter,
            action,
            resourceType,
            metadataKey,
            context,
        );
        await this.resourceAccessModel.addGroupAccess({
            groupUuid: targetGroupUuid,
            resourceUuid: context.resourceUuid,
            resourceType,
            projectUuid: context.projectUuid,
            action,
            grantedByUserUuid: granter.userUuid,
        });
    }

    /**
     * Symmetric with granting: revoking a given action requires holding
     * that same action, not blanket `manage`. A user who could only grant
     * `view` (because they only held `view` themselves) can still revoke
     * the `view` grants they created; revoking a `manage` grant requires
     * `manage`.
     */
    async revokeUserAccess(
        revoker: SessionUser,
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
        targetUserUuid: string,
        action: ResourceAccessAction,
    ): Promise<void> {
        const metadataKey =
            ResourceAccessService.assertSupportedResourceType(resourceType);
        const context = await this.getResourceContext(
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(
            revoker,
            action,
            resourceType,
            metadataKey,
            context,
        );
        await this.resourceAccessModel.removeUserAccess({
            userUuid: targetUserUuid,
            resourceUuid: context.resourceUuid,
            resourceType,
            action,
        });
    }

    async revokeGroupAccess(
        revoker: SessionUser,
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
        targetGroupUuid: string,
        action: ResourceAccessAction,
    ): Promise<void> {
        const metadataKey =
            ResourceAccessService.assertSupportedResourceType(resourceType);
        const context = await this.getResourceContext(
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(
            revoker,
            action,
            resourceType,
            metadataKey,
            context,
        );
        await this.resourceAccessModel.removeGroupAccess({
            groupUuid: targetGroupUuid,
            resourceUuid: context.resourceUuid,
            resourceType,
            action,
        });
    }

    /**
     * Requires `view` (the weakest grantable action) on the resource, so
     * only someone who can already see the resource can enumerate who else
     * has been granted access to it.
     */
    async listAccessForResource(
        requester: SessionUser,
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
    ): Promise<ResourceAccessGrantSummary[]> {
        const metadataKey =
            ResourceAccessService.assertSupportedResourceType(resourceType);
        const context = await this.getResourceContext(
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCan(
            requester,
            'view',
            resourceType,
            metadataKey,
            context,
        );
        return this.resourceAccessModel.listAccessForResource({
            resourceUuid: context.resourceUuid,
            resourceType,
        });
    }
}
