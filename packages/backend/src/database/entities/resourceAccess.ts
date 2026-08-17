import { Knex } from 'knex';

export type ResourceAccessResourceType = 'Dashboard' | 'SavedChart';
export type ResourceAccessAction = 'view' | 'manage';

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
    DbResourceUserAccess | CreateDbResourceUserAccess
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
    DbResourceGroupAccess | CreateDbResourceGroupAccess
>;

export const ResourceGroupAccessTableName = 'resource_group_access';
