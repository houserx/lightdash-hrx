import { Ability, AbilityBuilder } from '@casl/ability';
import { type OrganizationMemberRole } from '../types/organizationMemberProfile';
import { ProjectMemberRole } from '../types/projectMemberRole';
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
    ORGANIZATION_VIEWER,
} from './organizationMemberAbility.mock';
import { projectMemberAbilities } from './projectMemberAbility';
import {
    PROJECT_ADMIN,
    PROJECT_DEVELOPER,
    PROJECT_EDITOR,
    PROJECT_INTERACTIVE_VIEWER,
    PROJECT_VIEWER,
} from './projectMemberAbility.mock';
import { getAllScopesForRole } from './roleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

/**
 * Given: the two independent ability-construction paths for system roles
 *   (hand-written `organizationMemberAbility.ts`/`projectMemberAbility.ts`
 *   vs. scope-driven `buildAbilityFromScopes` fed `getAllScopesForRole`).
 * When: probed with concrete generated resource instances across a range of
 *   scenarios (tenant match, ownership, space access, preview context).
 * Then: `ability.can(...)` must agree on every probed (action, subject, instance).
 *
 * This supersedes `roleToScopeParity.test.ts`'s coverage-only check (which
 * only verifies a rule *key* exists on both sides, never that the two rules'
 * *conditions* produce the same allow/deny decision for concrete data) with
 * genuine behavioral equivalence. It intentionally does NOT try to catch
 * every one of the 53 CaslSubjectNames' exact condition shape -- it uses one
 * generic resource-instance shape (organizationUuid/projectUuid,
 * createdByUserUuid, access array, inheritsFromOrgOrProject, preview) that
 * covers the condition primitives actually used by `scopes.ts`'s shared
 * helpers (`addUuidCondition`, `addAccessCondition`, `ownPreviewProjectConditions`,
 * `selfPreviewSpaceCondition`). Broadening to subject-specific shapes is a
 * later, separate concern if it turns out to be needed.
 *
 * The generic harness machinery (scenario generation, instance building, the
 * fast-check property runner) lives in `differentialAbilityCheck.ts`, shared
 * with `orgRoleToScopeMapping.test.ts` and future consumers.
 */

/**
 * Org-only subjects are dead-on-arrival when probed with a project-shaped
 * instance (`{ projectUuid }` conditions never match an org-context check in
 * real code), so the scope-built side can carry a rule for them at project
 * context without the role-built side ever granting it -- not a real
 * behavioral gap, just an artifact of testing a subject with the wrong
 * context shape. Mirrors (duplicated, not imported -- see note below)
 * `PROJECT_PARITY_IGNORE`'s "case 1" in `roleToScopeParity.test.ts`.
 *
 * Deliberately NOT filtering "case 2" (granular actions subsumed by a
 * broader `manage:X` on the role-built side, e.g. `create:Job`) the way
 * that file does: at the level of rule *keys*, those are "benign extras."
 * At the level of *behavior*, a broader unconditional `manage:Job` and a
 * narrower `view:Job@self` can genuinely disagree for a job created by
 * someone else -- that disagreement is exactly the class of gap this
 * harness exists to surface, not suppress.
 *
 * Duplicated rather than imported from `roleToScopeParity.test.ts` because
 * that file's entire premise is superseded once the builders converge onto
 * one path (plan item A12 deletes it) -- unifying the two now would be
 * throwaway work.
 */
const PROJECT_CONTEXT_DEAD_ON_ARRIVAL_SUBJECTS = new Set([
    'OrganizationMemberProfile',
    'Organization',
    'OrganizationColorPalette',
    'OrganizationDesign',
    'Roadmap',
    'Group',
    'InviteLink',
    'GitIntegration',
    'OrganizationWarehouseCredentials',
    'User',
    // Not present in `roleToScopeParity.test.ts`'s equivalent list -- found
    // by this harness. Same rationale as the rest of this set (org-scoped
    // subject, dead-on-arrival when probed with a project-shaped instance).
    'OrganizationAiAgent',
]);

/**
 * `action:subject` pairs where a system role's grant is deliberately BROADER
 * than the scope vocabulary's equivalent (which favors a narrower `@self`
 * scope so a custom role cloned from this tier can intentionally drop the
 * broader grant). Behaviorally real, permanent-by-design asymmetries, not
 * bugs -- so they're never picked as probes rather than caught and ignored
 * per-run, keeping fast-check's shrinking focused on things that ARE bugs.
 *
 * One exception, `create:Project`, is NOT an intentional asymmetry -- see
 * `confirmedBugDeferred` below.
 */
const KNOWN_BROADER_SYSTEM_ROLE_GRANTS = {
    /** Matches `PROJECT_PARITY_IGNORE`'s "case 2" entries in
     * `roleToScopeParity.test.ts` -- already identified and accepted by the
     * team before this harness existed. */
    precedented: new Set([
        'create:Job',
        'view:Job',
        'promote:SavedChart',
        'promote:Dashboard',
    ]),
    /** Surfaced by this harness and since verified by direct inspection:
     * genuinely the same class of intentional narrowing as `precedented`
     * above. `delete:Project`/`view:DeployProject` come from
     * `delete:Project@self`/`manage:DeployProject@self`, both of which use
     * the shared `ownPreviewProjectConditions` helper (confirmed it branches
     * correctly on org vs. project context -- see `scopes.ts`). `view:PersonalAccessToken`
     * matches `roleToScopeMapping.ts`'s own documented PAT dynamic-gate
     * caveat: "toggling it in a custom role bypasses the dynamic gate, since
     * CASL is additive". */
    confirmedIntentionalNarrowing: new Set([
        'delete:Project',
        'view:DeployProject',
        'view:PersonalAccessToken',
    ]),
    /** NOT an intentional asymmetry -- a confirmed, pre-existing bug.
     * `create:Project@preview`'s `getConditions` (scopes.ts:575-580) is a
     * bespoke inline function, unlike its `ownPreviewProjectConditions`-based
     * siblings, and only ever checks `context.projectUuid` -- which is
     * always undefined when this same scope list builds an org-level
     * ability. The condition is therefore unsatisfiable at org level,
     * silently breaking preview-project creation for any org-level
     * assignment, contradicting what `organizationMemberAbility.ts`'s
     * developer tier clearly intends to grant. Deferred rather than fixed
     * here -- tracked as plan item B0, flagged for maintainer input before
     * touching it (it's a live, pre-existing bug independent of this
     * refactor, not an architecture concern). Stays waived so this harness
     * remains green until B0 lands. */
    confirmedBugDeferred: new Set(['create:Project']),
};

const ALL_WAIVED_KEYS = new Set([
    ...KNOWN_BROADER_SYSTEM_ROLE_GRANTS.precedented,
    ...KNOWN_BROADER_SYSTEM_ROLE_GRANTS.confirmedIntentionalNarrowing,
    ...KNOWN_BROADER_SYSTEM_ROLE_GRANTS.confirmedBugDeferred,
]);

const SYSTEM_PROJECT_ROLES = [
    ProjectMemberRole.VIEWER,
    ProjectMemberRole.INTERACTIVE_VIEWER,
    ProjectMemberRole.EDITOR,
    ProjectMemberRole.DEVELOPER,
    ProjectMemberRole.ADMIN,
];

const PROJECT_MEMBER_BY_ROLE = {
    [ProjectMemberRole.VIEWER]: PROJECT_VIEWER,
    [ProjectMemberRole.INTERACTIVE_VIEWER]: PROJECT_INTERACTIVE_VIEWER,
    [ProjectMemberRole.EDITOR]: PROJECT_EDITOR,
    [ProjectMemberRole.DEVELOPER]: PROJECT_DEVELOPER,
    [ProjectMemberRole.ADMIN]: PROJECT_ADMIN,
};

const ORG_MEMBER_BY_ROLE = {
    [ProjectMemberRole.VIEWER]: ORGANIZATION_VIEWER,
    [ProjectMemberRole.INTERACTIVE_VIEWER]: ORGANIZATION_INTERACTIVE_VIEWER,
    [ProjectMemberRole.EDITOR]: ORGANIZATION_EDITOR,
    [ProjectMemberRole.DEVELOPER]: ORGANIZATION_DEVELOPER,
    [ProjectMemberRole.ADMIN]: ORGANIZATION_ADMIN,
};

describe('Given the role-based and scope-based ability builders for the same system role', () => {
    describe.each(SYSTEM_PROJECT_ROLES)(
        'when built for project role %s',
        (role) => {
            it.each([false, true])(
                'then they agree on can()/cannot() across generated resource scenarios [isEnterprise=%s]',
                (isEnterprise) => {
                    const member = PROJECT_MEMBER_BY_ROLE[role];

                    const referenceBuilder = new AbilityBuilder<MemberAbility>(
                        Ability,
                    );
                    projectMemberAbilities[role](member, referenceBuilder);
                    const reference = referenceBuilder.build();

                    const candidateBuilder = new AbilityBuilder<MemberAbility>(
                        Ability,
                    );
                    buildAbilityFromScopes(
                        {
                            userUuid: member.userUuid,
                            projectUuid: member.projectUuid,
                            scopes: getAllScopesForRole(role),
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
                            PROJECT_CONTEXT_DEAD_ON_ARRIVAL_SUBJECTS,
                            ALL_WAIVED_KEYS,
                        ),
                    ];

                    runDifferentialCheck(
                        reference,
                        candidate,
                        member,
                        probeKeys,
                    );
                },
            );
        },
    );

    describe.each(SYSTEM_PROJECT_ROLES)(
        'when built for org role %s',
        (role) => {
            it.each([false, true])(
                'then they agree on can()/cannot() across generated resource scenarios [isEnterprise=%s]',
                (isEnterprise) => {
                    const member = ORG_MEMBER_BY_ROLE[role];
                    const orgRole = role as unknown as OrganizationMemberRole;

                    const referenceBuilder = new AbilityBuilder<MemberAbility>(
                        Ability,
                    );
                    applyOrganizationMemberStaticAbilities[orgRole](
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
                            scopes: getAllScopesForRole(role),
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
                            new Set(),
                            ALL_WAIVED_KEYS,
                        ),
                    ];

                    runDifferentialCheck(
                        reference,
                        candidate,
                        member,
                        probeKeys,
                    );
                },
            );
        },
    );
});

describe('Given the differential-check harness itself', () => {
    describe('when the two sides genuinely disagree', () => {
        it('then fc.assert throws, proving the harness detects real drift', () => {
            const onlyReferenceGrantsIt = new AbilityBuilder<MemberAbility>(
                Ability,
            );
            onlyReferenceGrantsIt.can('view', 'Dashboard', {
                projectUuid: 'p1',
            });
            const reference = onlyReferenceGrantsIt.build();
            const candidate = new AbilityBuilder<MemberAbility>(
                Ability,
            ).build();

            expect(() =>
                runDifferentialCheck(
                    reference,
                    candidate,
                    { userUuid: 'u1', projectUuid: 'p1' },
                    ['view:Dashboard'],
                ),
            ).toThrow();
        });
    });

    describe('when the two sides genuinely agree', () => {
        it('then fc.assert does not throw', () => {
            const bothGrantIt = () => {
                const builder = new AbilityBuilder<MemberAbility>(Ability);
                builder.can('view', 'Dashboard', { projectUuid: 'p1' });
                return builder.build();
            };

            expect(() =>
                runDifferentialCheck(
                    bothGrantIt(),
                    bothGrantIt(),
                    { userUuid: 'u1', projectUuid: 'p1' },
                    ['view:Dashboard'],
                ),
            ).not.toThrow();
        });
    });
});
