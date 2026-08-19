import {
    type ResourceAccessAction,
    type ResourceAccessResourceType,
} from '@lightdash/common';
import { Knex } from 'knex';

/**
 * Direct per-resource grants. The `resource_type` and `action` unions come from
 * @lightdash/common so there is one source of truth for the vocabulary; the
 * literal lists in the migration's CHECK constraints are the deliberately frozen
 * copy, and the migration test pins them. Widening the union without a matching
 * migration therefore fails loudly at insert time rather than silently storing a
 * value nothing else understands.
 */
export type DbResourceUserAccess = {
    resource_user_access_uuid: string;
    user_uuid: string;
    resource_uuid: string;
    resource_type: ResourceAccessResourceType;
    project_uuid: string;
    action: ResourceAccessAction;
    granted_by: string | null;
    created_at: Date;
};

export type CreateDbResourceUserAccess = Pick<
    DbResourceUserAccess,
    | 'user_uuid'
    | 'resource_uuid'
    | 'resource_type'
    | 'project_uuid'
    | 'action'
    | 'granted_by'
>;

export type ResourceUserAccessTable = Knex.CompositeTableType<
    DbResourceUserAccess,
    CreateDbResourceUserAccess
>;

export const ResourceUserAccessTableName = 'resource_user_access';

export type DbResourceGroupAccess = {
    resource_group_access_uuid: string;
    group_uuid: string;
    resource_uuid: string;
    resource_type: ResourceAccessResourceType;
    project_uuid: string;
    action: ResourceAccessAction;
    granted_by: string | null;
    created_at: Date;
};

export type CreateDbResourceGroupAccess = Pick<
    DbResourceGroupAccess,
    | 'group_uuid'
    | 'resource_uuid'
    | 'resource_type'
    | 'project_uuid'
    | 'action'
    | 'granted_by'
>;

export type ResourceGroupAccessTable = Knex.CompositeTableType<
    DbResourceGroupAccess,
    CreateDbResourceGroupAccess
>;

export const ResourceGroupAccessTableName = 'resource_group_access';
