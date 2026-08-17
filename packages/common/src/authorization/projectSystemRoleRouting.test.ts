import { Ability, AbilityBuilder } from '@casl/ability';
import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import { ProjectMemberRole } from '../types/projectMemberRole';
import { collapseAbilityRules } from './collapseAbilityRules';
import { getUserAbilityBuilder } from './index';
import { getAllScopesForOrgRole } from './orgRoleToScopeMapping';
import { getAllScopesForRole } from './roleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

/**
 * Given: `getUserAbilityBuilder`'s per-project loop builds a project system
 *   role's ability via `buildAbilityFromScopes(getAllScopesForRole(role))`
 *   (A10b -- this was flag-gated through A8, unconditional since).
 * Then: its output matches driving that same call directly, proving
 *   `getUserAbilityBuilder` correctly ROUTES the role/org/project args
 *   through, not re-proving role/scope behavioral equivalence (A1/A3/A7a
 *   already cover that).
 *
 * The org layer here is held at the minimal `member` tier and built the
 * same way (A6), so the "expected" reference constructs both layers via
 * `buildAbilityFromScopes` to match.
 */

const ORG_UUID = 'test-org-uuid';
const USER_UUID = 'test-user-uuid';
const PROJECT_UUID = 'test-project-uuid';
const PERMISSIONS_CONFIG = { pat: { enabled: false, allowedOrgRoles: [] } };

const buildExpectedFullRuleSet = (projectRole: ProjectMemberRole) => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    buildAbilityFromScopes(
        {
            userUuid: USER_UUID,
            organizationUuid: ORG_UUID,
            scopes: getAllScopesForOrgRole(OrganizationMemberRole.MEMBER),
            isEnterprise: false,
        },
        builder,
    );
    buildAbilityFromScopes(
        {
            userUuid: USER_UUID,
            projectUuid: PROJECT_UUID,
            scopes: getAllScopesForRole(projectRole),
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

const PROJECT_ROLES = [
    ProjectMemberRole.VIEWER,
    ProjectMemberRole.INTERACTIVE_VIEWER,
    ProjectMemberRole.EDITOR,
    ProjectMemberRole.DEVELOPER,
    ProjectMemberRole.ADMIN,
];

const buildActual = (projectRole: ProjectMemberRole) =>
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
    }).builder.build().rules;

describe.each(PROJECT_ROLES)('given a project system role of %s', (role) => {
    it('then getUserAbilityBuilder routes through buildAbilityFromScopes(getAllScopesForRole(role)) for both layers', () => {
        ruleSetEqual(buildActual(role), buildExpectedFullRuleSet(role));
    });
});
