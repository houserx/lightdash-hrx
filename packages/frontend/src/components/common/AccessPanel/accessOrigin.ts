import { assertUnreachable, type SpaceAccess } from '@lightdash/common';

/**
 * Where a principal's access came from, in the words the sharing surfaces use.
 *
 * "Direct" is a share on the space being looked at; "Granted" is a grant on the
 * dashboard or chart itself. Two different things, so two different words --
 * collapsing them would hide whether revoking the grant actually removes access.
 */
export const ACCESS_ORIGIN_LABELS = [
    'Direct',
    'Granted',
    'Parent',
    'Group',
    'Project',
    'Organization',
] as const;

export type AccessOriginLabel = (typeof ACCESS_ORIGIN_LABELS)[number];

/** The only two fields that decide the origin, so callers can pass either shape. */
export type AccessOrigin = Pick<
    SpaceAccess,
    'hasDirectAccess' | 'inheritedFrom'
>;

export const getAccessOriginLabel = (
    access: AccessOrigin,
): AccessOriginLabel => {
    switch (access.inheritedFrom) {
        case 'direct_resource':
            return 'Granted';
        case 'parent_space':
            return 'Parent';
        case 'space_group':
            return 'Group';
        // `inheritedFrom` names where the highest *role* came from, not the
        // access, so a share on the space itself takes precedence over it.
        case 'project':
        case 'group':
            return access.hasDirectAccess ? 'Direct' : 'Project';
        case 'organization':
            return access.hasDirectAccess ? 'Direct' : 'Organization';
        case undefined:
            return 'Direct';
        default:
            return assertUnreachable(
                access.inheritedFrom,
                `Unknown access origin: ${access.inheritedFrom}`,
            );
    }
};
