/* eslint-disable */
// @ts-nocheck
// imp-query-legend-format: a Prometheus or Loki metric target's legendFormat becomes the
// series name in SQL, using the CONTRACTS §1.1 label() helper over the labels column.
import {
    DATASOURCES,
    PROM,
    codeOutsideLiterals,
    literals,
    loadGrafanaQuery,
    onlyCall,
} from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

describe('legendFormat', () => {
    it('names each series from its labels', () => {
        const result = q.translateGrafanaTarget(
            {
                refId: 'A',
                datasource: PROM,
                expr: 'sum by (status) (rate(http_requests_total[5m]))',
                legendFormat: '{{status}} responses',
            },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        onlyCall(result.sql, 'promql');
        const code = codeOutsideLiterals(result.sql);
        expect(code).toContain('label (');
        expect(code).toContain('series');
        expect(literals(result.sql)).toEqual(
            expect.arrayContaining(['status', ' responses']),
        );
    });

    it('keeps the engine series name for __auto and an empty legend', () => {
        for (const legendFormat of ['__auto', '', undefined]) {
            const result = q.translateGrafanaTarget(
                { refId: 'A', datasource: PROM, expr: 'up', legendFormat },
                { datasources: DATASOURCES },
            );
            expect(result.todo).toBeNull();
            expect(codeOutsideLiterals(result.sql)).not.toContain('label (');
        }
    });
});
