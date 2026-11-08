import { Knex } from 'knex';

// Frozen copies of ChartType.LOG_STREAM and ChartType.TRACE_WATERFALL.
const NEW_CHART_TYPES = ['log_stream', 'trace_waterfall'];

export async function up(knex: Knex): Promise<void> {
    await knex('chart_types').insert(
        NEW_CHART_TYPES.map((chartType) => ({ chart_type: chartType })),
    );
}

export async function down(knex: Knex): Promise<void> {
    await knex('saved_queries_versions')
        .whereIn('chart_type', NEW_CHART_TYPES)
        .delete();
    await knex('chart_types').delete().whereIn('chart_type', NEW_CHART_TYPES);
}
