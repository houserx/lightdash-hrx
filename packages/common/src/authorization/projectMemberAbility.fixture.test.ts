import { Ability, AbilityBuilder, subject } from '@casl/ability';
import { type ProjectMemberRole } from '../types/projectMemberRole';
import {
    projectUuid,
    userUuid,
    type FixtureEntry,
} from './projectMemberAbility.fixtureData';
import { PROJECT_FIXTURE_PART_1 } from './projectMemberAbility.fixtureData.part1';
import { PROJECT_FIXTURE_PART_2 } from './projectMemberAbility.fixtureData.part2';
import { getAllScopesForRole } from './roleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

/**
 * Given: the 221 `ability.can()` expectations originally captured from the
 *   now-deleted hand-written `projectMemberAbility.test.ts` (128 cases) --
 *   knowledge worth preserving now that the hand-written builder those
 *   tests exercised has been deleted.
 * When: asserted against the sole remaining ability-building path,
 *   scope-composed `buildAbilityFromScopes(getAllScopesForRole(role))`.
 * Then: `ability.can(...)` matches the originally-captured expectation for
 *   every case.
 *
 * Built directly via the project-role builder (not `getUserAbilityBuilder`)
 * to isolate the project layer exactly as the original file did, with zero
 * org-layer interaction. `isEnterprise: true` matches the hand-written
 * side's behavior it was ported from, which had no enterprise gating at
 * all (always granted enterprise-only scopes unconditionally).
 */

const FIXTURE: FixtureEntry[] = [
    ...PROJECT_FIXTURE_PART_1,
    ...PROJECT_FIXTURE_PART_2,
];

// Fixture case 114 (manage:SourceCode/isProtectedBranch) was a confirmed
// scope-vocabulary gap when this file was first ported -- fixed in
// scopes.ts (`manage:SourceCode` now excludes protected branches, same as
// the hand-written grant it replaces), so no fixture case needs excluding
// from the scope-composed run anymore.

const buildAbility = (role: ProjectMemberRole): MemberAbility => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    buildAbilityFromScopes(
        {
            userUuid,
            projectUuid,
            scopes: getAllScopesForRole(role),
            isEnterprise: true,
        },
        builder,
    );
    return builder.build();
};

describe.each(FIXTURE.map((entry, i) => ({ ...entry, i })))(
    'when checking fixture case $i ($role $action:$subjectType)',
    (entry) => {
        it(`then can() returns ${entry.expected}`, () => {
            const ability = buildAbility(entry.role);
            expect(
                ability.can(
                    entry.action,
                    subject(entry.subjectType, entry.resource),
                ),
            ).toBe(entry.expected);
        });
    },
);
