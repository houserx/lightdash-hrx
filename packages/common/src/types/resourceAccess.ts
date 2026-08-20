import { type KnexPaginatedData } from './knex-paginate';
import { type SpaceAccess, type SpaceShare } from './space';

/**
 * Resource types that can carry a direct grant. Deliberately narrow: each one
 * needs a CASL subject whose access-gated rules read the `access` array, and a
 * cascade-delete hook, before it can be added here.
 */
export type ResourceAccessResourceType = 'Dashboard' | 'SavedChart';

/**
 * What a grant confers. Maps onto the space role vocabulary rather than
 * introducing a parallel one, so existing access-gated CASL conditions apply
 * unchanged -- see `resourceAccessResolver`.
 */
export type ResourceAccessAction = 'view' | 'manage';

export enum DirectResourceAccessOrigin {
    USER_ACCESS = 'user_access',
    GROUP_ACCESS = 'group_access',
}

/**
 * One persisted grant, already expanded to the user it applies to. A grant made
 * to a group yields one row per group member, with `groupUuid` recording where
 * it came from.
 */
export type DirectResourceAccess = {
    userUuid: string;
    resourceUuid: string;
    groupUuid: string | null;
    action: ResourceAccessAction;
    from: DirectResourceAccessOrigin;
};

export type ResourceAccessWithGrantsInput = {
    /** Grants for any other resource uuid are ignored. */
    resourceUuid: string;
    /** Output of `resolveSpaceAccess` for the space this resource lives in. */
    spaceAccess: SpaceAccess[];
    directResourceAccess: DirectResourceAccess[];
};

export type AddResourceUserAccess = {
    userUuid: string;
    action: ResourceAccessAction;
};

export type AddResourceGroupAccess = {
    groupUuid: string;
    action: ResourceAccessAction;
};

/**
 * User and group grants are kept apart rather than flattened into one list with
 * nullable `userUuid`/`groupUuid` fields -- that shape makes "which kind of grant
 * is this" a runtime question when it is statically known.
 */
export type ResourceAccessList = {
    users: { userUuid: string; action: ResourceAccessAction }[];
    groups: { groupUuid: string; action: ResourceAccessAction }[];
};

export type ApiResourceAccessListResponse = {
    status: 'ok';
    results: ResourceAccessList;
};

/**
 * One principal's resolved access to a resource, with the display metadata a
 * people list needs.
 *
 * Deliberately the same shape as `SpaceShare`, because it is the same thing: a
 * grant resolves into an ordinary space-access entry rather than a parallel kind
 * of access, so `inheritedFrom: 'direct_resource'` sits in one list beside
 * `'project'` and `'parent_space'`, ordered by the same most-permissive-wins
 * rule. Two names for one shape would imply two mechanisms.
 */
export type ResourceShare = SpaceShare;

/** Mirrors SpaceAccessListFilters, so the two endpoints filter alike. */
export type ResourceAccessListFilters = {
    searchQuery?: string;
    userUuids?: string[];
    /** Only entries with direct access -- a grant, or a direct space share. */
    directOnly?: boolean;
};

export type ApiResourceShareListResponse = {
    status: 'ok';
    results: KnexPaginatedData<ResourceShare[]>;
};
