/**
 * Resolves the scope list to use for a principal's effective role_uuid
 * (custom or well-known-system, see systemRoleUuids.ts). `customRoleScopes`
 * (a batched `scoped_roles` read) is checked first, uniformly, for both
 * kinds of role -- this is what makes it "one path" rather than a branch
 * that only ever attempts the DB for custom roles.
 *
 * A custom role_uuid with no matching row is a dangling reference and
 * fails closed (returns undefined; callers decide how to log/report it).
 * A well-known system role_uuid with no matching row falls back to the
 * literal scope-list modules (roleToScopeMapping.ts /
 * orgRoleToScopeMapping.ts) -- a transitional safety net for callers or
 * environments where `scoped_roles` isn't populated yet (e.g. the seed
 * migration hasn't run, or a test doesn't bother supplying it). Once every
 * caller always finds its well-known uuids in `scoped_roles`, this branch
 * is dead and can be deleted along with the literal-map modules.
 */
export const resolveRoleScopes = ({
    effectiveRoleUuid,
    hasCustomRoleUuid,
    systemRoleScopes,
    customRoleScopes,
}: {
    effectiveRoleUuid: string;
    hasCustomRoleUuid: boolean;
    systemRoleScopes: string[];
    customRoleScopes?: Record<string, string[]>;
}): string[] | undefined => {
    const dbScopes = customRoleScopes?.[effectiveRoleUuid];
    if (dbScopes) {
        return dbScopes;
    }
    return hasCustomRoleUuid ? undefined : systemRoleScopes;
};
