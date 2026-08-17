import { Ability, AbilityBuilder } from '@casl/ability';
import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { collapseAbilityRules } from './collapseAbilityRules';
import { getUserAbilityBuilder } from './index';
import applyOrganizationMemberAbilities from './organizationMemberAbility';
import { getAllScopesForOrgRole } from './orgRoleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

/**
 * Given: `getUserAbilityBuilder`'s org layer currently always builds a
 *   system org role's ability via the hand-written
 *   `applyOrganizationMemberAbilities` (which also applies the dynamic PAT
 *   gate on top of the static per-role grants).
 * When: the same `scopeComposedSystemRolesEnabled` flag introduced in A5
 *   (project layer) is extended to gate this layer too.
 * Then: (a) omitting the flag produces byte-identical output to today's
 *   only path (regression safety), and (b) setting it to true routes the
 *   same org role through `buildAbilityFromScopes(getAllScopesForOrgRole(role))`
 *   instead -- proving `getUserAbilityBuilder` correctly ROUTES, not
 *   re-proving role/scope behavioral equivalence (already covered by A1/A4's
 *   `orgRoleToScopeMapping.test.ts`).
 *
 * Mirrors `projectSystemRoleScopeFlag.test.ts`'s structure and rationale.
 */

const ORG_UUID = 'test-org-uuid';
const USER_UUID = 'test-user-uuid';
const PERMISSIONS_CONFIG = { pat: { enabled: false, allowedOrgRoles: [] } };

/** Project profiles held empty across every case here, so the only thing
 * that can vary between "expected" and "actual" is the org layer -- exactly
 * what this test is about. */
const buildExpectedOrgRuleSet = (
    orgRole: OrganizationMemberRole,
    useScopedPath: boolean,
) => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    if (useScopedPath) {
        buildAbilityFromScopes(
            {
                userUuid: USER_UUID,
                organizationUuid: ORG_UUID,
                scopes: getAllScopesForOrgRole(orgRole),
                isEnterprise: false,
            },
            builder,
        );
    } else {
        applyOrganizationMemberAbilities({
            role: orgRole,
            member: { organizationUuid: ORG_UUID, userUuid: USER_UUID },
            builder,
            permissionsConfig: PERMISSIONS_CONFIG,
        });
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

const ORG_ROLES = [
    OrganizationMemberRole.MEMBER,
    OrganizationMemberRole.VIEWER,
    OrganizationMemberRole.INTERACTIVE_VIEWER,
    OrganizationMemberRole.EDITOR,
    OrganizationMemberRole.DEVELOPER,
    OrganizationMemberRole.ADMIN,
];

const buildWithFlag = (
    orgRole: OrganizationMemberRole,
    scopeComposedSystemRolesEnabled?: boolean,
) =>
    getUserAbilityBuilder({
        user: {
            role: orgRole,
            organizationUuid: ORG_UUID,
            userUuid: USER_UUID,
            roleUuid: undefined,
        },
        projectProfiles: [],
        permissionsConfig: PERMISSIONS_CONFIG,
        scopeComposedSystemRolesEnabled,
    }).builder.build().rules;

describe('Given the scope-composed org system role flag', () => {
    describe.each(ORG_ROLES)('when org role is %s', (role) => {
        it('then omitting the flag produces byte-identical output to the unflagged path (regression safety)', () => {
            ruleSetEqual(
                buildWithFlag(role, undefined),
                buildExpectedOrgRuleSet(role, false),
            );
        });

        it('then explicitly setting the flag to false matches the unflagged path', () => {
            ruleSetEqual(
                buildWithFlag(role, false),
                buildExpectedOrgRuleSet(role, false),
            );
        });

        it('then setting the flag to true routes through buildAbilityFromScopes(getAllScopesForOrgRole(role))', () => {
            ruleSetEqual(
                buildWithFlag(role, true),
                buildExpectedOrgRuleSet(role, true),
            );
        });
    });
});
