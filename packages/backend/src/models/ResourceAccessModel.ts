import {
    DirectResourceAccessOrigin,
    type DirectResourceAccess,
    type ResourceAccessAction,
    type ResourceAccessResourceType,
} from '@lightdash/common';
import { Knex } from 'knex';
import { GroupMembershipTableName } from '../database/entities/groupMemberships';
import { GroupTableName } from '../database/entities/groups';
import { OrganizationMembershipsTableName } from '../database/entities/organizationMemberships';
import { OrganizationTableName } from '../database/entities/organizations';
import {
    ResourceGroupAccessTableName,
    ResourceUserAccessTableName,
} from '../database/entities/resourceAccess';
import { UserTableName } from '../database/entities/users';
import { wrapSentryTransaction } from '../utils';

/**
 * Raw reads of direct per-resource grants. Mirrors
 * `SpacePermissionModel.getDirectSpaceAccess`: batched by uuid, one focused
 * query, no role resolution -- that belongs to `resolveResourceAccess`.
 */
export class ResourceAccessModel {
    constructor(private readonly database: Knex) {}

    /**
     * Grants a single user holds on any of `resourceUuids`, whether directly or
     * through a group, keyed by resource uuid. Resources with no grants are
     * absent rather than mapped to an empty array.
     *
     * One query for the whole batch, so a list endpoint costs a fixed number of
     * round trips no matter how many items it lists. The leading column of each
     * table's unique constraint is the principal, which is what keeps both
     * branches index-driven.
     */
    async getDirectResourceAccess(
        resourceType: ResourceAccessResourceType,
        resourceUuids: string[],
        filters: { userUuid: string },
        { trx = this.database }: { trx?: Knex } = {},
    ): Promise<Record<string, DirectResourceAccess[]>> {
        const uniqueResourceUuids = [...new Set(resourceUuids)];
        if (uniqueResourceUuids.length === 0) return {};

        return wrapSentryTransaction(
            'ResourceAccessModel.getDirectResourceAccess',
            { resourceType, resourceUuidsCount: uniqueResourceUuids.length },
            async () => {
                // Annotated rather than parameterising `.select`, which no
                // longer matches an overload now the table is registered in
                // knex's Tables interface.
                const rows: DirectResourceAccess[] = await trx(
                    ResourceUserAccessTableName,
                )
                    .select({
                        userUuid: `${ResourceUserAccessTableName}.user_uuid`,
                        resourceUuid: `${ResourceUserAccessTableName}.resource_uuid`,
                        groupUuid: trx.raw('NULL'),
                        action: `${ResourceUserAccessTableName}.action`,
                        from: trx.raw('?', [
                            DirectResourceAccessOrigin.USER_ACCESS,
                        ]),
                    })
                    .where(
                        `${ResourceUserAccessTableName}.resource_type`,
                        resourceType,
                    )
                    .where(
                        `${ResourceUserAccessTableName}.user_uuid`,
                        filters.userUuid,
                    )
                    .whereIn(
                        `${ResourceUserAccessTableName}.resource_uuid`,
                        uniqueResourceUuids,
                    )
                    .union(
                        // Group grants reach a user through membership.
                        // group_memberships keys on user_id, so a user_uuid
                        // filter has to go via users.
                        trx(ResourceGroupAccessTableName)
                            .innerJoin(
                                GroupMembershipTableName,
                                `${GroupMembershipTableName}.group_uuid`,
                                `${ResourceGroupAccessTableName}.group_uuid`,
                            )
                            .innerJoin(
                                UserTableName,
                                `${UserTableName}.user_id`,
                                `${GroupMembershipTableName}.user_id`,
                            )
                            .select({
                                userUuid: `${UserTableName}.user_uuid`,
                                resourceUuid: `${ResourceGroupAccessTableName}.resource_uuid`,
                                groupUuid: `${ResourceGroupAccessTableName}.group_uuid`,
                                action: `${ResourceGroupAccessTableName}.action`,
                                from: trx.raw('?', [
                                    DirectResourceAccessOrigin.GROUP_ACCESS,
                                ]),
                            })
                            .where(
                                `${ResourceGroupAccessTableName}.resource_type`,
                                resourceType,
                            )
                            .where(
                                `${UserTableName}.user_uuid`,
                                filters.userUuid,
                            )
                            .whereIn(
                                `${ResourceGroupAccessTableName}.resource_uuid`,
                                uniqueResourceUuids,
                            ),
                    );

                return rows.reduce<Record<string, DirectResourceAccess[]>>(
                    (acc, row) => {
                        if (!acc[row.resourceUuid]) {
                            acc[row.resourceUuid] = [];
                        }
                        acc[row.resourceUuid].push(row);
                        return acc;
                    },
                    {},
                );
            },
        );
    }

    /**
     * Upserts a user grant. Re-granting the same action is idempotent rather than
     * an error, matching how space sharing behaves.
     */
    async addUserAccess({
        resourceType,
        resourceUuid,
        projectUuid,
        targetUserUuid,
        action,
        grantedByUserUuid,
    }: {
        resourceType: ResourceAccessResourceType;
        resourceUuid: string;
        projectUuid: string;
        targetUserUuid: string;
        action: ResourceAccessAction;
        grantedByUserUuid: string;
    }): Promise<void> {
        await this.database(ResourceUserAccessTableName)
            .insert({
                user_uuid: targetUserUuid,
                resource_uuid: resourceUuid,
                resource_type: resourceType,
                project_uuid: projectUuid,
                action,
                granted_by: grantedByUserUuid,
            })
            .onConflict([
                'user_uuid',
                'resource_uuid',
                'resource_type',
                'action',
            ])
            .merge(['granted_by']);
    }

    async addGroupAccess({
        resourceType,
        resourceUuid,
        projectUuid,
        targetGroupUuid,
        action,
        grantedByUserUuid,
    }: {
        resourceType: ResourceAccessResourceType;
        resourceUuid: string;
        projectUuid: string;
        targetGroupUuid: string;
        action: ResourceAccessAction;
        grantedByUserUuid: string;
    }): Promise<void> {
        await this.database(ResourceGroupAccessTableName)
            .insert({
                group_uuid: targetGroupUuid,
                resource_uuid: resourceUuid,
                resource_type: resourceType,
                project_uuid: projectUuid,
                action,
                granted_by: grantedByUserUuid,
            })
            .onConflict([
                'group_uuid',
                'resource_uuid',
                'resource_type',
                'action',
            ])
            .merge(['granted_by']);
    }

    async removeUserAccess({
        resourceType,
        resourceUuid,
        targetUserUuid,
        action,
    }: {
        resourceType: ResourceAccessResourceType;
        resourceUuid: string;
        targetUserUuid: string;
        action: ResourceAccessAction;
    }): Promise<void> {
        await this.database(ResourceUserAccessTableName)
            .where('resource_type', resourceType)
            .where('resource_uuid', resourceUuid)
            .where('user_uuid', targetUserUuid)
            .where('action', action)
            .delete();
    }

    async removeGroupAccess({
        resourceType,
        resourceUuid,
        targetGroupUuid,
        action,
    }: {
        resourceType: ResourceAccessResourceType;
        resourceUuid: string;
        targetGroupUuid: string;
        action: ResourceAccessAction;
    }): Promise<void> {
        await this.database(ResourceGroupAccessTableName)
            .where('resource_type', resourceType)
            .where('resource_uuid', resourceUuid)
            .where('group_uuid', targetGroupUuid)
            .where('action', action)
            .delete();
    }

    /**
     * Every grant held on one resource. Read as two focused queries rather than a
     * UNION: user and group grants carry different metadata, so callers want them
     * apart.
     */
    async listResourceAccess(
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
    ): Promise<{
        users: { userUuid: string; action: ResourceAccessAction }[];
        groups: { groupUuid: string; action: ResourceAccessAction }[];
    }> {
        const [users, groups] = await Promise.all([
            this.database(ResourceUserAccessTableName)
                .where('resource_type', resourceType)
                .where('resource_uuid', resourceUuid)
                .select({
                    userUuid: 'user_uuid',
                    action: 'action',
                }),
            this.database(ResourceGroupAccessTableName)
                .where('resource_type', resourceType)
                .where('resource_uuid', resourceUuid)
                .select({
                    groupUuid: 'group_uuid',
                    action: 'action',
                }),
        ]);

        return { users, groups };
    }

    /**
     * Whether a user holds a membership in this organization. Used to reject a
     * grant whose recipient is outside the resource's organization -- without it,
     * the only constraint is the foreign key to users, which means "some user
     * exists somewhere in this instance", not "this user is in this org".
     */
    async isUserInOrganization(
        organizationUuid: string,
        userUuid: string,
    ): Promise<boolean> {
        const match = await this.database(OrganizationMembershipsTableName)
            .innerJoin(
                OrganizationTableName,
                `${OrganizationTableName}.organization_id`,
                `${OrganizationMembershipsTableName}.organization_id`,
            )
            .innerJoin(
                UserTableName,
                `${UserTableName}.user_id`,
                `${OrganizationMembershipsTableName}.user_id`,
            )
            .where(
                `${OrganizationTableName}.organization_uuid`,
                organizationUuid,
            )
            .where(`${UserTableName}.user_uuid`, userUuid)
            .select({ userUuid: `${UserTableName}.user_uuid` })
            .first();

        return match !== undefined;
    }

    /** The group counterpart of `isUserInOrganization`. */
    async isGroupInOrganization(
        organizationUuid: string,
        groupUuid: string,
    ): Promise<boolean> {
        const match = await this.database(GroupTableName)
            .innerJoin(
                OrganizationTableName,
                `${OrganizationTableName}.organization_id`,
                `${GroupTableName}.organization_id`,
            )
            .where(
                `${OrganizationTableName}.organization_uuid`,
                organizationUuid,
            )
            .where(`${GroupTableName}.group_uuid`, groupUuid)
            .select({ groupUuid: `${GroupTableName}.group_uuid` })
            .first();

        return match !== undefined;
    }

    /**
     * Removes every grant held on one resource, for a hard delete.
     *
     * `resource_uuid` is polymorphic across resource types, so the grant tables
     * carry no foreign key to the resource and ON DELETE CASCADE cannot reach
     * them the way it does for `space_user_access`. Scoped by resource type as
     * well as uuid, so a SavedChart grant survives a Dashboard purge.
     */
    async removeAllForResource(
        resourceType: ResourceAccessResourceType,
        resourceUuid: string,
    ): Promise<void> {
        await Promise.all([
            this.database(ResourceUserAccessTableName)
                .where('resource_type', resourceType)
                .where('resource_uuid', resourceUuid)
                .delete(),
            this.database(ResourceGroupAccessTableName)
                .where('resource_type', resourceType)
                .where('resource_uuid', resourceUuid)
                .delete(),
        ]);
    }

    /**
     * Resource uuids this user holds any grant on, directly or through a group,
     * across the given projects and resource types.
     *
     * The inverse of `getDirectResourceAccess`: content browse filters by space
     * reachability before it knows which resources it will return, so it cannot
     * ask about specific uuids. `project_uuid` is indexed for this.
     *
     * Projects and resource types are matched with `whereIn` rather than looped
     * over, so browse costs one round trip however many projects are in view.
     */
    async getGrantedResourceUuids(
        userUuid: string,
        projectUuids: string[],
        resourceTypes: readonly ResourceAccessResourceType[],
    ): Promise<string[]> {
        if (projectUuids.length === 0 || resourceTypes.length === 0) {
            return [];
        }

        const rows = await this.database(ResourceUserAccessTableName)
            .select<{ resourceUuid: string }[]>({
                resourceUuid: `${ResourceUserAccessTableName}.resource_uuid`,
            })
            .whereIn(`${ResourceUserAccessTableName}.resource_type`, [
                ...resourceTypes,
            ])
            .whereIn(
                `${ResourceUserAccessTableName}.project_uuid`,
                projectUuids,
            )
            .where(`${ResourceUserAccessTableName}.user_uuid`, userUuid)
            .union(
                this.database(ResourceGroupAccessTableName)
                    .innerJoin(
                        GroupMembershipTableName,
                        `${GroupMembershipTableName}.group_uuid`,
                        `${ResourceGroupAccessTableName}.group_uuid`,
                    )
                    .innerJoin(
                        UserTableName,
                        `${UserTableName}.user_id`,
                        `${GroupMembershipTableName}.user_id`,
                    )
                    .select({
                        resourceUuid: `${ResourceGroupAccessTableName}.resource_uuid`,
                    })
                    .whereIn(`${ResourceGroupAccessTableName}.resource_type`, [
                        ...resourceTypes,
                    ])
                    .whereIn(
                        `${ResourceGroupAccessTableName}.project_uuid`,
                        projectUuids,
                    )
                    .where(`${UserTableName}.user_uuid`, userUuid),
            );

        return rows.map((row) => row.resourceUuid);
    }
}
