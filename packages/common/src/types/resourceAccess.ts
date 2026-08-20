import { type SpaceAccess } from './space';

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
