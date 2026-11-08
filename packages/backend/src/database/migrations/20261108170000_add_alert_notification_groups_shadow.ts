import { Knex } from 'knex';

const AlertNotificationGroupsTableName = 'alert_notification_groups';

// Shadow rules are grouped and timed like any other, but only recorded in the
// send log. Their groups are kept apart from the real ones (same route and
// group key) so a shadow rule never delays, repeats or resolves a real send.
export async function up(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.alterTable(AlertNotificationGroupsTableName, (table) => {
        table.boolean('shadow').notNullable().defaultTo(false);
        table.dropUnique(['project_uuid', 'contact_point_slug', 'group_key']);
        table.unique([
            'project_uuid',
            'contact_point_slug',
            'group_key',
            'shadow',
        ]);
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex(AlertNotificationGroupsTableName).where('shadow', true).delete();
    await knex.schema.alterTable(AlertNotificationGroupsTableName, (table) => {
        table.dropUnique([
            'project_uuid',
            'contact_point_slug',
            'group_key',
            'shadow',
        ]);
        table.dropColumn('shadow');
        table.unique(['project_uuid', 'contact_point_slug', 'group_key']);
    });
}
