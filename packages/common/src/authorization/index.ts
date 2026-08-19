import { Ability, AbilityBuilder } from '@casl/ability';
import { type OrganizationMemberRole } from '../types/organizationMemberProfile';
import { type ProjectMemberProfile } from '../types/projectMemberProfile';
import { type ProjectType } from '../types/projects';
import { type Role, type RoleWithScopes } from '../types/roles';
import { type LightdashUser } from '../types/user';
import { collapseAbilityRules } from './collapseAbilityRules';
import { getAllScopesForOrgRole } from './orgRoleToScopeMapping';
import { resolveRoleScopes } from './resolveRoleScopes';
import {
    applyResourceAccessAbilities,
    type ResourceAccessGrant,
} from './resourceAccessAbility';
import { getAllScopesForRole } from './roleToScopeMapping';
import {
    buildAbilityFromScopes,
    type OptionalIdContext,
} from './scopeAbilityBuilder';
import {
    resolveEffectiveOrgRoleUuid,
    resolveEffectiveProjectRoleUuid,
} from './systemRoleUuids';
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
    isEnterprise?: boolean;
    resourceAccessGrants?: ResourceAccessGrant[];
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
    isEnterprise,
    resourceAccessGrants,
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
        // Every membership -- custom role or system role alike -- resolves
        // to an effective role_uuid (systemRoleUuids.ts) and its scopes are
        // read the same way via resolveRoleScopes: scoped_roles first, with
        // the literal scope-list modules as a fallback only for well-known
        // system uuids (see resolveRoleScopes.ts). A genuine custom
        // role_uuid with no matching scopes is a dangling reference and
        // fails closed (grants nothing for that layer, logged below) --
        // this now applies uniformly to the org layer and each project,
        // where previously only the project loop failed closed.
        //
        // buildAbilityFromScopes applies the dynamic PAT gate itself (see
        // handlePatConfigApplication in scopeAbilityBuilder.ts), keyed on
        // organizationRole -- no separate dynamic-abilities call needed.
        const orgScopes = resolveRoleScopes({
            effectiveRoleUuid: resolveEffectiveOrgRoleUuid({
                role: user.role,
                roleUuid: user.roleUuid,
            }),
            hasCustomRoleUuid: Boolean(user.roleUuid),
            systemRoleScopes: getAllScopesForOrgRole(user.role),
            customRoleScopes,
        });

        if (orgScopes) {
            applyScopes({
                organizationUuid: user.organizationUuid,
                userUuid: user.userUuid,
                scopes: orgScopes,
            });
        } else {
            // eslint-disable-next-line no-console
            console.error(
                `Custom org role with uuid ${user.roleUuid} was not found`,
            );
        }

        projectProfiles.forEach((projectProfile) => {
            const projectScopes = resolveRoleScopes({
                effectiveRoleUuid:
                    resolveEffectiveProjectRoleUuid(projectProfile),
                hasCustomRoleUuid: Boolean(projectProfile.roleUuid),
                systemRoleScopes: getAllScopesForRole(projectProfile.role),
                customRoleScopes,
            });

            if (!projectScopes) {
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
                scopes: projectScopes,
            });
        });
    }

    // Direct resource-access grants (Dashboard/SavedChart) -- additive,
    // composes via CASL's native OR-semantics without touching any rule
    // above, so an empty/absent grant list is a no-op.
    applyResourceAccessAbilities(resourceAccessGrants ?? [], builder);

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
