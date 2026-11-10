/* eslint-disable */
// @ts-nocheck
// imp-query-prometheus: a Grafana Prometheus target becomes CONTRACTS §1.1 promql() /
// promql_instant() SQL over the §2 reserved time parameters, in the pure module
// packages/common/src/eng1799/grafanaQuery.ts (no network, no Lightdash API).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    DATASOURCES,
    PROM,
    expectStructuredWarnings,
    isTimeRangeAware,
    loadGrafanaQuery,
    onlyCall,
    RESERVED,
} from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

describe('Prometheus targets', () => {
    it('is a pure module with no network or filesystem access', () => {
        expect(typeof q.translateGrafanaTarget).toBe('function');
        expect(typeof q.translateGrafanaPanelQueries).toBe('function');
        const source = readFileSync(
            path.resolve(__dirname, '../../eng1799/grafanaQuery.ts'),
            'utf8',
        );
        expect(source).not.toMatch(/from ['"](node:)?(fs|http|https|net|child_process)['"]/);
        expect(source).not.toMatch(/\bfetch\(|axios|node-fetch/);
    });

    it('turns a range query into promql() over __from, __to and __interval', () => {
        const result = q.translateGrafanaTarget(
            {
                refId: 'A',
                datasource: PROM,
                expr: 'sum by (status) (rate(http_requests_total{job="api"}[5m]))',
                range: true,
            },
            { datasources: DATASOURCES },
        );
        expectStructuredWarnings(result.warnings);
        expect(result.todo).toBeNull();
        expect(isTimeRangeAware(result.sql)).toBe(true);
        expect(result.sql).toContain('${ld.parameters.__interval}');
        const call = onlyCall(result.sql, 'promql');
        expect(call.args[0]).toBe(
            'sum by (status) (rate(http_requests_total{job="api"}[5m]))',
        );
        expect(call.args.slice(1, 4)).toEqual([
            RESERVED.__from,
            RESERVED.__to,
            RESERVED.__interval,
        ]);
        // The datasource resolves to the Telemetry Source named after it.
        expect(call.args[4]).toBe('prometheus-production');
    });

    it('turns an instant query into promql_instant() at __to', () => {
        const result = q.translateGrafanaTarget(
            {
                refId: 'A',
                datasource: PROM,
                expr: 'count(up == 0)',
                instant: true,
                range: false,
            },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        const call = onlyCall(result.sql, 'promql_instant');
        expect(call.args[0]).toBe('count(up == 0)');
        expect(call.args[1]).toBe(RESERVED.__to);
        expect(result.sql).toContain('${ld.parameters.__to}');
    });

    it('escapes quotes in the query so the SQL stays valid', () => {
        const expr = `label_replace(up, "x", "it's", "", "")`;
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: PROM, expr },
            { datasources: DATASOURCES },
        );
        expect(onlyCall(result.sql, 'promql').args[0]).toBe(expr);
    });

    it('warns, never drops silently, when a target has no expression', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: PROM, expr: '' },
            { datasources: DATASOURCES },
        );
        expect(result.sql).toBeNull();
        expect(typeof result.todo).toBe('string');
        expect(result.warnings.length).toBeGreaterThan(0);
        expectStructuredWarnings(result.warnings);
    });
});
