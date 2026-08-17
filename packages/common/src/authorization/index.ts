import { Ability, AbilityBuilder } from '@casl/ability';
import { NotFoundError } from '../types/errors';
import { type OrganizationMemberRole } from '../types/organizationMemberProfile';
import { type ProjectMemberProfile } from '../types/projectMemberProfile';
import { type ProjectType } from '../types/projects';
import { type Role, type RoleWithScopes } from '../types/roles';
import { type LightdashUser } from '../types/user';
import { collapseAbilityRules } from './collapseAbilityRules';
import { getAllScopesForOrgRole } from './orgRoleToScopeMapping';
import { getAllScopesForRole } from './roleToScopeMapping';
import {
    buildAbilityFromScopes,
    type OptionalIdContext,
} from './scopeAbilityBuilder';
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
    permissionsConfig: {
        pat: {
            enabled: boolean;
            allowedOrgRoles: OrganizationMemberRole[];
        };
    };
    customRoleScopes?: Record<Role['roleUuid'], RoleWithScopes['scopes']>;
    customRolesEnabled?: boolean;
    isEnterprise?: boolean;
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
}: UserAbilityBuilderArgs): UserAbilityBuilderResult => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    const invalidScopes: string[] = [];

    // Shared tail of every scope-resolution branch below: build CASL rules
    // from a resolved scope list and collect any names buildAbilityFromScopes
    // rejected. isEnterprise/organizationRole/permissionsConfig are the same
    // for every call in a single ability build, so callers only ever supply
    // the id-context (org- or project-shaped) plus the resolved scopes.
    const applyScopes = (
        options: OptionalIdContext & { userUuid: string; scopes: string[] },
    ) => {
        invalidScopes.push(
            ...buildAbilityFromScopes(
                {
                    ...options,
                    isEnterprise,
                    organizationRole: user.role,
                    permissionsConfig,
                },
                builder,
            ),
        );
    };

    if (user.role && user.organizationUuid) {
        // Org-level custom role: if the user's organization_memberships row
        // points at a role_uuid AND custom roles are enabled AND we have the
        // role's scopes, build CASL from those scopes (same path as
        // project-level custom roles below). Falls back to the system role
        // path otherwise -- including when a role_uuid is set but its scopes
        // are missing from customRoleScopes (dangling reference), unlike the
        // project loop below, which skips granting anything for that project
        // in the equivalent case. Pre-existing asymmetry, not changed here.
        //
        // buildAbilityFromScopes applies the dynamic PAT gate itself (see
        // handlePatConfigApplication in scopeAbilityBuilder.ts), keyed on
        // organizationRole -- no separate dynamic-abilities call needed.
        const orgCustomRoleScopes =
            customRolesEnabled && user.roleUuid
                ? customRoleScopes?.[user.roleUuid]
                : undefined;

        applyScopes({
            organizationUuid: user.organizationUuid,
            userUuid: user.userUuid,
            scopes: orgCustomRoleScopes ?? getAllScopesForOrgRole(user.role),
        });

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

                applyScopes({
                    projectUuid: projectProfile.projectUuid,
                    projectType: projectProfile.projectType,
                    projectCreatedByUserUuid:
                        projectProfile.projectCreatedByUserUuid,
                    userUuid: user.userUuid,
                    scopes,
                });
            } else {
                applyScopes({
                    projectUuid: projectProfile.projectUuid,
                    projectType: projectProfile.projectType,
                    projectCreatedByUserUuid:
                        projectProfile.projectCreatedByUserUuid,
                    userUuid: user.userUuid,
                    scopes: getAllScopesForRole(projectProfile.role),
                });
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
    // No default -- matching the real UserModel wiring (isEnterprise comes
    // from the org's actual license), so a caller that forgets this fails
    // enterprise-scope checks loudly instead of silently.
    { isEnterprise }: { isEnterprise?: boolean } = {},
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
        isEnterprise,
    });
    return builder.build();
};
