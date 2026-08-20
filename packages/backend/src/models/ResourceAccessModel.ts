import {
    DirectResourceAccessOrigin,
    type DirectResourceAccess,
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
}
