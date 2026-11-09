/* eslint-disable */
// @ts-nocheck
// Acceptance test (protected): loosely typed on purpose, it drives modules
// that later sessions build. Lint rules don't apply here.
// alert-db-migrations: Lightdash's knex migrations create the alerting tables.
import { describe, expect, it } from 'vitest';
import { createMigratedDatabase } from '../../testing/migratedDatabase';

const TABLES = [
    'alert_rules',
    'alert_rule_versions',
    'alert_instances',
    'alert_state_history',
    'contact_points',
    'notification_routes',
    'alert_notifications',
    'alert_evaluator_heartbeats',
];

describe('alert-db-migrations', () => {
    it('creates the alerting tables with the rule flags', async () => {
        const migrated = await createMigratedDatabase(undefined, {
            min: 0,
            max: 2,
        });
        try {
            const db = migrated.database;
            const tables = await db('information_schema.tables')
                .where({ table_schema: 'public' })
                .whereIn('table_name', TABLES)
                .pluck('table_name');
            expect([...tables].sort()).toEqual([...TABLES].sort());
            const columns = await db('information_schema.columns')
                .where({ table_schema: 'public', table_name: 'alert_rules' })
                .select('column_name', 'is_nullable', 'data_type');
            const byName = Object.fromEntries(
                columns.map((c: any) => [c.column_name, c]),
            );
            expect(byName.description?.is_nullable).toBe('NO');
            for (const flag of ['paused', 'shadow', 'managed'])
                expect(byName[flag]?.data_type).toBe('boolean');
            expect(byName.project_uuid).toBeDefined();
            const fks = await db.raw(`
                SELECT tc.table_name FROM information_schema.table_constraints tc
                JOIN information_schema.constraint_column_usage ccu
                  ON tc.constraint_name = ccu.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND ccu.table_name = 'projects' AND tc.table_name = 'alert_rules'`);
            // rules are deleted with their project
            expect(fks.rows.length).toBeGreaterThan(0);
        } finally {
            await migrated.destroy();
        }
    });
});
