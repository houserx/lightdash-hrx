import { Ability, AbilityBuilder } from '@casl/ability';
import { ServiceAccountScope } from '../ee/serviceAccounts/types';
import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { collapseAbilityRules } from './collapseAbilityRules';
import { getAllScopesForOrgRole } from './orgRoleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { applyServiceAccountAbilities } from './serviceAccountAbility';
import { type MemberAbility } from './types';

/**
 * Given: each `SYSTEM_*` service-account scope builds its ability via
 *   `buildAbilityFromScopes(getAllScopesForOrgRole(role))` (A10b -- this was
 *   flag-gated through A9, unconditional since).
 * Then: its output matches driving that same call directly, proving
 *   `applyServiceAccountAbilities` correctly ROUTES the role/org/user args
 *   through, not re-proving role/scope behavioral equivalence (already
 *   covered by A1/A4/A7b). `serviceAccountAbility.test.ts`'s existing
 *   assertions (the "11 cases" delegation-permission-footprint suite
 *   included) exercise this same unconditional path and stay green.
 *
 * Mirrors `orgSystemRoleScopeFlag.test.ts`'s structure and rationale.
 */

const ORG_UUID = 'test-org-uuid';
const USER_UUID = 'test-user-uuid';

const SYSTEM_SCOPE_TO_ORG_ROLE: Partial<
    Record<ServiceAccountScope, OrganizationMemberRole>
> = {
    [ServiceAccountScope.SYSTEM_MEMBER]: OrganizationMemberRole.MEMBER,
    [ServiceAccountScope.SYSTEM_VIEWER]: OrganizationMemberRole.VIEWER,
    [ServiceAccountScope.SYSTEM_INTERACTIVE_VIEWER]:
        OrganizationMemberRole.INTERACTIVE_VIEWER,
    [ServiceAccountScope.SYSTEM_EDITOR]: OrganizationMemberRole.EDITOR,
    [ServiceAccountScope.SYSTEM_DEVELOPER]: OrganizationMemberRole.DEVELOPER,
    [ServiceAccountScope.SYSTEM_ADMIN]: OrganizationMemberRole.ADMIN,
};

const SYSTEM_SCOPES = Object.keys(
    SYSTEM_SCOPE_TO_ORG_ROLE,
) as ServiceAccountScope[];

const buildActual = (scope: ServiceAccountScope) => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    applyServiceAccountAbilities({
        organizationUuid: ORG_UUID,
        userUuid: USER_UUID,
        builder,
        scopes: [scope],
    });
    builder.rules = collapseAbilityRules(builder.rules);
    return builder.build().rules;
};

const buildExpectedRuleSet = (scope: ServiceAccountScope) => {
    const orgRole = SYSTEM_SCOPE_TO_ORG_ROLE[scope];
    if (!orgRole) {
        throw new Error(`No org-role mapping for ${scope}`);
    }
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    buildAbilityFromScopes(
        {
            userUuid: USER_UUID,
            organizationUuid: ORG_UUID,
            scopes: getAllScopesForOrgRole(orgRole),
            isEnterprise: true,
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

describe.each(SYSTEM_SCOPES)('given a service-account scope of %s', (scope) => {
    it('then applyServiceAccountAbilities routes through buildAbilityFromScopes(getAllScopesForOrgRole(role))', () => {
        ruleSetEqual(buildActual(scope), buildExpectedRuleSet(scope));
    });
});
