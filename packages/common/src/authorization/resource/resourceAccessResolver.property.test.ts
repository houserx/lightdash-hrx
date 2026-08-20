// `fc` comes from @fast-check/vitest rather than fast-check directly: importing
// it from both resolves fast-check's ESM and CJS entry points side by side, and
// the two Arbitrary types are then structurally incompatible under `tsc --build`.
import { fc, test } from '@fast-check/vitest';
import { OrganizationMemberRole } from '../../types/organizationMemberProfile';
import {
    ProjectMemberRole,
    SpaceRoleOrder,
} from '../../types/projectMemberRole';
import {
    DirectResourceAccessOrigin,
    type DirectResourceAccess,
    type ResourceAccessAction,
} from '../../types/resourceAccess';
import { SpaceMemberRole, type SpaceAccess } from '../../types/space';
import { resolveResourceAccess } from './resourceAccessResolver';

const RESOURCE_UUID = 'resource-under-test';

const userUuidArb = fc.constantFrom('user-1', 'user-2', 'user-3');
const actionArb: fc.Arbitrary<ResourceAccessAction> = fc.constantFrom(
    'view',
    'manage',
);

const spaceAccessArb: fc.Arbitrary<SpaceAccess> = fc.record({
    userUuid: userUuidArb,
    role: fc.constantFrom(
        SpaceMemberRole.VIEWER,
        SpaceMemberRole.EDITOR,
        SpaceMemberRole.ADMIN,
    ),
    hasDirectAccess: fc.boolean(),
    projectRole: fc.constantFrom(ProjectMemberRole.VIEWER, undefined),
    inheritedRole: fc.constantFrom(OrganizationMemberRole.VIEWER, undefined),
    inheritedFrom: fc.constantFrom('project' as const, undefined),
});

const grantArb: fc.Arbitrary<DirectResourceAccess> = fc.record({
    userUuid: userUuidArb,
    // Include a foreign resource so filtering is exercised.
    resourceUuid: fc.constantFrom(RESOURCE_UUID, 'some-other-resource'),
    groupUuid: fc.constantFrom(null, 'group-1'),
    action: actionArb,
    from: fc.constantFrom(
        DirectResourceAccessOrigin.USER_ACCESS,
        DirectResourceAccessOrigin.GROUP_ACCESS,
    ),
});

/** One entry per user, so `spaceAccess` is well-formed as the resolver expects. */
const spaceAccessListArb = fc
    .uniqueArray(spaceAccessArb, {
        maxLength: 3,
        selector: (entry) => entry.userUuid,
    })
    .map((entries) => entries);

const grantListArb = fc.array(grantArb, { maxLength: 8 });

const resolve = (
    spaceAccess: SpaceAccess[],
    directResourceAccess: DirectResourceAccess[],
) =>
    resolveResourceAccess({
        resourceUuid: RESOURCE_UUID,
        spaceAccess,
        directResourceAccess,
    });

const roleFor = (entries: SpaceAccess[], userUuid: string) =>
    entries.find((entry) => entry.userUuid === userUuid)?.role;

const rank = (role: SpaceMemberRole | undefined) =>
    role === undefined ? -1 : SpaceRoleOrder[role];

describe('resolveResourceAccess properties', () => {
    test.prop([spaceAccessListArb, grantListArb, grantArb])(
        'adding a grant never lowers any user effective role',
        (spaceAccess, grants, extraGrant) => {
            const before = resolve(spaceAccess, grants);
            const after = resolve(spaceAccess, [...grants, extraGrant]);

            return before.every(
                (entry) =>
                    rank(roleFor(after, entry.userUuid)) >= rank(entry.role),
            );
        },
    );

    test.prop([spaceAccessListArb, grantListArb])(
        'the result does not depend on the order grants arrive in',
        (spaceAccess, grants) => {
            const forward = resolve(spaceAccess, grants);
            const reversed = resolve(spaceAccess, [...grants].reverse());

            expect(reversed).toEqual(forward);
        },
    );

    test.prop([spaceAccessListArb, grantListArb])(
        'grants for other resources never change the outcome',
        (spaceAccess, grants) => {
            const onlyThisResource = grants.filter(
                (grant) => grant.resourceUuid === RESOURCE_UUID,
            );

            expect(resolve(spaceAccess, grants)).toEqual(
                resolve(spaceAccess, onlyThisResource),
            );
        },
    );

    test.prop([spaceAccessListArb, grantListArb])(
        'every user granted on this resource appears in the result',
        (spaceAccess, grants) => {
            const result = resolve(spaceAccess, grants);
            const grantedUserUuids = new Set(
                grants
                    .filter((grant) => grant.resourceUuid === RESOURCE_UUID)
                    .map((grant) => grant.userUuid),
            );

            return [...grantedUserUuids].every((userUuid) =>
                result.some((entry) => entry.userUuid === userUuid),
            );
        },
    );

    test.prop([spaceAccessListArb, grantListArb])(
        'a user is never listed twice',
        (spaceAccess, grants) => {
            const result = resolve(spaceAccess, grants);
            const userUuids = result.map((entry) => entry.userUuid);

            expect(new Set(userUuids).size).toBe(userUuids.length);
        },
    );

    test.prop([spaceAccessListArb, grantListArb])(
        'applying the same grants twice changes nothing further',
        (spaceAccess, grants) => {
            const once = resolve(spaceAccess, grants);
            const twice = resolve(spaceAccess, [...grants, ...grants]);

            expect(twice).toEqual(once);
        },
    );

    test.prop([grantListArb])(
        'a grant-only user never gains more than editor',
        (grants) => {
            const result = resolve([], grants);

            return result.every(
                (entry) => rank(entry.role) <= rank(SpaceMemberRole.EDITOR),
            );
        },
    );
});
