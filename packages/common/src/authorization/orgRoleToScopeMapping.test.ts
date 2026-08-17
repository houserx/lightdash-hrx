import { Ability, AbilityBuilder } from '@casl/ability';
import { OrganizationMemberRole } from '../types/organizationMemberProfile';
import {
    extractProbeKeys,
    runDifferentialCheck,
    type CASLRule,
} from './differentialAbilityCheck';
import { applyOrganizationMemberStaticAbilities } from './organizationMemberAbility';
import {
    ORGANIZATION_ADMIN,
    ORGANIZATION_DEVELOPER,
    ORGANIZATION_EDITOR,
    ORGANIZATION_INTERACTIVE_VIEWER,
    ORGANIZATION_MEMBER,
    ORGANIZATION_VIEWER,
} from './organizationMemberAbility.mock';
import { ORGANIZATION_ROLE_TO_SCOPES_MAP } from './orgRoleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

/**
 * Given: `ORGANIZATION_ROLE_TO_SCOPES_MAP` (new -- see module doc), derived
 *   by inspection of `organizationMemberAbility.ts`'s cascaded `can()` calls,
 *   as a dedicated org-role scope source (previously, org-context scope
 *   builds reused the *project* role's scope list as an approximation --
 *   see `roleToScopeParity.test.ts`'s `testOrgRoleScopeParity`).
 * When: probed against `applyOrganizationMemberStaticAbilities[role]` across
 *   generated resource scenarios, for all 6 org tiers (including `member`,
 *   which the project-role-reuse approach couldn't cover at all, since
 *   `ProjectMemberRole` has no equivalent tier).
 * Then: `ability.can(...)` must agree -- same behavioral-equivalence
 *   standard as A1's `differentialEquivalence.test.ts`, whose harness
 *   machinery this reuses via `differentialAbilityCheck.ts`.
 */

/**
 * Org-only subjects that are dead-on-arrival when probed and not otherwise
 * excluded by the harness's enterprise filter. None currently -- the org
 * scope map is written to match `organizationMemberAbility.ts` directly, so
 * unlike A1's project-context check (which tests a proxy list against a
 * differently-scoped builder), there's no context-shape mismatch class here.
 */
const ORG_CONTEXT_DEAD_ON_ARRIVAL_SUBJECTS = new Set<string>();

/**
 * `action:subject` pairs where the two sides are known to disagree.
 */
const KNOWN_GAPS = {
    /** Confirmed vocabulary gaps, not mapping errors -- no scope in
     * `scopes.ts` covers either grant's exact shape. In both cases the
     * mapping deliberately picks the *narrower* available scope (safer
     * under-grant) rather than a broader one that would over-grant, and the
     * gap is waived here rather than closed by adding a new scope --
     * out of scope for this mapping commit, which only maps to scopes that
     * already exist.
     *
     * - `create:Project`: admin's real grant
     *   (`organizationMemberAbility.ts:448-451`) is unconditional across
     *   both `DEFAULT` and `PREVIEW` types; `create:Project@preview` (used
     *   here) only ever covers `PREVIEW` (and, per plan item B0, is
     *   separately broken at org context regardless).
     * - `delete:Project`: developer's real grant
     *   (`organizationMemberAbility.ts:373-376`) is `{ type: PREVIEW }`
     *   with no creator restriction -- deletable by anyone, but only
     *   previews. Neither existing scope matches: `delete:Project` allows
     *   any project type; `delete:Project@self` (used here) restricts to
     *   previews the caller created themselves, which is narrower than
     *   intended but never over-grants. */
    confirmedVocabularyGap: new Set(['create:Project', 'delete:Project']),
};

const ALL_WAIVED_KEYS = new Set([...KNOWN_GAPS.confirmedVocabularyGap]);

const ORG_ROLES = [
    OrganizationMemberRole.MEMBER,
    OrganizationMemberRole.VIEWER,
    OrganizationMemberRole.INTERACTIVE_VIEWER,
    OrganizationMemberRole.EDITOR,
    OrganizationMemberRole.DEVELOPER,
    OrganizationMemberRole.ADMIN,
];

const ORG_MEMBER_BY_ROLE = {
    [OrganizationMemberRole.MEMBER]: ORGANIZATION_MEMBER,
    [OrganizationMemberRole.VIEWER]: ORGANIZATION_VIEWER,
    [OrganizationMemberRole.INTERACTIVE_VIEWER]:
        ORGANIZATION_INTERACTIVE_VIEWER,
    [OrganizationMemberRole.EDITOR]: ORGANIZATION_EDITOR,
    [OrganizationMemberRole.DEVELOPER]: ORGANIZATION_DEVELOPER,
    [OrganizationMemberRole.ADMIN]: ORGANIZATION_ADMIN,
};

describe('Given ORGANIZATION_ROLE_TO_SCOPES_MAP', () => {
    describe.each(ORG_ROLES)('when built for org role %s', (role) => {
        it.each([false, true])(
            'then buildAbilityFromScopes agrees with applyOrganizationMemberStaticAbilities across generated resource scenarios [isEnterprise=%s]',
            (isEnterprise) => {
                const member = ORG_MEMBER_BY_ROLE[role];

                const referenceBuilder = new AbilityBuilder<MemberAbility>(
                    Ability,
                );
                applyOrganizationMemberStaticAbilities[role](
                    member,
                    referenceBuilder,
                );
                const reference = referenceBuilder.build();

                const candidateBuilder = new AbilityBuilder<MemberAbility>(
                    Ability,
                );
                buildAbilityFromScopes(
                    {
                        userUuid: member.userUuid,
                        organizationUuid: member.organizationUuid,
                        scopes: ORGANIZATION_ROLE_TO_SCOPES_MAP[role],
                        isEnterprise,
                    },
                    candidateBuilder,
                );
                const candidate = candidateBuilder.build();

                const probeKeys = [
                    ...extractProbeKeys(
                        [
                            ...(reference.rules as CASLRule[]),
                            ...(candidate.rules as CASLRule[]),
                        ],
                        isEnterprise,
                        ORG_CONTEXT_DEAD_ON_ARRIVAL_SUBJECTS,
                        ALL_WAIVED_KEYS,
                    ),
                ];

                runDifferentialCheck(reference, candidate, member, probeKeys);
            },
        );
    });
});
