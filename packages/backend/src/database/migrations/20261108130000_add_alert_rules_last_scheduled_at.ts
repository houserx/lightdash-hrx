import { Knex } from 'knex';

const AlertRulesTableName = 'alert_rules';

// The alerting scheduler claims a rule's interval slot by moving this
// forward, so schedulers running side by side enqueue each slot only once.
export async function up(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.alterTable(AlertRulesTableName, (table) => {
        table.timestamp('last_scheduled_at', { useTz: true }).nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.alterTable(AlertRulesTableName, (table) => {
        table.dropColumn('last_scheduled_at');
    });
}
