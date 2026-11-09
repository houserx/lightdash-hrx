import { Knex } from 'knex';

const AlertRulesTableName = 'alert_rules';

// An alerting worker claims a rule's interval slot by moving this forward
// before it runs the rule's query, so workers running side by side evaluate
// each slot only once.
export async function up(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.alterTable(AlertRulesTableName, (table) => {
        table.timestamp('last_evaluation_slot', { useTz: true }).nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw("SET LOCAL lock_timeout = '60s'");
    await knex.schema.alterTable(AlertRulesTableName, (table) => {
        table.dropColumn('last_evaluation_slot');
    });
}
