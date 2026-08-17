import {
    ForbiddenError,
    getAllScopesForOrgRole,
    getPermissionsFromScopes,
    getUncoveredPermissions,
    OrganizationMemberRole,
    resolveEffectiveOrgRoleUuid,
    resolveRoleScopes,
    type SessionUser,
} from '@lightdash/common';
import { RolesModel } from '../models/RolesModel';

/**
 * A system role's scopes, preferring `scoped_roles` (via its well-known
 * role_uuid, see A14's resolveEffectiveOrgRoleUuid) over the literal
 * `orgRoleToScopeMapping.ts` map -- the same DB-first, literal-map-fallback
 * resolution `getUserAbilityBuilder` uses for ability building (A15),
 * applied here to the confused-deputy grant check instead.
 */
export const getOrganizationSystemRoleScopes = async (
    role: OrganizationMemberRole,
    rolesModel: RolesModel,
    { includePersonalAccessToken = false } = {},
): Promise<string[]> => {
    const effectiveRoleUuid = resolveEffectiveOrgRoleUuid({
        role,
        roleUuid: undefined,
    });
    const dbScopes = await rolesModel.getScopesByRoleUuid(effectiveRoleUuid);
    const scopes = resolveRoleScopes({
        effectiveRoleUuid,
        hasCustomRoleUuid: false,
        systemRoleScopes: getAllScopesForOrgRole(role),
        customRoleScopes: dbScopes
            ? { [effectiveRoleUuid]: dbScopes }
            : undefined,
    });
    // hasCustomRoleUuid: false guarantees resolveRoleScopes never returns
    // undefined -- it only fails closed for a genuine custom role_uuid.
    const permissions = getPermissionsFromScopes(scopes as string[]);
    return includePersonalAccessToken
        ? [...permissions, 'manage:PersonalAccessToken']
        : permissions;
};

const getCallerOrganizationScopes = async (
    user: SessionUser,
    organizationUuid: string,
    rolesModel: RolesModel,
): Promise<string[]> => {
    // A caller carrying no organization must not have its scopes resolved
    // against one, so compare directly rather than guarding on presence.
    if (!user.role || user.organizationUuid !== organizationUuid) {
        throw new ForbiddenError('You do not have permission');
    }

    // Custom roles never list this scope, but the ability builder still grants
    // it from the PAT config, so it is part of the caller's real footprint.
    const canManagePersonalAccessToken = user.ability.can(
        'manage',
        'PersonalAccessToken',
    );

    if (!user.roleUuid) {
        return getOrganizationSystemRoleScopes(user.role, rolesModel, {
            includePersonalAccessToken: canManagePersonalAccessToken,
        });
    }

    // The caller's runtime ability is built from this role's scopes whatever
    // its level, so the scopes are the caller's footprint either way.
    const role = await rolesModel.getRoleWithScopesByUuid(user.roleUuid);
    if (role.organizationUuid !== organizationUuid) {
        throw new ForbiddenError('You do not have permission');
    }

    return canManagePersonalAccessToken
        ? [...role.scopes, 'manage:PersonalAccessToken']
        : role.scopes;
};

export const validateOrganizationScopesCanBeGranted = async ({
    user,
    organizationUuid,
    grantedScopes,
    rolesModel,
}: {
    user: SessionUser;
    organizationUuid: string;
    grantedScopes: string[];
    rolesModel: RolesModel;
}): Promise<void> => {
    const callerScopes = await getCallerOrganizationScopes(
        user,
        organizationUuid,
        rolesModel,
    );
    const uncoveredScopes = getUncoveredPermissions(
        grantedScopes,
        callerScopes,
    );

    if (uncoveredScopes.length > 0) {
        throw new ForbiddenError('Cannot grant permissions exceeding your own');
    }
};
