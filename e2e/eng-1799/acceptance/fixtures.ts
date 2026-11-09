/* eslint-disable */
// @ts-nocheck
/** Fixed synthetic fixtures shared by the ENG-1799 e2e checks (protected). No PHI. */
import { iso, T0 } from './support';

export const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
export const syntheticTrace = {
    traceId: TRACE_ID,
    rootServiceName: 'refills-api',
    rootTraceName: 'POST /refills',
    start: iso(T0 + 1_000),
    durationMs: 120,
    spans: [
        { spanId: 'b7ad6b7169203331', service: 'refills-api', name: 'POST /refills', start: iso(T0 + 1_000), durationMs: 120, status: 'ok', attributes: { 'http.status_code': 201 } },
        { spanId: '00f067aa0ba902b7', parentSpanId: 'b7ad6b7169203331', service: 'pharmacy-db', name: 'INSERT refills', start: iso(T0 + 1_010), durationMs: 80, status: 'error', attributes: { 'db.system': 'postgresql' } },
    ],
};

export const OPS_MART_TABLES = [
    {
        dataset: 'ops_marts',
        table: 'fills_hourly',
        columns: [
            { name: 'hour', type: 'TIMESTAMP' },
            { name: 'site', type: 'STRING' },
            { name: 'fills', type: 'INT64' },
        ],
        rows: [
            ['2026-11-08T09:00:00Z', 'site-a', 12],
            ['2026-11-08T10:00:00Z', 'site-a', 15],
        ],
    },
    {
        dataset: 'ops_marts',
        table: 'queue_depth',
        columns: [
            { name: 'at', type: 'TIMESTAMP' },
            { name: 'depth', type: 'FLOAT64' },
        ],
        rows: [['2026-11-08T10:00:00Z', 3.5]],
    },
];

/** Synthetic Platform Database rows the harness seeds: public.widgets(id 1..200, name 'widget-<id>', qty id % 7). */
export const WIDGET_COUNT = 200;

/**
 * An Alert Rule query in the Lightdash SQL convention: reserved parameters are bare references that
 * Lightdash's substitution quotes. One value per series: the max of the window.
 */
export const RULE_SQL = (metric = 'db_cpu', source?: string) =>
    `SELECT max(value) AS value, labels FROM promql('${metric}', \${ld.parameters.__from}, \${ld.parameters.__to}, \${ld.parameters.__interval}${source ? `, '${source}'` : ''}) GROUP BY labels`;
