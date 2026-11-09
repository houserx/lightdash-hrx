import { type Knex } from 'knex';

// ENG-1799 alerting: Alert Rules, their versions, per-series state and
// history, Contact Points, the Notification Route tree, the notification log
// and evaluator heartbeats. Values below are copied on purpose: migrations
// never import from @lightdash/common.

const AlertRulesTable = 'alert_rules';
const AlertRuleVersionsTable = 'alert_rule_versions';
const AlertInstancesTable = 'alert_instances';
const AlertStateHistoryTable = 'alert_state_history';
const ContactPointsTable = 'contact_points';
const NotificationRoutesTable = 'notification_routes';
const AlertNotificationsTable = 'alert_notifications';
const AlertEvaluatorHeartbeatsTable = 'alert_evaluator_heartbeats';

const INSTANCE_STATES = [
    'normal',
    'pending',
    'firing',
    'resolved',
    'nodata',
    'error',
];

export const classification = {
    kind: 'safe',
    reason: 'Creates eight new empty tables with check constraints; no existing table or row changes, and old versions never read them.',
};

const addTimestamps = (knex: Knex, table: Knex.CreateTableBuilder) => {
    table
        .timestamp('created_at', { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
    table
        .timestamp('updated_at', { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());
};

const addUserReference = (table: Knex.CreateTableBuilder, column: string) => {
    table
        .uuid(column)
        .nullable()
        .references('user_uuid')
        .inTable('users')
        .onDelete('SET NULL')
        .index();
};

export async function up(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");

    await knex.schema.createTable(AlertRulesTable, (table) => {
        table
            .uuid('alert_rule_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE')
            .index();
        // The folder. Deleting a space keeps its rules (folder cleared).
        table
            .uuid('space_uuid')
            .nullable()
            .references('space_uuid')
            .inTable('spaces')
            .onDelete('SET NULL')
            .index();
        table.text('slug').notNullable();
        table.text('name').notNullable();
        table.text('description').notNullable();
        table.text('query').notNullable();
        table.text('value_column').notNullable().defaultTo('value');
        table.text('reducer').notNullable().defaultTo('last');
        // {operator, threshold} or {operator: within_range|outside_range, min, max}
        table.jsonb('condition').notNullable();
        // Durations are kept as written (Prometheus format) so as-code
        // documents round-trip unchanged.
        table.text('for_duration').notNullable().defaultTo('0s');
        table.text('keep_firing_for').notNullable().defaultTo('0s');
        table.text('interval').notNullable().defaultTo('1m');
        table.text('time_range').notNullable().defaultTo('10m');
        table.text('no_data_state').notNullable().defaultTo('nodata');
        table.text('error_state').notNullable().defaultTo('error');
        table.jsonb('labels').notNullable().defaultTo('{}');
        table.jsonb('annotations').notNullable().defaultTo('{}');
        table.boolean('paused').notNullable().defaultTo(false);
        table.boolean('shadow').notNullable().defaultTo(false);
        table.boolean('managed').notNullable().defaultTo(false);
        addUserReference(table, 'created_by_user_uuid');
        addUserReference(table, 'updated_by_user_uuid');
        addTimestamps(knex, table);
        table.unique(['project_uuid', 'slug']);
    });
    await knex.raw(
        `ALTER TABLE ${AlertRulesTable} ADD CONSTRAINT alert_rules_description_not_blank CHECK (btrim(description) <> '')`,
    );

    await knex.schema.createTable(AlertRuleVersionsTable, (table) => {
        table
            .uuid('alert_rule_version_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('alert_rule_uuid')
            .notNullable()
            .references('alert_rule_uuid')
            .inTable(AlertRulesTable)
            .onDelete('CASCADE')
            .index();
        table.integer('version').notNullable();
        // A snapshot of the rule definition as saved.
        table.jsonb('definition').notNullable();
        addUserReference(table, 'created_by_user_uuid');
        table
            .timestamp('created_at', { useTz: true })
            .notNullable()
            .defaultTo(knex.fn.now());
        table.unique(['alert_rule_uuid', 'version']);
    });

    // Current state per series of a rule.
    await knex.schema.createTable(AlertInstancesTable, (table) => {
        table
            .uuid('alert_instance_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('alert_rule_uuid')
            .notNullable()
            .references('alert_rule_uuid')
            .inTable(AlertRulesTable)
            .onDelete('CASCADE')
            .index();
        table.text('fingerprint').notNullable();
        table.jsonb('labels').notNullable().defaultTo('{}');
        table.jsonb('annotations').notNullable().defaultTo('{}');
        table.text('state').notNullable();
        table.double('value').nullable();
        table.timestamp('state_since', { useTz: true }).notNullable();
        table.timestamp('active_at', { useTz: true }).nullable();
        table.timestamp('last_condition_met_at', { useTz: true }).nullable();
        table.timestamp('last_evaluated_at', { useTz: true }).notNullable();
        table.unique(['alert_rule_uuid', 'fingerprint']);
        table.index(['state']);
    });
    await knex.raw(
        `ALTER TABLE ${AlertInstancesTable} ADD CONSTRAINT alert_instances_state_check CHECK (state IN (${INSTANCE_STATES.map(
            (state) => `'${state}'`,
        ).join(', ')}))`,
    );

    // Every state transition, plus rule-level entries such as skipped
    // evaluations (no series: fingerprint is null).
    await knex.schema.createTable(AlertStateHistoryTable, (table) => {
        table
            .uuid('alert_state_history_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE')
            .index();
        table
            .uuid('alert_rule_uuid')
            .notNullable()
            .references('alert_rule_uuid')
            .inTable(AlertRulesTable)
            .onDelete('CASCADE')
            .index();
        table.text('fingerprint').nullable();
        table.jsonb('labels').notNullable().defaultTo('{}');
        table.text('previous_state').nullable();
        table.text('state').notNullable();
        table.double('value').nullable();
        table.text('reason').nullable();
        table.timestamp('at', { useTz: true }).notNullable();
        table.index(['alert_rule_uuid', 'at']);
        table.index(['project_uuid', 'at']);
    });

    await knex.schema.createTable(ContactPointsTable, (table) => {
        table
            .uuid('contact_point_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE')
            .index();
        table.text('slug').notNullable();
        table.text('name').notNullable();
        // Integration configs; secrets are only {secretRef} references.
        table.jsonb('integrations').notNullable().defaultTo('[]');
        table.boolean('managed').notNullable().defaultTo(false);
        addUserReference(table, 'created_by_user_uuid');
        addUserReference(table, 'updated_by_user_uuid');
        addTimestamps(knex, table);
        table.unique(['project_uuid', 'slug']);
    });

    // One Notification Route tree per project, saved and read as a whole.
    await knex.schema.createTable(NotificationRoutesTable, (table) => {
        table
            .uuid('notification_route_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('project_uuid')
            .notNullable()
            .unique()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE');
        table.jsonb('tree').notNullable();
        table.boolean('managed').notNullable().defaultTo(false);
        addUserReference(table, 'updated_by_user_uuid');
        addTimestamps(knex, table);
    });

    // The notification log: sent, failed and shadow (would-have-notified).
    await knex.schema.createTable(AlertNotificationsTable, (table) => {
        table
            .uuid('alert_notification_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE')
            .index();
        // Null for test notifications; the log outlives deleted rules and
        // Contact Points.
        table
            .uuid('alert_rule_uuid')
            .nullable()
            .references('alert_rule_uuid')
            .inTable(AlertRulesTable)
            .onDelete('SET NULL')
            .index();
        table
            .uuid('contact_point_uuid')
            .nullable()
            .references('contact_point_uuid')
            .inTable(ContactPointsTable)
            .onDelete('SET NULL')
            .index();
        table.text('integration_type').nullable();
        table.text('group_key').nullable().index();
        table.text('status').notNullable();
        table.integer('attempts').notNullable().defaultTo(0);
        table.jsonb('alerts').notNullable().defaultTo('[]');
        table.jsonb('payload').nullable();
        table.text('error').nullable();
        table
            .timestamp('created_at', { useTz: true })
            .notNullable()
            .defaultTo(knex.fn.now());
        table.timestamp('sent_at', { useTz: true }).nullable();
    });

    // One row per completed evaluation cycle.
    await knex.schema.createTable(AlertEvaluatorHeartbeatsTable, (table) => {
        table
            .uuid('alert_evaluator_heartbeat_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table.timestamp('cycle_started_at', { useTz: true }).nullable();
        table.timestamp('completed_at', { useTz: true }).notNullable().index();
        table.integer('rules_evaluated').notNullable().defaultTo(0);
        table.text('heartbeat_status').nullable();
        table.text('error').nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.dropTableIfExists(AlertEvaluatorHeartbeatsTable);
    await knex.schema.dropTableIfExists(AlertNotificationsTable);
    await knex.schema.dropTableIfExists(NotificationRoutesTable);
    await knex.schema.dropTableIfExists(ContactPointsTable);
    await knex.schema.dropTableIfExists(AlertStateHistoryTable);
    await knex.schema.dropTableIfExists(AlertInstancesTable);
    await knex.schema.dropTableIfExists(AlertRuleVersionsTable);
    await knex.schema.dropTableIfExists(AlertRulesTable);
}
