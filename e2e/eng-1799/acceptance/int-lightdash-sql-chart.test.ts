/* eslint-disable */
// @ts-nocheck
// int-lightdash-sql-chart: a saved SQL chart on the Operations Project runs through Lightdash's
// async query path (POST .../query/sql-chart, then polling GET .../query/{queryUuid}) against the
// real engine; a Dashboard Time Range given with the query resolves the reserved parameters so the
// fake Prometheus is asked for that absolute window.
import { disposeAll, durationSeconds, harness, load, runAsyncQuery, track } from './support';

afterAll(disposeAll);

describe('int-lightdash-sql-chart', () => {
    it('runs a SQL chart and a SQL Runner query with a time range', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up', instance: 'db-1' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const lightdash = track(await h.startLightdash({ engine }));
        const { buildTelemetrySql } = await load('packages/common/src/utils/telemetrySql.ts');
        const promqlSql = buildTelemetrySql({ kind: 'promql', query: 'up' });

        const savedSqlUuid = await lightdash.createSqlChart({ name: 'Synthetic up', sql: "SELECT value, series FROM promql('up', '2026-11-08T10:00:00Z', '2026-11-08T10:05:00Z', '1m')" });
        const chart = await runAsyncQuery(lightdash, 'sql-chart', { savedSqlUuid });
        expect(chart.error).toBeNull();
        expect(chart.rows).toHaveLength(6);
        expect(chart.rows[0]).toMatchObject({ value: 1, series: '{__name__="up",instance="db-1"}' });

        const from = '2026-11-08T09:00:00.000Z';
        const to = '2026-11-08T10:00:00.000Z';
        prom.requests.length = 0;
        const ranged = await runAsyncQuery(lightdash, 'sql', { sql: promqlSql, limit: 5000, timeRange: { from, to } });
        expect(ranged.error).toBeNull();
        expect(ranged.rows).toHaveLength(241);
        const call = prom.requests.find((r) => r.path === '/api/v1/query_range');
        expect(Number(call.params.start)).toBe(Date.parse(from) / 1000);
        expect(Number(call.params.end)).toBe(Date.parse(to) / 1000);
        // 1h / 1000 points rounds up to the 5s nice step, then the 15s floor.
        expect(durationSeconds(call.params.step)).toBe(15);
    });
});
