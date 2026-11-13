/**
 * Synthetic Platform Database for ask_data tests, served by the fake engine through the §1.1 table
 * functions only: platform_tables(), platform_columns(schema, table) and platform_query(sql).
 * PROTECTED: do not edit.
 */
import type { EngineQuery, EngineResult, FakeEngine } from './engine';

export const ORDERS_COUNT_SQL = 'SELECT count(*) AS n FROM orders';

export function installPlatformCatalog(
    engine: FakeEngine,
    answer: (sqlParam: string, q: EngineQuery) => EngineResult | undefined = () => undefined,
): void {
    engine.on(/\bplatform_tables\s*\(/i, {
        columns: [
            { name: 'table_schema', type: 'text' },
            { name: 'table_name', type: 'text' },
        ],
        rows: [
            ['public', 'orders'],
            ['public', 'fills'],
        ],
    });
    engine.on(/\bplatform_columns\s*\(/i, (q) => {
        const table = q.params.find((p) => p === 'orders' || p === 'fills');
        const cols: [string, string, boolean][] =
            table === 'fills'
                ? [
                      ['id', 'bigint', false],
                      ['order_id', 'bigint', false],
                      ['filled_at', 'timestamp with time zone', true],
                  ]
                : [
                      ['id', 'bigint', false],
                      ['status', 'text', false],
                      ['created_at', 'timestamp with time zone', false],
                  ];
        return {
            columns: [
                { name: 'column_name', type: 'text' },
                { name: 'data_type', type: 'text' },
                { name: 'is_nullable', type: 'bool' },
            ],
            rows: cols,
        };
    });
    engine.on(/\bplatform_query\s*\(/i, (q) => {
        const sqlParam = q.params.find((p) => p !== null && /\bselect\b|\bwith\b/i.test(p)) ?? '';
        const custom = answer(sqlParam, q);
        if (custom) return custom;
        if (/count\(\*\)\s+AS\s+n\s+FROM\s+orders/i.test(sqlParam)) {
            return { columns: [{ name: 'n', type: 'int8' }], rows: [[42]] };
        }
        return { error: { code: '42P01', message: 'relation does not exist' } };
    });
}

/** A submit_answer input the portal's data assistant accepts as grounded in run_sql call 1. */
export function answered(answer: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        status: 'answered',
        answer,
        confidence: 'high',
        basis: 'query_results',
        evidence_queries: [1],
        assumptions: [],
        caveats: [],
        ...extra,
    };
}
