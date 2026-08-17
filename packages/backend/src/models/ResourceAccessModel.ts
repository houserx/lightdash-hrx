import {
    type ResourceAccessAction,
    type ResourceAccessGrantSummary,
    type ResourceAccessResourceType,
} from '@lightdash/common';
import { Knex } from 'knex';
import {
    ResourceGroupAccessTableName,
    ResourceUserAccessTableName,
} from '../database/entities/resourceAccess';

type ResourceAccessModelArguments = {
    database: Knex;
};

export class ResourceAccessModel {
    private readonly database: Knex;

    constructor({ database }: ResourceAccessModelArguments) {
        this.database = database;
    }

    async addUserAccess({
        userUuid,
        resourceUuid,
        resourceType,
        projectUuid,
        action,
        grantedByUserUuid,
    }: {
        userUuid: string;
        resourceUuid: string;
        resourceType: ResourceAccessResourceType;
        projectUuid: string;
        action: ResourceAccessAction;
        grantedByUserUuid: string | null;
    }): Promise<void> {
        await this.database(ResourceUserAccessTableName)
            .insert({
                user_uuid: userUuid,
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
            .merge();
    }

    async addGroupAccess({
        groupUuid,
        resourceUuid,
        resourceType,
        projectUuid,
        action,
        grantedByUserUuid,
    }: {
        groupUuid: string;
        resourceUuid: string;
        resourceType: ResourceAccessResourceType;
        projectUuid: string;
        action: ResourceAccessAction;
        grantedByUserUuid: string | null;
    }): Promise<void> {
        await this.database(ResourceGroupAccessTableName)
            .insert({
                group_uuid: groupUuid,
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
            .merge();
    }

    async removeUserAccess({
        userUuid,
        resourceUuid,
        resourceType,
        action,
    }: {
        userUuid: string;
        resourceUuid: string;
        resourceType: ResourceAccessResourceType;
        action: ResourceAccessAction;
    }): Promise<void> {
        await this.database(ResourceUserAccessTableName)
            .where('user_uuid', userUuid)
            .andWhere('resource_uuid', resourceUuid)
            .andWhere('resource_type', resourceType)
            .andWhere('action', action)
            .delete();
    }

    async removeGroupAccess({
        groupUuid,
        resourceUuid,
        resourceType,
        action,
    }: {
        groupUuid: string;
        resourceUuid: string;
        resourceType: ResourceAccessResourceType;
        action: ResourceAccessAction;
    }): Promise<void> {
        await this.database(ResourceGroupAccessTableName)
            .where('group_uuid', groupUuid)
            .andWhere('resource_uuid', resourceUuid)
            .andWhere('resource_type', resourceType)
            .andWhere('action', action)
            .delete();
    }

    async listAccessForResource({
        resourceUuid,
        resourceType,
    }: {
        resourceUuid: string;
        resourceType: ResourceAccessResourceType;
    }): Promise<ResourceAccessGrantSummary[]> {
        const [userRows, groupRows] = await Promise.all([
            this.database(ResourceUserAccessTableName)
                .select('user_uuid', 'action', 'granted_by', 'created_at')
                .where('resource_uuid', resourceUuid)
                .andWhere('resource_type', resourceType),
            this.database(ResourceGroupAccessTableName)
                .select('group_uuid', 'action', 'granted_by', 'created_at')
                .where('resource_uuid', resourceUuid)
                .andWhere('resource_type', resourceType),
        ]);

        return [
            ...userRows.map((row) => ({
                userUuid: row.user_uuid as string,
                groupUuid: null,
                action: row.action as ResourceAccessAction,
                grantedByUserUuid: row.granted_by as string | null,
                createdAt: row.created_at as Date,
            })),
            ...groupRows.map((row) => ({
                userUuid: null,
                groupUuid: row.group_uuid as string,
                action: row.action as ResourceAccessAction,
                grantedByUserUuid: row.granted_by as string | null,
                createdAt: row.created_at as Date,
            })),
        ];
    }
}
