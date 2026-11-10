/* eslint-disable */
// @ts-nocheck
// imp-query-expressions: Grafana server-side expressions (`__expr__` math, reduce and
// threshold) become SQL over the translated input queries.
import {
    DATASOURCES,
    EXPR,
    PROM,
    calls,
    codeOutsideLiterals,
    loadGrafanaQuery,
} from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

const promTarget = (refId: string, expr: string, hide = true) => ({
    refId,
    datasource: PROM,
    expr,
    range: true,
    hide,
});

describe('Grafana expressions', () => {
    it('evaluates math over two queries', () => {
        const result = q.translateGrafanaPanelQueries(
            {
                type: 'timeseries',
                targets: [
                    promTarget('A', 'sum(rate(http_requests_total{code=~"5.."}[5m]))'),
                    promTarget('B', 'sum(rate(http_requests_total[5m]))'),
                    { refId: 'C', datasource: EXPR, type: 'math', expression: '$A / $B * 100', hide: false },
                ],
            },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        const prom = calls(result.sql, 'promql').map((c) => c.args[0]).sort();
        expect(prom).toEqual(
            [
                'sum(rate(http_requests_total[5m]))',
                'sum(rate(http_requests_total{code=~"5.."}[5m]))',
            ].sort(),
        );
        const code = codeOutsideLiterals(result.sql);
        expect(code).toContain('/');
        expect(code).toContain('*');
        expect(code).toContain('100');
    });

    it('reduces a query to one value per series', () => {
        const result = q.translateGrafanaPanelQueries(
            {
                type: 'stat',
                targets: [
                    promTarget('A', 'sum by (pod) (kube_pod_container_status_restarts_total)'),
                    { refId: 'B', datasource: EXPR, type: 'reduce', expression: 'A', reducer: 'max' },
                ],
            },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        expect(calls(result.sql, 'promql')).toHaveLength(1);
        expect(codeOutsideLiterals(result.sql)).toMatch(/\bmax \(/);
        expect(codeOutsideLiterals(result.sql)).toMatch(/group by/);
    });

    it('maps each Grafana reducer to SQL', () => {
        for (const [reducer, sql] of [
            ['mean', /\bavg \(/],
            ['min', /\bmin \(/],
            ['sum', /\bsum \(/],
            ['count', /\bcount \(/],
        ]) {
            const result = q.translateGrafanaPanelQueries(
                {
                    type: 'stat',
                    targets: [
                        promTarget('A', 'up'),
                        { refId: 'B', datasource: EXPR, type: 'reduce', expression: 'A', reducer },
                    ],
                },
                { datasources: DATASOURCES },
            );
            expect(codeOutsideLiterals(result.sql)).toMatch(sql);
        }
    });

    it('turns a threshold into a comparison', () => {
        const result = q.translateGrafanaPanelQueries(
            {
                type: 'stat',
                targets: [
                    promTarget('A', 'sum(up)'),
                    {
                        refId: 'B',
                        datasource: EXPR,
                        type: 'threshold',
                        expression: 'A',
                        conditions: [{ evaluator: { type: 'gt', params: [5] } }],
                    },
                ],
            },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        const code = codeOutsideLiterals(result.sql);
        expect(code).toContain('>');
        expect(code).toContain('5');
    });

    it('turns an expression it cannot translate into a TODO and a warning', () => {
        for (const expression of [
            { type: 'resample', expression: 'A', window: '1m', downsampler: 'mean', upsampler: 'fillna' },
            { type: 'sql', expression: 'SELECT * FROM A' },
            { type: 'classic_conditions', conditions: [{ evaluator: { type: 'gt', params: [1] } }, { evaluator: { type: 'lt', params: [0] } }] },
        ]) {
            const result = q.translateGrafanaPanelQueries(
                {
                    type: 'timeseries',
                    targets: [
                        promTarget('A', 'up'),
                        { refId: 'B', datasource: EXPR, ...expression },
                    ],
                },
                { datasources: DATASOURCES },
            );
            expect(result.sql).toBeNull();
            expect(result.todo).toContain(expression.type);
            expect(result.warnings.map((w) => w.code)).toContain('expression-unsupported');
        }
    });
});
