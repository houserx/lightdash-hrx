// ldq-dashboard-time-range-migration: a migration stores the Dashboard Time Range on each
// dashboard version, in a nullable jsonb column dashboard_versions.time_range.
import { startMigratedDatabase, type MigratedDatabase } from './migratedDatabase';

let db: MigratedDatabase;

beforeAll(async () => {
    db = await startMigratedDatabase();
}, 240_000);

afterAll(async () => {
    await db?.stop();
});

describe('dashboard_versions.time_range', () => {
    it('exists as a nullable jsonb column', async () => {
        const rows = await db.database('information_schema.columns')
            .select('data_type', 'is_nullable')
            .where({ table_name: 'dashboard_versions', column_name: 'time_range' });
        expect(rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);
    });
});
