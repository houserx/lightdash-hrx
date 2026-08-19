import { DirectResourceAccessOrigin } from '@lightdash/common';
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
    });
});
