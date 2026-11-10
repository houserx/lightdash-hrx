import { Knex } from 'knex';

const AlertNotificationGroupsTableName = 'alert_notification_groups';

// The notifier's dispatcher state: one row per notification group (a route's
// group key at one Contact Point) that has been notified, with when it was
// last sent and which alerts that send contained. It is what keeps a group
// from being sent twice and times group_interval / repeat_interval.
export async function up(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.createTable(AlertNotificationGroupsTableName, (table) => {
        table
            .uuid('alert_notification_group_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE')
            .index();
        table.text('contact_point_slug').notNullable();
        table.text('group_key').notNullable();
        table.timestamp('last_sent_at', { useTz: true }).notNullable();
        // {"<ruleUuid>:<fingerprint>": "firing" | "resolved"} as last sent.
        table.jsonb('sent_alerts').notNullable().defaultTo('{}');
        table
            .timestamp('created_at', { useTz: true })
            .notNullable()
            .defaultTo(knex.fn.now());
        table.unique(['project_uuid', 'contact_point_slug', 'group_key']);
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.dropTableIfExists(AlertNotificationGroupsTableName);
}
