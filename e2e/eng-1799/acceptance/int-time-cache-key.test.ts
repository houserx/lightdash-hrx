/* eslint-disable */
// @ts-nocheck
// int-time-cache-key: the same relative range within one refresh bucket compiles to the same SQL,
// so Lightdash computes the same results cache key and the engine asks Prometheus for the same
// window; the next bucket changes both.
import { disposeAll, federationCredentials, harness, load, PROJECT_UUID, track } from './support';

afterAll(disposeAll);

describe('int-time-cache-key', () => {
    it('one cache key per refresh bucket', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const { buildTelemetrySql } = await load('packages/common/src/utils/telemetrySql.ts');
        const { withTimeRangeParameters } = await load('packages/backend/src/services/AsyncQueryService/queryTimeRange.ts');
        const { safeReplaceParametersWithSqlBuilder } = await load('packages/backend/src/utils/QueryBuilder/parameters.ts');
        const { QueryHistoryModel } = await load('packages/backend/src/models/QueryHistoryModel/QueryHistoryModel.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine));
        const sql = buildTelemetrySql({ kind: 'promql', query: 'up' });

        const compile = (now: string, refreshInterval: string | null) =>
            safeReplaceParametersWithSqlBuilder(sql, withTimeRangeParameters({}, { from: 'now-15m', to: 'now', refreshInterval }, new Date(now)), client).replacedSql;
        const key = (compiled: string) => QueryHistoryModel.getCacheKey(PROJECT_UUID, { sql: compiled, timezone: 'UTC', userUuid: null });

        const a = compile('2026-11-08T10:00:05.000Z', '1m');
        const b = compile('2026-11-08T10:00:55.000Z', '1m');
        const c = compile('2026-11-08T10:01:01.000Z', '1m');
        expect(a).toBe(b);
        expect(key(a)).toBe(key(b));
        expect(c).not.toBe(a);
        expect(key(c)).not.toBe(key(a));

        // No refresh interval: 10 s buckets.
        expect(compile('2026-11-08T10:00:01.000Z', null)).toBe(compile('2026-11-08T10:00:09.999Z', null));
        expect(compile('2026-11-08T10:00:09.999Z', null)).not.toBe(compile('2026-11-08T10:00:10.000Z', null));

        await client.runQuery(a);
        await client.runQuery(b);
        await client.runQuery(c);
        const windows = prom.requests.filter((r) => r.path === '/api/v1/query_range').map((r) => `${Number(r.params.start)}-${Number(r.params.end)}`);
        expect(windows).toHaveLength(3);
        expect(windows[0]).toBe(windows[1]);
        expect(windows[2]).not.toBe(windows[0]);
    });
});
