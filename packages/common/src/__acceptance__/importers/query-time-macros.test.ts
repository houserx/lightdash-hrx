/* eslint-disable */
// @ts-nocheck
// imp-query-time-macros: $__interval, $__rate_interval, $__range, $__from and $__to inside
// a query map to the CONTRACTS §2 reserved parameters ($__from/$__to in SQL: query-postgres).
import { DATASOURCES, LOKI, PROM, loadGrafanaQuery, onlyCall, RESERVED } from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

const prom = (expr: string) =>
    q.translateGrafanaTarget({ refId: 'A', datasource: PROM, expr }, { datasources: DATASOURCES });

describe('time macros', () => {
    it('maps $__interval and ${__interval} to __interval', () => {
        for (const expr of ['rate(x[$__interval])', 'rate(x[${__interval}])']) {
            const result = prom(expr);
            expect(result.todo).toBeNull();
            expect(result.sql).toContain('${ld.parameters.__interval}');
            expect(onlyCall(result.sql, 'promql').args[0]).toBe(`rate(x[${RESERVED.__interval}])`);
        }
    });

    it('maps $__rate_interval to the interval', () => {
        const result = prom('sum(rate(x[$__rate_interval]))');
        expect(result.sql).toContain('${ld.parameters.__interval}');
        expect(onlyCall(result.sql, 'promql').args[0]).toBe(`sum(rate(x[${RESERVED.__interval}]))`);
    });

    it('maps $__range to __range', () => {
        const result = prom('sum(increase(errors_total[$__range]))');
        expect(result.sql).toContain('${ld.parameters.__range}');
        expect(onlyCall(result.sql, 'promql').args[0]).toBe(`sum(increase(errors_total[${RESERVED.__range}]))`);
    });

    it('maps the macros inside LogQL too', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: LOKI, expr: 'sum(count_over_time({app="api"}[$__interval]))' },
            { datasources: DATASOURCES },
        );
        expect(onlyCall(result.sql, 'logql_metric').args[0]).toBe(
            `sum(count_over_time({app="api"}[${RESERVED.__interval}]))`,
        );
    });

    it('leaves no Grafana macro behind', () => {
        const result = prom('rate(a[$__rate_interval]) / rate(b[$__interval]) * $__range_s');
        if (result.sql) {
            expect(onlyCall(result.sql, 'promql').args[0]).not.toMatch(/\$__(interval|rate_interval|range)\b/);
        }
        // $__range_s (seconds) has no reserved parameter: it is a warning, not a silent drop.
        expect(result.warnings.map((w) => w.message).join(' ')).toContain('$__range_s');
    });
});
