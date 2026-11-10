// ldq-time-cache-key-buckets: reserved time parameters resolve before compile and cache-key
// computation, so the same relative range inside one refresh bucket gives the same cache key
// and the next bucket gives a different one (CONTRACTS §2).
import { PostgresSqlBuilder } from '@lightdash/warehouses';
import { QueryHistoryModel } from '../../models/QueryHistoryModel/QueryHistoryModel';
import { safeReplaceParametersWithSqlBuilder } from '../../utils/QueryBuilder/parameters';
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('@lightdash/common');
}, 120_000);

const projectUuid = '7a8b9c0d-0000-4000-8000-0000000000bb';
const sql =
    "SELECT * FROM promql('sum(rate(http_requests_total[5m]))', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})";

const cacheKeyAt = (
    iso: string,
    refreshInterval: string | null,
    from = 'now-6h',
) => {
    const values = common.resolveReservedParameterValues({
        dateZoom: undefined,
        timeRange: { from, to: 'now' },
        refreshInterval,
        now: new Date(iso),
    });
    const { replacedSql, missingReferences } =
        safeReplaceParametersWithSqlBuilder(sql, values, new PostgresSqlBuilder());
    expect([...missingReferences]).toEqual([]);
    return {
        replacedSql,
        key: QueryHistoryModel.getCacheKey(projectUuid, {
            sql: replacedSql,
            userUuid: null,
        }),
    };
};

describe('cache keys over relative ranges', () => {
    it('compiles absolute timestamps into the SQL', () => {
        const { replacedSql } = cacheKeyAt('2026-11-08T10:37:43.512Z', '1m');
        expect(replacedSql).toBe(
            "SELECT * FROM promql('sum(rate(http_requests_total[5m]))', '2026-11-08T04:37:00.000Z', '2026-11-08T10:37:00.000Z', '30s')",
        );
    });

    it('gives the same key within one refresh bucket', () => {
        expect(cacheKeyAt('2026-11-08T10:37:00.000Z', '1m').key).toBe(
            cacheKeyAt('2026-11-08T10:37:59.999Z', '1m').key,
        );
        expect(cacheKeyAt('2026-11-08T10:37:40.000Z', null).key).toBe(
            cacheKeyAt('2026-11-08T10:37:49.999Z', null).key,
        );
    });

    it('gives a different key in the next bucket', () => {
        expect(cacheKeyAt('2026-11-08T10:37:59.999Z', '1m').key).not.toBe(
            cacheKeyAt('2026-11-08T10:38:00.000Z', '1m').key,
        );
        expect(cacheKeyAt('2026-11-08T10:37:49.999Z', null).key).not.toBe(
            cacheKeyAt('2026-11-08T10:37:50.000Z', null).key,
        );
    });

    it('gives a different key for a different range', () => {
        expect(cacheKeyAt('2026-11-08T10:37:00.000Z', '1m').key).not.toBe(
            cacheKeyAt('2026-11-08T10:37:00.000Z', '1m', 'now-1h').key,
        );
    });
});
