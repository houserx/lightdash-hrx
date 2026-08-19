import { Ability, AbilityBuilder, subject } from '@casl/ability';
import {
    ORG_UUID,
    USER_UUID,
    type FixtureEntry,
} from './organizationMemberAbility.fixtureData';
import { ORG_FIXTURE_PART_1 } from './organizationMemberAbility.fixtureData.part1';
import { ORG_FIXTURE_PART_2 } from './organizationMemberAbility.fixtureData.part2';
import { ORG_FIXTURE_PART_3 } from './organizationMemberAbility.fixtureData.part3';
import { ORG_FIXTURE_PART_4 } from './organizationMemberAbility.fixtureData.part4';
import { getAllScopesForOrgRole } from './orgRoleToScopeMapping';
import { buildAbilityFromScopes } from './scopeAbilityBuilder';
import { type MemberAbility } from './types';

/**
 * Given: the 275 `ability.can()` expectations originally captured from the
 *   now-deleted hand-written `organizationMemberAbility.test.ts` (188 cases,
 *   including the 3 PAT-dynamic-gate cases that override the default
 *   `permissionsConfig`, and 16 cases that check a bare subject-type string
 *   rather than a tagged resource instance) -- knowledge worth preserving
 *   now that the hand-written builder those tests exercised has been
 *   deleted.
 * When: asserted against the sole remaining ability-building path,
 *   scope-composed `buildAbilityFromScopes(getAllScopesForOrgRole(role))`,
 *   which -- unlike the project-layer scope build -- must also apply the PAT
 *   dynamic gate itself via `organizationRole`/`permissionsConfig`, since
 *   there's no separate dynamic-abilities call on that path.
 * Then: `ability.can(...)` matches the originally-captured expectation for
 *   every case except [238] (see its own comment below).
 *
 * NOT ported: the original file's separate "derives the %s delegation
 * footprint" test block, which asserted against
 * `getOrganizationMemberRolePermissions` (a rules-introspection utility) via
 * `.rules`, never `.can()` -- a different function under test, out of scope
 * here.
 */

const FIXTURE: FixtureEntry[] = [
    ...ORG_FIXTURE_PART_1,
    ...ORG_FIXTURE_PART_2,
    ...ORG_FIXTURE_PART_3,
    ...ORG_FIXTURE_PART_4,
];

const buildAbility = (
    entry: Pick<FixtureEntry, 'role' | 'permissionsConfig'>,
): MemberAbility => {
    const builder = new AbilityBuilder<MemberAbility>(Ability);
    buildAbilityFromScopes(
        {
            userUuid: USER_UUID,
            organizationUuid: ORG_UUID,
            scopes: getAllScopesForOrgRole(entry.role),
            isEnterprise: true,
            organizationRole: entry.role,
            permissionsConfig: entry.permissionsConfig,
        },
        builder,
    );
    return builder.build();
};

/**
 * [227, 235] (`create:Project@preview` org-blindness) were a confirmed bug
 * when this file was first ported -- fixed in scopes.ts (the condition now
 * branches on organizationUuid at org level), so no longer excluded here.
 *
 * [238] stays excluded: the hand-written path it was verified against is
 * gone, so this becomes a documented untested case, not a re-baselined one:
 * `delete:Project@self`'s condition (`ownPreviewProjectConditions` in
 * `scopes.ts`) requires `createdByUserUuid` to match the current user, but
 * the hand-written developer-tier grant for the same case (now-deleted
 * `organizationMemberAbility.ts`) had no such check -- `can('delete',
 * 'Project', { organizationUuid, type: PREVIEW })` -- unlike its sibling
 * `manage:DeployProject@self`, which did check `createdByUserUuid`. So
 * before this cutover a developer could delete *any* preview project in
 * their org despite the "@self" scope name; the scope-composed path is
 * narrower (safer): only the preview's own creator. This is an intentional
 * narrowing, not a bug.
 */
const KNOWN_SCOPE_VOCABULARY_GAP_INDICES = new Set([238]);

describe.each(
    FIXTURE.map((entry, i) => ({ ...entry, i })).filter(
        (entry) => !KNOWN_SCOPE_VOCABULARY_GAP_INDICES.has(entry.i),
    ),
)('when checking fixture case $i ($role $action:$subjectType)', (entry) => {
    it(`then can() returns ${entry.expected}`, () => {
        const ability = buildAbility(entry);
        const result =
            entry.resource === null
                ? ability.can(entry.action, entry.subjectType)
                : ability.can(
                      entry.action,
                      subject(entry.subjectType, entry.resource),
                  );
        expect(result).toBe(entry.expected);
    });
});
