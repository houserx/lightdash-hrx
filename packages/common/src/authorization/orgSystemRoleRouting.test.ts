import { Ability, AbilityBuilder } from '@casl/ability';
import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { collapseAbilityRules } from './collapseAbilityRules';
import { getUserAbilityBuilder } from './index';
import { getAllScopesForOrgRole } from './orgRoleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

/**
 * Given: `getUserAbilityBuilder`'s org layer builds a system org role's
 *   ability via `buildAbilityFromScopes(getAllScopesForOrgRole(role))`
 *   (A10b -- this was flag-gated through A8, unconditional since).
 * Then: its output matches driving that same call directly, proving
 *   `getUserAbilityBuilder` correctly ROUTES the org role/uuid args
 *   through, not re-proving role/scope behavioral equivalence (already
 *   covered by A1/A4's `orgRoleToScopeMapping.test.ts`).
 *
 * Mirrors `projectSystemRoleScopeFlag.test.ts`'s structure and rationale.
 */

const ORG_UUID = 'test-org-uuid';
const USER_UUID = 'test-user-uuid';
const PERMISSIONS_CONFIG = { pat: { enabled: false, allowedOrgRoles: [] } };

/** Project profiles held empty across every case here, so the only thing
 * that can vary between "expected" and "actual" is the org layer -- exactly
 * what this test is about. */
const buildExpectedOrgRuleSet = (orgRole: OrganizationMemberRole) => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    buildAbilityFromScopes(
        {
            userUuid: USER_UUID,
            organizationUuid: ORG_UUID,
            scopes: getAllScopesForOrgRole(orgRole),
            isEnterprise: false,
        },
        builder,
    );
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

const buildActual = (orgRole: OrganizationMemberRole) =>
    getUserAbilityBuilder({
        user: {
            role: orgRole,
            organizationUuid: ORG_UUID,
            userUuid: USER_UUID,
            roleUuid: undefined,
        },
        projectProfiles: [],
        permissionsConfig: PERMISSIONS_CONFIG,
    }).builder.build().rules;

describe.each(ORG_ROLES)('given an org system role of %s', (role) => {
    it('then getUserAbilityBuilder routes through buildAbilityFromScopes(getAllScopesForOrgRole(role))', () => {
        ruleSetEqual(buildActual(role), buildExpectedOrgRuleSet(role));
    });
});
