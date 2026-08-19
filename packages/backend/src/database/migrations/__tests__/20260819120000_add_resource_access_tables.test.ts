import knex from 'knex';
import { getTracker, MockClient, Tracker } from 'knex-mock-client';
import { down, up } from '../20260819120000_add_resource_access_tables';

const runUp = async (tracker: Tracker) => {
    tracker.on.any(() => true).response({});
    const database = knex({ client: MockClient, dialect: 'pg' });
    await up(database);
    return tracker.history.all.map(({ sql }) => sql);
};

describe('add resource access tables migration', () => {
    let tracker: Tracker;

    beforeAll(() => {
        tracker = getTracker();
    });

    afterEach(() => {
        tracker.reset();
    });

    describe('given the migration runs forward', () => {
        it('then it creates both grant tables', async () => {
            const statements = await runUp(tracker);

            expect(
                statements.some(
                    (sql) =>
                        sql.includes('create table') &&
                        sql.includes('resource_user_access'),
                ),
            ).toBe(true);
            expect(
                statements.some(
                    (sql) =>
                        sql.includes('create table') &&
                        sql.includes('resource_group_access'),
                ),
            ).toBe(true);
        });

        it('then resource_type and action are constrained to literal allowlists', async () => {
            const statements = await runUp(tracker);
            const checks = statements.filter((sql) => sql.includes('CHECK ('));

            // Two per table: widening either allowlist has to be a new
            // migration, so a resource type cannot silently become grantable.
            expect(checks).toHaveLength(4);
            expect(
                checks.filter((sql) =>
                    sql.includes(
                        "resource_type IN ('Dashboard', 'SavedChart')",
                    ),
                ),
            ).toHaveLength(2);
            expect(
                checks.filter((sql) =>
                    sql.includes("action IN ('view', 'manage')"),
                ),
            ).toHaveLength(2);
        });

        it('then each unique constraint leads with its principal column', async () => {
            const statements = await runUp(tracker);
            const uniques = statements.filter(
                (sql) =>
                    sql.includes('add constraint') && sql.includes('unique'),
            );

            // The read path filters by principal first, then by resource uuid,
            // so the implicit btree behind each unique constraint has to lead
            // with the principal column for that lookup to be indexed.
            expect(
                uniques.some(
                    (sql) =>
                        sql.includes('resource_user_access') &&
                        sql.indexOf('user_uuid') < sql.indexOf('resource_uuid'),
                ),
            ).toBe(true);
            expect(
                uniques.some(
                    (sql) =>
                        sql.includes('resource_group_access') &&
                        sql.indexOf('group_uuid') <
                            sql.indexOf('resource_uuid'),
                ),
            ).toBe(true);
        });

        it('then grants are removed with their principal and their project', async () => {
            const statements = await runUp(tracker);
            const cascades = statements.filter((sql) =>
                sql.includes('on delete CASCADE'),
            );

            // user_uuid, group_uuid and project_uuid across both tables.
            expect(cascades.length).toBeGreaterThanOrEqual(4);
        });

        it('then granted_by is nulled rather than cascading', async () => {
            const statements = await runUp(tracker);

            // Offboarding the granter must not silently revoke access that is
            // still legitimately held.
            expect(
                statements.filter((sql) => sql.includes('on delete SET NULL')),
            ).toHaveLength(2);
        });

        it('then resource_uuid is indexed for listing who holds a grant', async () => {
            const statements = await runUp(tracker);
            const indexes = statements.filter((sql) =>
                sql.includes('create index'),
            );

            expect(
                indexes.filter((sql) => sql.includes('resource_uuid')),
            ).toHaveLength(2);
        });
    });

    describe('given the migration is rolled back', () => {
        it('then both tables are dropped', async () => {
            tracker.on.any(() => true).response({});
            const database = knex({ client: MockClient, dialect: 'pg' });

            await down(database);

            const statements = tracker.history.all.map(({ sql }) => sql);
            expect(
                statements.filter((sql) => sql.includes('drop table')),
            ).toHaveLength(2);
        });
    });
});
