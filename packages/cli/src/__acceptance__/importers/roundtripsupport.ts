/* eslint-disable */
// @ts-nocheck
// Helpers for the round-trip acceptance tests (protected): import every fixture with the
// options a person would use for Cutover.
import path from 'node:path';
import {
    DATASOURCES_TF,
    PERSES,
    TF,
    calls,
    fixtureDashboards,
    importFixtureAlerts,
    importGrafanaDashboards,
    importPerses,
    literals,
    RESERVED,
} from './support';

export const importAllDashboards = () =>
    importGrafanaDashboards(fixtureDashboards(), [
        '--datasources',
        DATASOURCES_TF,
        '--dashboards-tf',
        path.join(TF, 'grafana_dashboards.tf'),
    ]);
export const importAllAlerts = () => importFixtureAlerts();
export const importAllPerses = () =>
    importPerses([path.join(PERSES, 'node-overview.yaml'), path.join(PERSES, 'api-latency.json')]);

/** Gives every parameter a value: the reserved ones from RESERVED, the rest 'test'. */
export const allParams = (sql: string) =>
    Object.fromEntries(
        [...sql.matchAll(/\$\{ld\.parameters\.([A-Za-z0-9_]+)\}/g)].map((m) => [m[1], RESERVED[m[1]] ?? 'test']),
    );

export const TELEMETRY_FUNCTIONS = ['promql', 'promql_instant', 'logql', 'logql_metric', 'cloudwatch', 'cloudwatch_logs', 'platform_query'];

/**
 * SQL is not broken: it folds (balanced quotes), no Grafana macro or variable syntax is left in
 * a literal, and every telemetry call is time-range-aware (platform_query only when it used a
 * time macro, so not checked here).
 */
export const expectSoundSql = (sql: string, where: string) => {
    expect(sql.trim().length, where).toBeGreaterThan(0);
    const params = allParams(sql);
    const lits = literals(sql, params);
    for (const lit of lits) {
        expect(lit, where).not.toMatch(/\$__(interval|rate_interval|range|from|to|timeFilter|timeFrom|timeTo|timeGroup)\b/);
        expect(lit, where).not.toMatch(/\[\[[A-Za-z0-9_]+\]\]/);
    }
    for (const fn of TELEMETRY_FUNCTIONS.filter((f) => f !== 'platform_query')) {
        if (calls(sql, fn, params).length > 0) {
            expect(sql.includes('${ld.parameters.__to}'), where).toBe(true);
        }
    }
};
