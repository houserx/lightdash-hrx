import { fc, test } from '@fast-check/vitest';
import {
    DirectResourceAccessOrigin,
    type ResourceAccessResourceType,
} from '@lightdash/common';
import knex from 'knex';
import { getTracker, MockClient, Tracker } from 'knex-mock-client';
import { ResourceAccessModel } from './ResourceAccessModel';

const USER_UUID = 'user-1';
const DASHBOARD_A = 'dashboard-a';
const DASHBOARD_B = 'dashboard-b';

describe('ResourceAccessModel', () => {
    const database = knex({ client: MockClient, dialect: 'pg' });
    const model = new ResourceAccessModel(database);
    let tracker: Tracker;

    beforeAll(() => {
        tracker = getTracker();
    });

    afterEach(() => {
        tracker.reset();
    });

    describe('getDirectResourceAccess', () => {
        describe('given no resource uuids', () => {
            it('then it returns nothing without querying', async () => {
                const result = await model.getDirectResourceAccess(
                    'Dashboard',
                    [],
                    { userUuid: USER_UUID },
                );

                expect(result).toEqual({});
                expect(tracker.history.all).toHaveLength(0);
            });
        });

        describe('given grants exist for the user', () => {
            it('then they are grouped by resource uuid', async () => {
                tracker.on
                    .any(() => true)
                    .response([
                        {
                            userUuid: USER_UUID,
                            resourceUuid: DASHBOARD_A,
                            groupUuid: null,
                            action: 'view',
                            from: DirectResourceAccessOrigin.USER_ACCESS,
                        },
                        {
                            userUuid: USER_UUID,
                            resourceUuid: DASHBOARD_B,
                            groupUuid: 'group-1',
                            action: 'manage',
                            from: DirectResourceAccessOrigin.GROUP_ACCESS,
                        },
                    ]);

                const result = await model.getDirectResourceAccess(
                    'Dashboard',
                    [DASHBOARD_A, DASHBOARD_B],
                    { userUuid: USER_UUID },
                );

                expect(Object.keys(result).sort()).toEqual([
                    DASHBOARD_A,
                    DASHBOARD_B,
                ]);
                expect(result[DASHBOARD_A]).toEqual([
                    {
                        userUuid: USER_UUID,
                        resourceUuid: DASHBOARD_A,
                        groupUuid: null,
                        action: 'view',
                        from: DirectResourceAccessOrigin.USER_ACCESS,
                    },
                ]);
                expect(result[DASHBOARD_B][0].from).toBe(
                    DirectResourceAccessOrigin.GROUP_ACCESS,
                );
            });

            it('then a resource with no grants is absent rather than empty', async () => {
                tracker.on
                    .any(() => true)
                    .response([
                        {
                            userUuid: USER_UUID,
                            resourceUuid: DASHBOARD_A,
                            groupUuid: null,
                            action: 'view',
                            from: DirectResourceAccessOrigin.USER_ACCESS,
                        },
                    ]);

                const result = await model.getDirectResourceAccess(
                    'Dashboard',
                    [DASHBOARD_A, DASHBOARD_B],
                    { userUuid: USER_UUID },
                );

                expect(result[DASHBOARD_B]).toBeUndefined();
            });
        });

        describe('given the query is built', () => {
            const capture = async (resourceUuids: string[]) => {
                tracker.on.any(() => true).response([]);
                await model.getDirectResourceAccess(
                    'Dashboard',
                    resourceUuids,
                    {
                        userUuid: USER_UUID,
                    },
                );
                return tracker.history.all;
            };

            it('then it costs one query regardless of how many resources are asked for', async () => {
                // The performance claim this whole design rests on: resolving a
                // 200-item list must not scale in round trips. Both grant tables
                // are read in a single UNION.
                const one = await capture([DASHBOARD_A]);
                expect(one).toHaveLength(1);

                tracker.reset();

                const many = await capture(
                    Array.from({ length: 200 }, (_, i) => `dashboard-${i}`),
                );
                expect(many).toHaveLength(1);
            });

            it('then it reads both grant tables', async () => {
                const [{ sql }] = await capture([DASHBOARD_A]);

                expect(sql).toContain('resource_user_access');
                expect(sql).toContain('resource_group_access');
            });

            it('then group grants are resolved through group membership', async () => {
                const [{ sql }] = await capture([DASHBOARD_A]);

                // group_memberships keys on user_id, so reaching a user_uuid
                // filter requires joining users.
                expect(sql).toContain('group_memberships');
                expect(sql).toContain('users');
            });

            it('then it filters by principal, resource type and resource uuid', async () => {
                const [{ sql, bindings }] = await capture([DASHBOARD_A]);

                expect(sql.toLowerCase()).toContain('where');
                expect(bindings).toContain(USER_UUID);
                expect(bindings).toContain('Dashboard');
                expect(bindings).toContain(DASHBOARD_A);
            });

            it('then it never returns grants for another resource type', async () => {
                const [{ bindings }] = await capture([DASHBOARD_A]);

                // Both branches must be constrained, or a SavedChart grant could
                // satisfy a Dashboard check on a colliding uuid.
                expect(
                    bindings.filter((binding) => binding === 'Dashboard'),
                ).toHaveLength(2);
            });
        });

        describe('write path', () => {
            it('given a user grant, then it is upserted with the granter recorded', async () => {
                tracker.on.any(() => true).response([]);

                await model.addUserAccess({
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_A,
                    projectUuid: 'project-1',
                    targetUserUuid: 'grantee-1',
                    action: 'view',
                    grantedByUserUuid: USER_UUID,
                });

                const [{ sql, bindings }] = tracker.history.all;
                expect(sql).toContain('resource_user_access');
                expect(sql.toLowerCase()).toContain('on conflict');
                expect(bindings).toContain('grantee-1');
                expect(bindings).toContain(USER_UUID);
            });

            it('given a group grant, then it is upserted against the group table', async () => {
                tracker.on.any(() => true).response([]);

                await model.addGroupAccess({
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_A,
                    projectUuid: 'project-1',
                    targetGroupUuid: 'group-1',
                    action: 'manage',
                    grantedByUserUuid: USER_UUID,
                });

                const [{ sql, bindings }] = tracker.history.all;
                expect(sql).toContain('resource_group_access');
                expect(bindings).toContain('group-1');
            });

            it('given a revoke, then it deletes only that principal action pair', async () => {
                tracker.on.any(() => true).response([]);

                await model.removeUserAccess({
                    resourceType: 'Dashboard',
                    resourceUuid: DASHBOARD_A,
                    targetUserUuid: 'grantee-1',
                    action: 'view',
                });

                const [{ sql, bindings }] = tracker.history.all;
                expect(sql.toLowerCase()).toContain('delete');
                expect(bindings).toContain('grantee-1');
                expect(bindings).toContain('view');
                expect(bindings).toContain('Dashboard');
            });

            it('given a listing, then both tables are read for the resource', async () => {
                tracker.on.any(() => true).response([]);

                await model.listResourceAccess('Dashboard', DASHBOARD_A);

                // Two focused reads rather than a UNION: users and groups carry
                // different metadata, so callers want them separately.
                expect(tracker.history.all).toHaveLength(2);
            });
        });

        describe('grantee organization validation', () => {
            it('given the user holds a membership, then it reports true', async () => {
                tracker.on
                    .any(() => true)
                    .response([{ userUuid: 'grantee-1' }]);

                await expect(
                    model.isUserInOrganization('org-1', 'grantee-1'),
                ).resolves.toBe(true);
            });

            it('given the user holds no membership, then it reports false', async () => {
                tracker.on.any(() => true).response([]);

                await expect(
                    model.isUserInOrganization('org-1', 'grantee-1'),
                ).resolves.toBe(false);
            });

            it('given the user is checked, then the organization is part of the filter', async () => {
                tracker.on.any(() => true).response([]);

                await model.isUserInOrganization('org-1', 'grantee-1');

                const [{ bindings }] = tracker.history.all;
                expect(bindings).toContain('org-1');
                expect(bindings).toContain('grantee-1');
            });

            it('given a group in the organization, then it reports true', async () => {
                tracker.on.any(() => true).response([{ groupUuid: 'group-1' }]);

                await expect(
                    model.isGroupInOrganization('org-1', 'group-1'),
                ).resolves.toBe(true);
            });

            it('given a group outside the organization, then it reports false', async () => {
                tracker.on.any(() => true).response([]);

                await expect(
                    model.isGroupInOrganization('org-1', 'group-1'),
                ).resolves.toBe(false);
            });
        });
    });

    describe('removeAllForResource', () => {
        it('given a resource is purged, then both tables are cleared for it', async () => {
            tracker.on.any(() => true).response([]);

            await model.removeAllForResource('Dashboard', DASHBOARD_A);

            const statements = tracker.history.all.map(({ sql }) => sql);
            expect(statements).toHaveLength(2);
            expect(
                statements.filter((sql) =>
                    sql.toLowerCase().startsWith('delete'),
                ),
            ).toHaveLength(2);
        });

        it('given a resource is purged, then cleanup is scoped by resource type', async () => {
            tracker.on.any(() => true).response([]);

            await model.removeAllForResource('Dashboard', DASHBOARD_A);

            // A SavedChart grant must survive a Dashboard purge, even on a
            // colliding uuid -- resource_uuid is polymorphic, so uuid alone is
            // not a safe key.
            tracker.history.all.forEach(({ bindings }) => {
                expect(bindings).toContain('Dashboard');
                expect(bindings).toContain(DASHBOARD_A);
            });
        });
    });

    describe('getGrantedResourceUuids', () => {
        it('given grants in the projects, then it returns their resource uuids', async () => {
            tracker.on
                .any(() => true)
                .response([
                    { resourceUuid: DASHBOARD_A },
                    { resourceUuid: DASHBOARD_B },
                ]);

            await expect(
                model.getGrantedResourceUuids(
                    USER_UUID,
                    ['project-1'],
                    ['Dashboard'],
                ),
            ).resolves.toEqual([DASHBOARD_A, DASHBOARD_B]);
        });

        it('given no projects, then it returns nothing without querying', async () => {
            await expect(
                model.getGrantedResourceUuids(USER_UUID, [], ['Dashboard']),
            ).resolves.toEqual([]);

            expect(tracker.history.all).toHaveLength(0);
        });

        it('given no resource types, then it returns nothing without querying', async () => {
            await expect(
                model.getGrantedResourceUuids(USER_UUID, ['project-1'], []),
            ).resolves.toEqual([]);

            expect(tracker.history.all).toHaveLength(0);
        });

        it('given the lookup runs, then it is scoped by principal, projects and resource types', async () => {
            tracker.on.any(() => true).response([]);

            await model.getGrantedResourceUuids(
                USER_UUID,
                ['project-1', 'project-2'],
                ['Dashboard', 'SavedChart'],
            );

            const [{ sql, bindings }] = tracker.history.all;
            expect(sql).toContain('resource_user_access');
            expect(sql).toContain('resource_group_access');
            expect(bindings).toContain(USER_UUID);
            expect(bindings).toContain('project-1');
            expect(bindings).toContain('project-2');
            expect(bindings).toContain('Dashboard');
            expect(bindings).toContain('SavedChart');
        });

        // Content browse is the highest-cardinality read in the product, and it
        // cannot name the resources it wants up front -- so this lookup is keyed
        // on the project instead. Asking it per project, or per resource type,
        // reintroduces exactly the round-trip growth this design answers.
        test.prop([
            fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 25 }),
            fc.uniqueArray(
                fc.constantFrom<ResourceAccessResourceType>(
                    'Dashboard',
                    'SavedChart',
                ),
                { minLength: 1, maxLength: 2 },
            ),
        ])(
            'costs one query whatever the project and resource-type counts',
            async (projectUuids, resourceTypes) => {
                tracker.reset();
                tracker.on.any(() => true).response([]);

                await model.getGrantedResourceUuids(
                    USER_UUID,
                    projectUuids,
                    resourceTypes,
                );

                expect(tracker.history.all).toHaveLength(1);
            },
        );
    });

    describe('getAllDirectResourceAccess', () => {
        it('given grants on the resource, then every principal is returned', async () => {
            tracker.on
                .any(() => true)
                .response([
                    {
                        userUuid: USER_UUID,
                        resourceUuid: DASHBOARD_A,
                        groupUuid: null,
                        action: 'view',
                        from: DirectResourceAccessOrigin.USER_ACCESS,
                    },
                    {
                        userUuid: 'user-2',
                        resourceUuid: DASHBOARD_A,
                        groupUuid: 'group-1',
                        action: 'manage',
                        from: DirectResourceAccessOrigin.GROUP_ACCESS,
                    },
                ]);

            // Group grants arrive already expanded to one row per member, the
            // same shape getDirectResourceAccess returns -- so the resolver does
            // not have to know a group was involved.
            await expect(
                model.getAllDirectResourceAccess('Dashboard', DASHBOARD_A),
            ).resolves.toEqual([
                {
                    userUuid: USER_UUID,
                    resourceUuid: DASHBOARD_A,
                    groupUuid: null,
                    action: 'view',
                    from: DirectResourceAccessOrigin.USER_ACCESS,
                },
                {
                    userUuid: 'user-2',
                    resourceUuid: DASHBOARD_A,
                    groupUuid: 'group-1',
                    action: 'manage',
                    from: DirectResourceAccessOrigin.GROUP_ACCESS,
                },
            ]);
        });

        it('given the lookup runs, then it costs one query', async () => {
            tracker.on.any(() => true).response([]);

            await model.getAllDirectResourceAccess('Dashboard', DASHBOARD_A);

            expect(tracker.history.all).toHaveLength(1);
        });

        it('given the lookup runs, then it is scoped to the resource and its type', async () => {
            tracker.on.any(() => true).response([]);

            await model.getAllDirectResourceAccess('Dashboard', DASHBOARD_A);

            const [{ sql, bindings }] = tracker.history.all;
            expect(sql).toContain('resource_user_access');
            expect(sql).toContain('resource_group_access');
            expect(bindings).toContain(DASHBOARD_A);
            expect(
                bindings.filter((binding) => binding === 'Dashboard'),
            ).toHaveLength(2);
            // Unlike the per-user read, this one is deliberately not scoped to a
            // principal -- it answers "who can see this", not "can I see this".
            expect(bindings).not.toContain(USER_UUID);
        });
    });
});
