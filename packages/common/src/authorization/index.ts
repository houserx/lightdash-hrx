import { Ability, AbilityBuilder } from '@casl/ability';
import { NotFoundError } from '../types/errors';
import { type ProjectMemberProfile } from '../types/projectMemberProfile';
import { type ProjectType } from '../types/projects';
import { type Role, type RoleWithScopes } from '../types/roles';
import { type LightdashUser } from '../types/user';
import { collapseAbilityRules } from './collapseAbilityRules';
import applyOrganizationMemberAbilities, {
    type OrganizationMemberAbilitiesArgs,
} from './organizationMemberAbility';
import { getAllScopesForOrgRole } from './orgRoleToScopeMapping';
import { projectMemberAbilities } from './projectMemberAbility';
import { getAllScopesForRole } from './roleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

/**
 * Project membership plus the project metadata needed by @self scope
 * conditions (resolved at ability-build time, not per permission check).
 */
export type ProjectAbilityProfile = Pick<
    ProjectMemberProfile,
    'projectUuid' | 'role' | 'userUuid' | 'roleUuid'
> & {
    projectType?: ProjectType;
    projectCreatedByUserUuid?: string | null;
};

type UserAbilityBuilderArgs = {
    user: Pick<
        LightdashUser,
        'role' | 'organizationUuid' | 'userUuid' | 'roleUuid'
    >;
    projectProfiles: ProjectAbilityProfile[];
    permissionsConfig: OrganizationMemberAbilitiesArgs['permissionsConfig'];
    customRoleScopes?: Record<Role['roleUuid'], RoleWithScopes['scopes']>;
    customRolesEnabled?: boolean;
    isEnterprise?: boolean;
    /**
     * Feature-flagged, defaults to off/omitted. When true, a system role
     * (org-level, or a project membership without a custom role_uuid)
     * builds its ability via `buildAbilityFromScopes(getAllScopesForRole(role))`
     * / `getAllScopesForOrgRole(role)` instead of the hand-written
     * `applyOrganizationMemberAbilities`/`projectMemberAbilities[role]`.
     * Both paths are verified behaviorally equivalent (modulo documented,
     * waived exceptions) by `differentialEquivalence.test.ts` -- this flag
     * exists to stage the cutover safely in production, not because the two
     * paths are expected to diverge. See plan items A5/A6.
     */
    scopeComposedSystemRolesEnabled?: boolean;
};

export const JWT_HEADER_NAME = 'lightdash-embed-token';

export type UserAbilityBuilderResult = {
    builder: AbilityBuilder<MemberAbility>;
    invalidScopes: string[];
};

export const getUserAbilityBuilder = ({
    user,
    projectProfiles,
    permissionsConfig,
    customRoleScopes,
    customRolesEnabled,
    isEnterprise,
    scopeComposedSystemRolesEnabled,
}: UserAbilityBuilderArgs): UserAbilityBuilderResult => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    const invalidScopes: string[] = [];
    if (user.role && user.organizationUuid) {
        // Org-level custom role: if the user's organization_memberships row
        // points at a role_uuid AND custom roles are enabled AND we have the
        // role's scopes, build CASL from those scopes (same path as
        // project-level custom roles below). Falls back to the system role
        // path otherwise.
        const orgCustomRoleScopes =
            customRolesEnabled && user.roleUuid
                ? customRoleScopes?.[user.roleUuid]
                : undefined;

        if (orgCustomRoleScopes) {
            invalidScopes.push(
                ...buildAbilityFromScopes(
                    {
                        organizationUuid: user.organizationUuid,
                        userUuid: user.userUuid,
                        scopes: orgCustomRoleScopes,
                        isEnterprise,
                        organizationRole: user.role,
                        permissionsConfig,
                    },
                    builder,
                ),
            );
        } else if (scopeComposedSystemRolesEnabled) {
            // buildAbilityFromScopes applies the dynamic PAT gate itself
            // (see handlePatConfigApplication in scopeAbilityBuilder.ts),
            // keyed on organizationRole -- no separate dynamic-abilities
            // call needed here, unlike the applyOrganizationMemberAbilities
            // wrapper below.
            invalidScopes.push(
                ...buildAbilityFromScopes(
                    {
                        organizationUuid: user.organizationUuid,
                        userUuid: user.userUuid,
                        scopes: getAllScopesForOrgRole(user.role),
                        isEnterprise,
                        organizationRole: user.role,
                        permissionsConfig,
                    },
                    builder,
                ),
            );
        } else {
            applyOrganizationMemberAbilities({
                role: user.role,
                member: {
                    organizationUuid: user.organizationUuid,
                    userUuid: user.userUuid,
                },
                builder,
                permissionsConfig,
            });
        }

        projectProfiles.forEach((projectProfile) => {
            if (projectProfile.roleUuid && customRolesEnabled) {
                if (!user.organizationUuid) {
                    throw new NotFoundError(
                        `Organization with uuid ${user.organizationUuid} was not found`,
                    );
                }

                const scopes = customRoleScopes?.[projectProfile.roleUuid];
                if (!scopes) {
                    // eslint-disable-next-line no-console
                    console.error(
                        `Custom role with uuid ${projectProfile.roleUuid} was not found`,
                    );
                    return;
                }

                invalidScopes.push(
                    ...buildAbilityFromScopes(
                        {
                            projectUuid: projectProfile.projectUuid,
                            projectType: projectProfile.projectType,
                            projectCreatedByUserUuid:
                                projectProfile.projectCreatedByUserUuid,
                            userUuid: user.userUuid,
                            scopes,
                            isEnterprise,
                            organizationRole: user.role,
                            permissionsConfig,
                        },
                        builder,
                    ),
                );
            } else if (scopeComposedSystemRolesEnabled) {
                invalidScopes.push(
                    ...buildAbilityFromScopes(
                        {
                            projectUuid: projectProfile.projectUuid,
                            projectType: projectProfile.projectType,
                            projectCreatedByUserUuid:
                                projectProfile.projectCreatedByUserUuid,
                            userUuid: user.userUuid,
                            scopes: getAllScopesForRole(projectProfile.role),
                            isEnterprise,
                            organizationRole: user.role,
                            permissionsConfig,
                        },
                        builder,
                    ),
                );
            } else {
                projectMemberAbilities[projectProfile.role](
                    projectProfile,
                    builder,
                );
            }
        });
    }
    // Collapse per-project rules into `{ $in: [...] }` so the rule set (and the
    // serialized `abilityRules` payload) scales with role tiers, not project count.
    builder.rules = collapseAbilityRules(builder.rules);
    return { builder, invalidScopes };
};

// Defines user ability for test purposes
export const defineUserAbility = (
    user: Pick<
        LightdashUser,
        'role' | 'organizationUuid' | 'userUuid' | 'roleUuid'
    >,
    projectProfiles: ProjectAbilityProfile[],
    customRoleScopes?: Record<Role['roleUuid'], RoleWithScopes['scopes']>,
): MemberAbility => {
    const { builder } = getUserAbilityBuilder({
        user,
        projectProfiles,
        permissionsConfig: {
            pat: {
                enabled: false,
                allowedOrgRoles: [],
            },
        },
        customRoleScopes,
    });
    return builder.build();
};
