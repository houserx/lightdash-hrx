import {
    type DirectResourceAccess,
    type ResourceAccessAction,
    type ResourceAccessWithGrantsInput,
} from '../../types/resourceAccess';
import { SpaceMemberRole, type SpaceAccess } from '../../types/space';
import { getHighestSpaceRole } from '../../utils/projectMemberRole';

/**
 * A grant is expressed in the space role vocabulary so that every access-gated
 * CASL rule applies to it unchanged. `manage` maps to EDITOR because that is
 * the role the `manage:*@space` rules test for; ADMIN is deliberately
 * unreachable from a grant, since space administration is not a per-resource
 * concept.
 */
const GRANT_ACTION_TO_SPACE_ROLE: Record<
    ResourceAccessAction,
    SpaceMemberRole
> = {
    view: SpaceMemberRole.VIEWER,
    manage: SpaceMemberRole.EDITOR,
};

const grantedRoleByUser = (
    grants: DirectResourceAccess[],
): Map<string, SpaceMemberRole> => {
    const byUser = new Map<string, SpaceMemberRole>();

    grants.forEach((grant) => {
        const grantedRole = GRANT_ACTION_TO_SPACE_ROLE[grant.action];
        // Most permissive source wins. This diverges from space access, where a
        // direct user entry beats a group entry regardless of height so that an
        // admin can hold someone below their group's level. Grants are purely
        // additive and cannot revoke, so there is nothing to be gained by
        // letting a lower grant win -- and treating them additively is what
        // makes "adding a grant never lowers access" a real invariant.
        byUser.set(
            grant.userUuid,
            getHighestSpaceRole([byUser.get(grant.userUuid), grantedRole]) ??
                grantedRole,
        );
    });

    return byUser;
};

/**
 * Folds direct per-resource grants into the access entries already resolved for
 * the resource's space, producing the `access` array a Dashboard/SavedChart
 * CASL subject carries.
 *
 * Runs *after* `resolveSpaceAccess`, not inside it: that resolver drops any user
 * without an org or project role (its `highestRole` gate), which would silently
 * discard users who hold nothing but a grant.
 *
 * Existing entries keep their input order; users who appear only via a grant are
 * appended sorted by uuid, so the output does not depend on the order grants
 * arrive in.
 */
export const resolveResourceAccess = ({
    resourceUuid,
    spaceAccess,
    directResourceAccess,
}: ResourceAccessWithGrantsInput): SpaceAccess[] => {
    const grantsForResource = directResourceAccess.filter(
        (grant) => grant.resourceUuid === resourceUuid,
    );

    if (grantsForResource.length === 0) return spaceAccess;

    const grantedRoles = grantedRoleByUser(grantsForResource);

    const merged = spaceAccess.map((entry) => {
        const grantedRole = grantedRoles.get(entry.userUuid);
        if (grantedRole === undefined) return entry;

        grantedRoles.delete(entry.userUuid);

        const effectiveRole =
            getHighestSpaceRole([entry.role, grantedRole]) ?? entry.role;
        // Only re-attribute when the grant is what earned the role, so audit
        // output keeps pointing at whichever source actually decided it.
        const grantDecided = effectiveRole !== entry.role;

        return {
            ...entry,
            role: effectiveRole,
            hasDirectAccess: true,
            ...(grantDecided
                ? { inheritedFrom: 'direct_resource' as const }
                : {}),
        };
    });

    const grantOnly: SpaceAccess[] = [...grantedRoles.entries()]
        .sort(([leftUuid], [rightUuid]) => leftUuid.localeCompare(rightUuid))
        .map(([userUuid, role]) => ({
            userUuid,
            role,
            hasDirectAccess: true,
            projectRole: undefined,
            inheritedRole: undefined,
            inheritedFrom: 'direct_resource',
        }));

    return [...merged, ...grantOnly];
};
