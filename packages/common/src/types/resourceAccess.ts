import { type ResourceAccessAction } from '../authorization/resourceAccessAbility';

export type AddResourceUserAccess = {
    userUuid: string;
    action: ResourceAccessAction;
};

export type AddResourceGroupAccess = {
    groupUuid: string;
    action: ResourceAccessAction;
};

export type ResourceAccessGrantSummary = {
    userUuid: string | null;
    groupUuid: string | null;
    action: ResourceAccessAction;
    grantedByUserUuid: string | null;
    createdAt: Date;
};

export type ApiResourceAccessListResponse = {
    status: 'ok';
    results: ResourceAccessGrantSummary[];
};
