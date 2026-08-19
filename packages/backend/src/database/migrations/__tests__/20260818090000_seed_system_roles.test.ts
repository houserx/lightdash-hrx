import knex from 'knex';
import { getTracker, MockClient, Tracker } from 'knex-mock-client';
import { down, up } from '../20260818090000_seed_system_roles';

describe('seed system roles migration', () => {
    const database = knex({ client: MockClient, dialect: 'pg' });
    let tracker: Tracker;

    beforeAll(() => {
        tracker = getTracker();
    });

    afterEach(() => {
        tracker.reset();
    });

    it('inserts one roles row and one scoped_roles bulk-insert per role, all owner_type system', async () => {
        tracker.on.any(() => true).response({});

        await up(database);

        const statements = tracker.history.all;
        const rolesInsert = statements.find(({ sql }) =>
            sql.startsWith('insert into "roles"'),
        );
        const scopedRolesInsert = statements.find(({ sql }) =>
            sql.startsWith('insert into "scoped_roles"'),
        );

        if (!rolesInsert || !scopedRolesInsert) {
            throw new Error('Expected both bulk inserts to run');
        }

        // 11 system roles (6 organization + 5 project tiers)
        expect(rolesInsert.sql.match(/\(\$/g)).toHaveLength(11);
        expect(rolesInsert.sql).not.toContain('owner_type = ');
        expect(rolesInsert.bindings.filter((b) => b === 'system')).toHaveLength(
            11,
        );
        expect(rolesInsert.bindings.filter((b) => b === null).length).toBe(
            33, // description + organization_uuid + created_by, all null, per role
        );

        // Every scope from every role's flat scope list is its own row,
        // matching PROJECT_ROLE_TO_SCOPES_MAP/ORGANIZATION_ROLE_TO_SCOPES_MAP's
        // combined size at authoring time (600).
        expect(scopedRolesInsert.sql.match(/\(\$/g)).toHaveLength(600);
    });

    it('deletes scoped_roles before roles, scoped to the same 11 well-known role_uuids', async () => {
        tracker.on.any(() => true).response({});

        await down(database);

        const statements = tracker.history.all;
        expect(statements).toHaveLength(2);
        expect(statements[0].sql).toContain('delete from "scoped_roles"');
        expect(statements[0].sql).toContain('where "role_uuid" in');
        expect(statements[0].bindings).toHaveLength(11);
        expect(statements[1].sql).toContain('delete from "roles"');
        expect(statements[1].sql).toContain('where "role_uuid" in');
        expect(statements[1].bindings).toHaveLength(11);
        // Same 11 UUIDs feed both deletes, in the same order.
        expect(statements[1].bindings).toEqual(statements[0].bindings);
    });
});
