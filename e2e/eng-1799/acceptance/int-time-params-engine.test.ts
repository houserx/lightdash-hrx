/* eslint-disable */
// @ts-nocheck
// int-time-params-engine: the reserved time parameters the backend resolves for a query's time
// range (withTimeRangeParameters, then Lightdash's parameter substitution) reach the engine as the
// absolute values it expects: the fake Prometheus sees start/end rounded down to 10 s and the
// CONTRACTS §2 __interval step.
import { disposeAll, durationSeconds, federationCredentials, harness, load, track } from './support';

afterAll(disposeAll);

const NOW = new Date('2026-11-08T10:00:07.300Z');
const FROM_S = Date.parse('2026-11-08T04:00:00.000Z') / 1000;
const TO_S = Date.parse('2026-11-08T10:00:00.000Z') / 1000;

describe('int-time-params-engine', () => {
    it('an Investigate PromQL query over now-6h..now reaches Prometheus with absolute, rounded bounds', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const { buildTelemetrySql } = await load('packages/common/src/utils/telemetrySql.ts');
        const { withTimeRangeParameters } = await load('packages/backend/src/services/AsyncQueryService/queryTimeRange.ts');
        const { safeReplaceParametersWithSqlBuilder } = await load('packages/backend/src/utils/QueryBuilder/parameters.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine));

        const sql = buildTelemetrySql({ kind: 'promql', query: 'up' });
        const parameters = withTimeRangeParameters({}, { from: 'now-6h', to: 'now' }, NOW);
        expect(parameters.__from).toBe('2026-11-08T04:00:00.000Z');
        expect(parameters.__to).toBe('2026-11-08T10:00:00.000Z');
        expect(parameters.__interval).toBe('30s');
        expect(parameters.__range).toBe('6h');
        const { replacedSql, missingReferences } = safeReplaceParametersWithSqlBuilder(sql, parameters, client);
        expect(missingReferences.size).toBe(0);

        const result = await client.runQuery(replacedSql);
        expect(result.rows).toHaveLength(6 * 120 + 1);
        const call = prom.requests.find((r) => r.path === '/api/v1/query_range');
        expect(Number(call.params.start)).toBe(FROM_S);
        expect(Number(call.params.end)).toBe(TO_S);
        expect(durationSeconds(call.params.step)).toBe(30);
    });

    it('a refresh interval rounds both bounds down to it; absolute bounds are untouched', async () => {
        const { withTimeRangeParameters } = await load('packages/backend/src/services/AsyncQueryService/queryTimeRange.ts');
        const p = withTimeRangeParameters({}, { from: 'now-1h', to: 'now', refreshInterval: '5m' }, new Date('2026-11-08T10:04:59.000Z'));
        expect([p.__from, p.__to]).toEqual(['2026-11-08T09:00:00.000Z', '2026-11-08T10:00:00.000Z']);
        const abs = withTimeRangeParameters({}, { from: '2026-11-08T09:00:03.000Z', to: '2026-11-08T09:30:07.000Z' }, NOW);
        expect([abs.__from, abs.__to]).toEqual(['2026-11-08T09:00:03.000Z', '2026-11-08T09:30:07.000Z']);
    });
});
