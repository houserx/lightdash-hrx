import { Knex } from 'knex';

const AlertRulesTableName = 'alert_rules';

// Set while a worker evaluates the rule's last claimed slot, cleared when the
// evaluation ends: a newer slot that comes due meanwhile is skipped as an
// overrun instead of running alongside it.
export async function up(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.alterTable(AlertRulesTableName, (table) => {
        table.timestamp('evaluation_started_at', { useTz: true }).nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.alterTable(AlertRulesTableName, (table) => {
        table.dropColumn('evaluation_started_at');
    });
}
