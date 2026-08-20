import { fc, test } from '@fast-check/vitest';
import {
    SpaceMemberRole,
    type ResourceAccessAction,
    type ResourceAccessList,
    type ResourceShare,
} from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import {
    REVOKE_ACTION_ORDER,
    toGroupGrants,
    toResourceAccessRows,
} from './resourceGrantState';

/**
 * These specs exist because of a specific trap. `resolveResourceAccess` sets
 * `hasDirectAccess: true` on a merged entry even when the grant did *not* decide
 * the role, and in that case leaves `inheritedFrom` naming the space origin. So
 * `{hasDirectAccess: true, inheritedFrom: 'project'}` is byte-identical for an
 * inert resource grant and a genuine direct *space* share -- nothing in the
 * resolved entry records that a grant exists.
 *
 * Revocability therefore cannot be read off the resolved entry at all. It comes
 * only from the grant list, which names who holds which actions. Every property
 * below is an attempt to make that non-negotiable in code.
 */

const USER_POOL = ['user-ada', 'user-grace', 'user-alan'];

const ORIGINS: ResourceShare['inheritedFrom'][] = [
    'organization',
    'project',
    'group',
    'space_group',
    'parent_space',
    'direct_resource',
    undefined,
];

const ACTIONS: ResourceAccessAction[] = ['view', 'manage'];

const share = (overrides: Partial<ResourceShare>): ResourceShare => ({
    userUuid: 'user-ada',
    role: SpaceMemberRole.VIEWER,
    hasDirectAccess: false,
    projectRole: undefined,
    inheritedRole: undefined,
    inheritedFrom: 'project',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    isInternal: false,
    avatarUrl: null,
    avatarGradient: null,
    ...overrides,
});

const shareArb: fc.Arbitrary<ResourceShare> = fc
    .record({
        userUuid: fc.constantFrom(...USER_POOL),
        role: fc.constantFrom(...Object.values(SpaceMemberRole)),
        hasDirectAccess: fc.boolean(),
        inheritedFrom: fc.constantFrom(...ORIGINS),
    })
    .map(share);

/** Distinct users, because the resolved list never repeats a principal. */
const sharesArb: fc.Arbitrary<ResourceShare[]> = fc
    .uniqueArray(shareArb, {
        selector: (entry) => entry.userUuid,
        maxLength: 3,
    })
    .map((entries) => entries);

const grantsArb: fc.Arbitrary<ResourceAccessList> = fc.record({
    users: fc.array(
        fc.record({
            userUuid: fc.constantFrom(...USER_POOL, 'user-not-on-this-page'),
            action: fc.constantFrom(...ACTIONS),
        }),
        { maxLength: 6 },
    ),
    groups: fc.array(
        fc.record({
            groupUuid: fc.constantFrom('group-eng', 'group-finance'),
            action: fc.constantFrom(...ACTIONS),
        }),
        { maxLength: 4 },
    ),
});

const noGrants: ResourceAccessList = { users: [], groups: [] };

describe('given a principal who holds a grant on the resource', () => {
    describe('when the grant is what earned them their access', () => {
        it('then the grant can be revoked here, naming the action held', () => {
            const rows = toResourceAccessRows(
                [
                    share({
                        hasDirectAccess: true,
                        inheritedFrom: 'direct_resource',
                    }),
                ],
                {
                    users: [{ userUuid: 'user-ada', action: 'view' }],
                    groups: [],
                },
            );

            expect(rows).toEqual([
                {
                    share: rows[0].share,
                    grant: { kind: 'user_grant', actions: ['view'] },
                },
            ]);
        });
    });

    describe('when the grant is inert because a role already gave them more', () => {
        it('then it is still revocable, even though their access will survive', () => {
            // The resolver left `inheritedFrom: 'project'` here because the
            // project role decided the role -- but the grant row is still there,
            // and leaving it unrevokable would make it unremovable through the UI.
            const rows = toResourceAccessRows(
                [
                    share({
                        role: SpaceMemberRole.ADMIN,
                        hasDirectAccess: true,
                        inheritedFrom: 'project',
                    }),
                ],
                {
                    users: [{ userUuid: 'user-ada', action: 'view' }],
                    groups: [],
                },
            );

            expect(rows[0].grant).toEqual({
                kind: 'user_grant',
                actions: ['view'],
            });
        });
    });

    describe('when they hold both actions', () => {
        it('then revoking names every action, so it cannot demote by halves', () => {
            const rows = toResourceAccessRows([share({})], {
                users: [
                    { userUuid: 'user-ada', action: 'view' },
                    { userUuid: 'user-ada', action: 'manage' },
                ],
                groups: [],
            });

            // Most permissive first: a revoke that fails partway has then already
            // reduced access rather than left it untouched.
            expect(rows[0].grant).toEqual({
                kind: 'user_grant',
                actions: ['manage', 'view'],
            });
        });
    });
});

describe('given a principal who holds no grant of their own', () => {
    describe('when their access is inherited from a space or a role', () => {
        it('then there is nothing to revoke here', () => {
            const rows = toResourceAccessRows([share({})], noGrants);

            expect(rows[0].grant).toEqual({ kind: 'no_user_grant' });
        });
    });

    describe('when the resolver still attributed their access to a grant', () => {
        it('then there is nothing this surface can revoke for them', () => {
            // Reachable: a grant made to a group is expanded per member by the
            // resolver, but the grant list records it against the group. Offering
            // a revoke here would issue a DELETE for a row that does not exist --
            // which succeeds, reports success, and removes no access at all.
            const rows = toResourceAccessRows(
                [
                    share({
                        hasDirectAccess: true,
                        inheritedFrom: 'direct_resource',
                    }),
                ],
                {
                    users: [],
                    groups: [{ groupUuid: 'group-eng', action: 'view' }],
                },
            );

            expect(rows[0].grant).toEqual({ kind: 'no_user_grant' });
        });
    });
});

describe('given any resolved list and any set of grants', () => {
    test.prop([sharesArb, grantsArb])(
        'then revocability is decided by the grant list alone',
        (shares, grants) => {
            const rows = toResourceAccessRows(shares, grants);

            rows.forEach((row) => {
                const held = grants.users.filter(
                    (grant) => grant.userUuid === row.share.userUuid,
                );

                expect(row.grant.kind).toBe(
                    held.length > 0 ? 'user_grant' : 'no_user_grant',
                );
            });
        },
    );

    test.prop([sharesArb, grantsArb])(
        'then how the resolver attributed the role changes nothing',
        (shares, grants) => {
            // The property that would have caught reading `hasDirectAccess`: the
            // two fields a naive implementation would trust are both varied here,
            // and neither may move the answer.
            const asResolved = toResourceAccessRows(shares, grants);

            ORIGINS.forEach((origin) => {
                [true, false].forEach((hasDirectAccess) => {
                    const restated = toResourceAccessRows(
                        shares.map((entry) => ({
                            ...entry,
                            hasDirectAccess,
                            inheritedFrom: origin,
                        })),
                        grants,
                    );

                    expect(restated.map((row) => row.grant)).toEqual(
                        asResolved.map((row) => row.grant),
                    );
                });
            });
        },
    );

    test.prop([sharesArb, grantsArb])(
        'then a revoke names every action held, and nothing else',
        (shares, grants) => {
            toResourceAccessRows(shares, grants).forEach((row) => {
                if (row.grant.kind !== 'user_grant') return;

                const held = new Set(
                    grants.users
                        .filter(
                            (grant) => grant.userUuid === row.share.userUuid,
                        )
                        .map((grant) => grant.action),
                );

                expect(new Set(row.grant.actions)).toEqual(held);
                // Deduped: the same action twice would issue the same DELETE twice
                expect(row.grant.actions).toHaveLength(held.size);
            });
        },
    );

    test.prop([sharesArb, grantsArb])(
        'then the actions are ordered the same way every time',
        (shares, grants) => {
            toResourceAccessRows(shares, grants).forEach((row) => {
                if (row.grant.kind !== 'user_grant') return;

                const ranks = row.grant.actions.map((action) =>
                    REVOKE_ACTION_ORDER.indexOf(action),
                );

                expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
            });
        },
    );

    test.prop([sharesArb, grantsArb])(
        'then the page it was handed is the page it returns',
        (shares, grants) => {
            const rows = toResourceAccessRows(shares, grants);

            // A grant for someone outside the page must not invent a row, or
            // paging through the list would show a principal twice.
            expect(rows.map((row) => row.share)).toEqual(shares);
        },
    );

    test.prop([sharesArb, grantsArb])(
        'then a grant made to a group is never revocable through a person',
        (shares, grants) => {
            const rows = toResourceAccessRows(shares, {
                users: [],
                groups: grants.groups,
            });

            rows.forEach((row) => {
                expect(row.grant).toEqual({ kind: 'no_user_grant' });
            });
        },
    );
});

describe('given grants made to groups', () => {
    describe('when they are listed for management', () => {
        it('then each group appears once, with every action it holds', () => {
            expect(
                toGroupGrants({
                    users: [{ userUuid: 'user-ada', action: 'view' }],
                    groups: [
                        { groupUuid: 'group-finance', action: 'view' },
                        { groupUuid: 'group-eng', action: 'view' },
                        { groupUuid: 'group-eng', action: 'manage' },
                    ],
                }),
            ).toEqual([
                { groupUuid: 'group-eng', actions: ['manage', 'view'] },
                { groupUuid: 'group-finance', actions: ['view'] },
            ]);
        });
    });

    test.prop([grantsArb])(
        'then the list is stable and loses no group',
        (grants) => {
            const rows = toGroupGrants(grants);

            expect(rows.map((row) => row.groupUuid)).toEqual(
                [
                    ...new Set(grants.groups.map((grant) => grant.groupUuid)),
                ].sort((left, right) => left.localeCompare(right)),
            );

            rows.forEach((row) => {
                const held = new Set(
                    grants.groups
                        .filter((grant) => grant.groupUuid === row.groupUuid)
                        .map((grant) => grant.action),
                );

                expect(new Set(row.actions)).toEqual(held);
                expect(row.actions).toHaveLength(held.size);
            });
        },
    );
});
