import knex from 'knex';
import { getTracker, MockClient, Tracker } from 'knex-mock-client';
import { down, up } from '../20260818091500_add_resource_access_tables';

describe('add resource access tables migration', () => {
    const database = knex({ client: MockClient, dialect: 'pg' });
    let tracker: Tracker;

    beforeAll(() => {
        tracker = getTracker();
    });

    afterEach(() => {
        tracker.reset();
    });

    it('creates both tables then adds a CHECK constraint per table', async () => {
        tracker.on.any(() => true).response({});

        await up(database);

        const statements = tracker.history.all.map(({ sql }) => sql);
        const userTableCreate = statements.find((sql) =>
            sql.includes('create table "resource_user_access"'),
        );
        const groupTableCreate = statements.find((sql) =>
            sql.includes('create table "resource_group_access"'),
        );
        if (!userTableCreate || !groupTableCreate) {
            throw new Error('Expected both CREATE TABLE statements to run');
        }

        // Raw CHECK constraints for resource_type and action, one pair per
        // table -- these can't be expressed via the knex schema builder
        // (see migrations/CLAUDE.md: bind params aren't allowed in DDL, so
        // these must be inline literals via knex.raw).
        const checkConstraints = statements.filter((sql) =>
            sql.includes('ADD CONSTRAINT'),
        );
        expect(checkConstraints).toHaveLength(4);
        expect(
            checkConstraints.filter((sql) =>
                sql.includes("CHECK (resource_type IN ('Dashboard'"),
            ),
        ).toHaveLength(2);
        expect(
            checkConstraints.filter((sql) =>
                sql.includes("CHECK (action IN ('view', 'manage'"),
            ),
        ).toHaveLength(2);
    });

    it('drops both tables in down()', async () => {
        tracker.on.any(() => true).response({});

        await down(database);

        const statements = tracker.history.all.map(({ sql }) => sql);
        expect(
            statements.some((sql) =>
                sql.includes('drop table "resource_user_access"'),
            ),
        ).toBe(true);
        expect(
            statements.some((sql) =>
                sql.includes('drop table "resource_group_access"'),
            ),
        ).toBe(true);
    });
});
