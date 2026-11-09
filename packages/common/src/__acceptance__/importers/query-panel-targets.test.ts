/* eslint-disable */
// @ts-nocheck
// imp-query-panel-targets: a panel with several visible targets becomes one SQL query that
// returns every target's series (one result set per chart), hidden targets are left out, and
// a panel whose targets partly fail keeps what translates and warns about the rest.
import { DATASOURCES, PROM, calls, codeOutsideLiterals, loadGrafanaQuery } from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

describe('panel targets', () => {
    it('combines visible targets into one result', () => {
        const result = q.translateGrafanaPanelQueries(
            {
                type: 'timeseries',
                targets: [
                    { refId: 'A', datasource: PROM, expr: 'sum(rate(a[5m]))', legendFormat: 'a' },
                    { refId: 'B', datasource: PROM, expr: 'sum(rate(b[5m]))', legendFormat: 'b' },
                    { refId: 'C', datasource: PROM, expr: 'sum(rate(c[5m]))', hide: true },
                ],
            },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        const queries = calls(result.sql, 'promql').map((c) => c.args[0]).sort();
        expect(queries).toEqual(['sum(rate(a[5m]))', 'sum(rate(b[5m]))']);
        expect(codeOutsideLiterals(result.sql)).toContain('union all');
    });

    it('keeps the targets that translate and warns about the others', () => {
        const result = q.translateGrafanaPanelQueries(
            {
                type: 'timeseries',
                targets: [
                    { refId: 'A', datasource: PROM, expr: 'sum(up)' },
                    { refId: 'B', datasource: { type: 'elasticsearch', uid: 'es' }, query: '*' },
                ],
            },
            { datasources: DATASOURCES },
        );
        expect(calls(result.sql, 'promql')).toHaveLength(1);
        expect(result.warnings.map((w) => w.code)).toContain('datasource-unsupported');
    });

    it('is a TODO when nothing translates', () => {
        const result = q.translateGrafanaPanelQueries(
            { type: 'timeseries', targets: [{ refId: 'A', datasource: { type: 'influxdb', uid: 'i' }, query: 'x' }] },
            { datasources: DATASOURCES },
        );
        expect(result.sql).toBeNull();
        expect(result.todo).toContain('influxdb');
    });
});
