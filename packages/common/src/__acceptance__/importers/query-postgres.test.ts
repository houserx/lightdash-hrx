/* eslint-disable */
// @ts-nocheck
// imp-query-postgres: a Grafana Postgres target (rawSql) becomes platform_query('<sql>'),
// with Grafana's SQL macros ($__timeFilter, $__timeFrom, $__timeTo, $__timeGroup, ...)
// rewritten over the reserved time parameters.
import { DATASOURCES, PG, isTimeRangeAware, loadGrafanaQuery, onlyCall, RESERVED } from './support';

let q: any;
beforeAll(async () => {
    q = await loadGrafanaQuery();
});

const pgTarget = (rawSql: string, extra = {}) => ({
    refId: 'A',
    datasource: PG,
    editorMode: 'code',
    format: 'time_series',
    rawQuery: true,
    rawSql,
    ...extra,
});

describe('Postgres targets', () => {
    it('wraps the SQL in platform_query()', () => {
        const rawSql = 'SELECT jobname, count(*) AS runs FROM cron.job GROUP BY 1';
        const result = q.translateGrafanaTarget(pgTarget(rawSql, { format: 'table' }), {
            datasources: DATASOURCES,
        });
        expect(result.todo).toBeNull();
        expect(onlyCall(result.sql, 'platform_query').args[0]).toBe(rawSql);
    });

    it('rewrites $__timeFilter(column) to a range over __from and __to', () => {
        const result = q.translateGrafanaTarget(
            pgTarget(
                'SELECT start_time AS time, 1 AS runs FROM cron.job_run_details WHERE $__timeFilter(start_time) ORDER BY 1',
            ),
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        expect(isTimeRangeAware(result.sql)).toBe(true);
        const inner = onlyCall(result.sql, 'platform_query').args[0];
        expect(inner).not.toContain('$__');
        expect(inner).toContain('start_time');
        expect(inner).toContain(`'${RESERVED.__from}'`);
        expect(inner).toContain(`'${RESERVED.__to}'`);
        expect(inner.startsWith('SELECT start_time AS time')).toBe(true);
    });

    it('rewrites $__timeFrom(), $__timeTo(), $__from and $__to', () => {
        const result = q.translateGrafanaTarget(
            pgTarget(
                'SELECT count(*) FROM cron.job_run_details WHERE start_time BETWEEN $__timeFrom() AND $__timeTo() AND end_time < $__to AND end_time > $__from',
            ),
            { datasources: DATASOURCES },
        );
        const inner = onlyCall(result.sql, 'platform_query').args[0];
        expect(inner).not.toContain('$__');
        expect(inner.split(`'${RESERVED.__from}'`).length - 1).toBe(2);
        expect(inner.split(`'${RESERVED.__to}'`).length - 1).toBe(2);
    });

    it('rewrites $__timeGroup over the dashboard interval', () => {
        const result = q.translateGrafanaTarget(
            pgTarget(
                'SELECT $__timeGroupAlias(start_time, $__interval), count(*) FROM cron.job_run_details WHERE $__timeFilter(start_time) GROUP BY 1',
            ),
            { datasources: DATASOURCES },
        );
        expect(result.todo).toBeNull();
        expect(result.sql).toContain('${ld.parameters.__interval}');
        const inner = onlyCall(result.sql, 'platform_query').args[0];
        expect(inner).not.toContain('$__');
        expect(inner).toContain('start_time');
    });

    it('turns an unknown macro into a warning, not broken SQL', () => {
        const result = q.translateGrafanaTarget(
            pgTarget('SELECT $__unixEpochGroupAlias(ts, 5m), 1 FROM t'),
            { datasources: DATASOURCES },
        );
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings.map((w) => w.message).join(' ')).toContain('$__unixEpochGroupAlias');
        if (result.sql !== null) {
            expect(onlyCall(result.sql, 'platform_query').args[0]).toBeDefined();
        } else {
            expect(typeof result.todo).toBe('string');
        }
    });
});
