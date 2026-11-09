/* eslint-disable */
// @ts-nocheck
// imp-query-loki: a Grafana Loki target becomes logql() when it selects log lines and
// logql_metric() when it is a metric query (count_over_time, rate, sum by, ...).
import {
    DATASOURCES,
    LOKI,
    calls,
    isTimeRangeAware,
    loadGrafanaQuery,
    onlyCall,
    RESERVED,
} from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

describe('Loki targets', () => {
    it('turns a log query into logql() with a limit and a direction', () => {
        const expr = '{namespace="envoy-gateway-system"} | json | level="error"';
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: LOKI, expr, queryType: 'range' },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        expect(isTimeRangeAware(result.sql)).toBe(true);
        expect(calls(result.sql, 'logql_metric')).toHaveLength(0);
        const call = onlyCall(result.sql, 'logql');
        expect(call.args[0]).toBe(expr);
        expect(call.args[1]).toBe(RESERVED.__from);
        expect(call.args[2]).toBe(RESERVED.__to);
        expect(Number(call.args[3])).toBeGreaterThan(0);
        expect(['backward', 'forward']).toContain(call.args[4]);
        expect(call.args[5]).toBe('loki-production');
    });

    it('keeps a panel maxLines as the log limit', () => {
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: LOKI, expr: '{job="api"}', maxLines: 250 },
            { datasources: DATASOURCES },
        );
        expect(Number(onlyCall(result.sql, 'logql').args[3])).toBe(250);
    });

    it('turns a metric query into logql_metric() with the interval as step', () => {
        const expr =
            'sum by (client_name) (count_over_time({job="auth0-logs", type="seccft"} [24h]))';
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: LOKI, expr, queryType: 'range' },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        expect(calls(result.sql, 'logql')).toHaveLength(0);
        const call = onlyCall(result.sql, 'logql_metric');
        expect(call.args.slice(0, 4)).toEqual([
            expr,
            RESERVED.__from,
            RESERVED.__to,
            RESERVED.__interval,
        ]);
    });

    it('treats rate() and other range aggregations as metric queries', () => {
        for (const expr of [
            'rate({app="fills"} |= "timeout" [5m])',
            'bytes_over_time({app="fills"}[1m])',
            'topk(5, sum by (route) (rate({app="api"}[5m])))',
        ]) {
            const result = q.translateGrafanaTarget(
                { refId: 'A', datasource: LOKI, expr },
                { datasources: DATASOURCES },
            );
            expect(onlyCall(result.sql, 'logql_metric').args[0]).toBe(expr);
        }
    });

    it('turns an instant metric query into one value at __to', () => {
        const expr = 'sum(count_over_time({job="api"}[1h]))';
        const result = q.translateGrafanaTarget(
            { refId: 'A', datasource: LOKI, expr, queryType: 'instant' },
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        expect(onlyCall(result.sql, 'logql_metric').args[0]).toBe(expr);
        expect(result.sql).toContain('${ld.parameters.__to}');
    });
});
