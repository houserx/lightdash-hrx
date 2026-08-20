import { subject } from '@casl/ability';
import {
    ForbiddenError,
    ParameterError,
    type ResourceAccessAction,
    type ResourceAccessResourceType,
    type SessionUser,
} from '@lightdash/common';
import { type LightdashConfig } from '../../config/parseConfig';
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
    lightdashConfig: LightdashConfig;
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
 * Administering grants requires `manage` on the resource -- the same bar space
 * sharing sets on a space, and deliberately not the action being granted. Checked
 * by building the same subject shape the real read and update gates build, so
 * being an org admin is not the test: it is whether they could edit this
 * particular resource.
 *
 * Requiring the action instead would mean anyone who can *see* a resource could
 * widen access to it, and a user whose own way in was a `view` grant could pass
 * that grant on -- unbounded, with no manage right anywhere in the chain. A
 * `manage` grant still confers granting authority, which is the transitive
 * property space sharing genuinely has.
 *
 * Reads sit at the same bar as writes. The list names who was individually
 * singled out and who granted it, which is administrative rather than
 * informational.
 */
export class ResourceAccessService extends BaseService {
    private readonly dashboardModel: DashboardModel;

    private readonly savedChartModel: SavedChartModel;

    private readonly resourceAccessModel: ResourceAccessModel;

    private readonly spacePermissionService: SpacePermissionService;

    private readonly lightdashConfig: LightdashConfig;

    constructor({
        dashboardModel,
        savedChartModel,
        resourceAccessModel,
        spacePermissionService,
        lightdashConfig,
    }: ResourceAccessServiceArguments) {
        super();
        this.dashboardModel = dashboardModel;
        this.savedChartModel = savedChartModel;
        this.resourceAccessModel = resourceAccessModel;
        this.spacePermissionService = spacePermissionService;
        this.lightdashConfig = lightdashConfig;
    }

    /**
     * While direct grants are off, permission resolution skips the grant lookup
     * entirely, so a row written now changes nobody's access. Accepting the write
     * anyway would report success for something that silently does nothing, and
     * leave rows behind that start mattering the moment the flag is flipped.
     *
     * Called before the resource is resolved, so a disabled instance cannot be
     * used to probe which uuids exist.
     */
    private throwIfDisabled(): void {
        if (!this.lightdashConfig.resourceGrants.enabled) {
            throw new ForbiddenError('Direct resource grants are not enabled');
        }
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
            };
        }
        const chart = await this.savedChartModel.getSummary(resourceUuid);
        return {
            organizationUuid: chart.organizationUuid,
            projectUuid: chart.projectUuid,
            spaceUuid: chart.spaceUuid,
            resourceUuid: chart.uuid,
        };
    }

    /**
     * Mirrors the subject shape DashboardService and SavedChartService build at
     * their real check sites, so the requester passes if and only if they could
     * edit this particular resource.
     *
     * Takes no action parameter on purpose. Every caller here needs the same
     * answer, and the previous shape -- passing in the action being granted --
     * looked correct at each call site while adding up to "anyone who can see it
     * can share it". There is no longer an argument to get wrong.
     *
     * Resolves through the resource-aware context, so a `manage` grant counts
     * toward the holder's authority to grant onward.
     */
    private async assertRequesterCanAdministerGrants(
        requester: SessionUser,
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
                'manage',
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
                `You don't have permission to manage access to this ${resourceType}`,
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
            resourceType,
            resourceUuid,
            targetUserUuid,
            action,
        }: {
            resourceType: ResourceAccessResourceType;
            resourceUuid: string;
            targetUserUuid: string;
            action: ResourceAccessAction;
        },
    ): Promise<void> {
        this.throwIfDisabled();

        const context = await this.getResourceContext(
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCanAdministerGrants(
            granter,
            resourceType,
            context,
        );
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
            resourceType,
            resourceUuid,
            targetGroupUuid,
            action,
        }: {
            resourceType: ResourceAccessResourceType;
            resourceUuid: string;
            targetGroupUuid: string;
            action: ResourceAccessAction;
        },
    ): Promise<void> {
        this.throwIfDisabled();

        const context = await this.getResourceContext(
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCanAdministerGrants(
            granter,
            resourceType,
            context,
        );
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
            resourceType,
            resourceUuid,
            targetUserUuid,
            action,
        }: {
            resourceType: ResourceAccessResourceType;
            resourceUuid: string;
            targetUserUuid: string;
            action: ResourceAccessAction;
        },
    ): Promise<void> {
        this.throwIfDisabled();

        const context = await this.getResourceContext(
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCanAdministerGrants(
            revoker,
            resourceType,
            context,
        );

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
            resourceType,
            resourceUuid,
            targetGroupUuid,
            action,
        }: {
            resourceType: ResourceAccessResourceType;
            resourceUuid: string;
            targetGroupUuid: string;
            action: ResourceAccessAction;
        },
    ): Promise<void> {
        this.throwIfDisabled();

        const context = await this.getResourceContext(
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCanAdministerGrants(
            revoker,
            resourceType,
            context,
        );

        await this.resourceAccessModel.removeGroupAccess({
            resourceType,
            resourceUuid: context.resourceUuid,
            targetGroupUuid,
            action,
        });
    }

    async listResourceAccess(
        requester: SessionUser,
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
    ) {
        this.throwIfDisabled();

        const context = await this.getResourceContext(
            resourceType,
            resourceUuid,
        );
        await this.assertRequesterCanAdministerGrants(
            requester,
            resourceType,
            context,
        );

        return this.resourceAccessModel.listResourceAccess(
            resourceType,
            context.resourceUuid,
        );
    }
}
