/* eslint-disable */
// @ts-nocheck
// imp-query-datasources: a target's datasource resolves to a Telemetry Source (the engine
// source named after the Grafana datasource), from the target, the panel or a variable, and
// an unknown or unsupported datasource is a structured warning.
import { DATASOURCES, PROM, calls, codes, loadGrafanaQuery, onlyCall } from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

describe('datasource resolution', () => {
    it('falls back to the panel datasource', () => {
        const result = q.translateGrafanaPanelQueries(
            {
                type: 'timeseries',
                datasource: { type: 'prometheus', uid: 'dW0QDuzIz' },
                targets: [{ refId: 'A', expr: 'up' }],
            },
            { datasources: DATASOURCES },
        );
        expect(onlyCall(result.sql, 'promql').args[4]).toBe('prometheus-staging');
    });

    it('finds the type from the uid when the reference has none', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: { uid: 'GA4WkvzSz' }, expr: 'rate({app="api"}[5m])' },
            { datasources: DATASOURCES },
        );
        expect(onlyCall(result.sql, 'logql_metric').args[4]).toBe('loki-production');
    });

    it('accepts the legacy datasource name string', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: 'Prometheus-Production', expr: 'up' },
            { datasources: DATASOURCES },
        );
        expect(onlyCall(result.sql, 'promql').args[4]).toBe('prometheus-production');
    });

    it('uses the engine default source, with a warning, for an unknown uid', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: { type: 'prometheus', uid: 'not-in-the-list' }, expr: 'up' },
            { datasources: DATASOURCES },
        );
        const call = onlyCall(result.sql, 'promql');
        expect(call.args).toHaveLength(4);
        expect(codes(result.warnings)).toContain('datasource-unresolved');
    });

    it('turns an unsupported datasource type into a TODO', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: { type: 'elasticsearch', uid: 'es' }, query: 'status:500' },
            { datasources: DATASOURCES },
        );
        expect(result.sql).toBeNull();
        expect(result.todo).toContain('elasticsearch');
        expect(codes(result.warnings)).toContain('datasource-unsupported');
    });

    it('translates every target of a mixed-datasource panel', () => {
        const result = q.translateGrafanaPanelQueries(
            {
                type: 'timeseries',
                datasource: { type: 'datasource', uid: '-- Mixed --' },
                targets: [
                    { refId: 'A', datasource: PROM, expr: 'sum(up)' },
                    { refId: 'B', datasource: { type: 'loki', uid: 'GA4WkvzSz' }, expr: 'sum(rate({app="api"}[5m]))' },
                ],
            },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        expect(calls(result.sql, 'promql')).toHaveLength(1);
        expect(calls(result.sql, 'logql_metric')).toHaveLength(1);
    });
});
