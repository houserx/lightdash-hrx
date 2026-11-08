import { Knex } from 'knex';

// Dashboard Time Range (relative or absolute bounds, refresh interval and per-tile time
// dimensions) stored per dashboard version. Nullable: versions without one keep today's behaviour.
const DashboardVersionsTableName = 'dashboard_versions';

export async function up(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.alterTable(DashboardVersionsTableName, (table) => {
        table.jsonb('time_range').nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.alterTable(DashboardVersionsTableName, (table) => {
        table.dropColumn('time_range');
    });
}
