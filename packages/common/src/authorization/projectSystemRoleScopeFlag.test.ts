import { Ability, AbilityBuilder } from '@casl/ability';
import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { ProjectMemberRole } from '../types/projectMemberRole';
import { collapseAbilityRules } from './collapseAbilityRules';
import { getUserAbilityBuilder } from './index';
import applyOrganizationMemberAbilities from './organizationMemberAbility';
import { getAllScopesForOrgRole } from './orgRoleToScopeMapping';
import { projectMemberAbilities } from './projectMemberAbility';
import { getAllScopesForRole } from './roleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

/**
 * Given: `getUserAbilityBuilder`'s per-project loop currently always builds
 *   a project system role's ability via the hand-written
 *   `projectMemberAbilities[role]`.
 * When: a new `scopeComposedSystemRolesEnabled` flag is introduced,
 *   defaulting to off/omitted.
 * Then: (a) omitting the flag produces byte-identical output to today's
 *   only path (regression safety -- this is the "old path untouched"
 *   guarantee A5 promises), and (b) setting it to true routes the same
 *   project role through `buildAbilityFromScopes(getAllScopesForRole(role))`
 *   instead, verified by matching the output of driving that path directly
 *   (not by re-proving role/scope behavioral equivalence, which A1/A3
 *   already cover -- this test's job is to prove `getUserAbilityBuilder`
 *   correctly ROUTES to the flagged path, nothing more).
 *
 * The org layer here is held at the minimal `member` tier, but is now ALSO
 * gated by this same flag (A6) -- so the "expected" reference must switch
 * its own org-layer construction alongside the project layer's, or the two
 * would silently diverge the moment A6 wires the org branch up.
 */

const ORG_UUID = 'test-org-uuid';
const USER_UUID = 'test-user-uuid';
const PROJECT_UUID = 'test-project-uuid';
const PERMISSIONS_CONFIG = { pat: { enabled: false, allowedOrgRoles: [] } };

const buildExpectedFullRuleSet = (
    projectRole: ProjectMemberRole,
    useScopedPath: boolean,
) => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    if (useScopedPath) {
        buildAbilityFromScopes(
            {
                userUuid: USER_UUID,
                organizationUuid: ORG_UUID,
                scopes: getAllScopesForOrgRole(OrganizationMemberRole.MEMBER),
                isEnterprise: false,
            },
            builder,
        );
    } else {
        applyOrganizationMemberAbilities({
            role: OrganizationMemberRole.MEMBER,
            member: { organizationUuid: ORG_UUID, userUuid: USER_UUID },
            builder,
            permissionsConfig: PERMISSIONS_CONFIG,
        });
    }
    if (useScopedPath) {
        buildAbilityFromScopes(
            {
                userUuid: USER_UUID,
                projectUuid: PROJECT_UUID,
                scopes: getAllScopesForRole(projectRole),
                isEnterprise: false,
            },
            builder,
        );
    } else {
        projectMemberAbilities[projectRole](
            {
                projectUuid: PROJECT_UUID,
                userUuid: USER_UUID,
                role: projectRole,
            },
            builder,
        );
    }
    builder.rules = collapseAbilityRules(builder.rules);
    return builder.build().rules;
};

const ruleSetEqual = (a: unknown[], b: unknown[]) => {
    expect(a.length).toBe(b.length);
    expect(JSON.stringify(a.slice().sort())).toBe(
        JSON.stringify(b.slice().sort()),
    );
};

const PROJECT_ROLES = [
    ProjectMemberRole.VIEWER,
    ProjectMemberRole.INTERACTIVE_VIEWER,
    ProjectMemberRole.EDITOR,
    ProjectMemberRole.DEVELOPER,
    ProjectMemberRole.ADMIN,
];

const buildWithFlag = (
    projectRole: ProjectMemberRole,
    scopeComposedSystemRolesEnabled?: boolean,
) =>
    getUserAbilityBuilder({
        user: {
            role: OrganizationMemberRole.MEMBER,
            organizationUuid: ORG_UUID,
            userUuid: USER_UUID,
            roleUuid: undefined,
        },
        projectProfiles: [
            {
                projectUuid: PROJECT_UUID,
                role: projectRole,
                userUuid: USER_UUID,
                roleUuid: undefined,
            },
        ],
        permissionsConfig: PERMISSIONS_CONFIG,
        scopeComposedSystemRolesEnabled,
    }).builder.build().rules;

describe('Given the scope-composed project system role flag', () => {
    describe.each(PROJECT_ROLES)('when project role is %s', (role) => {
        it('then omitting the flag produces byte-identical output to the unflagged path (regression safety)', () => {
            ruleSetEqual(
                buildWithFlag(role, undefined),
                buildExpectedFullRuleSet(role, false),
            );
        });

        it('then explicitly setting the flag to false matches the unflagged path', () => {
            ruleSetEqual(
                buildWithFlag(role, false),
                buildExpectedFullRuleSet(role, false),
            );
        });

        it('then setting the flag to true routes through buildAbilityFromScopes(getAllScopesForRole(role))', () => {
            ruleSetEqual(
                buildWithFlag(role, true),
                buildExpectedFullRuleSet(role, true),
            );
        });
    });
});
