import {
    DirectResourceAccessOrigin,
    type DirectResourceAccess,
    type ResourceAccessAction,
    type ResourceAccessResourceType,
} from '@lightdash/common';
import { Knex } from 'knex';
import { GroupMembershipTableName } from '../database/entities/groupMemberships';
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
                const rows = await trx(ResourceUserAccessTableName)
                    .select<DirectResourceAccess[]>({
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
}
