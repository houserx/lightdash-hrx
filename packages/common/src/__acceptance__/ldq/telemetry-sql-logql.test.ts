// ldq-investigate-sql-logql: LogQL log queries and LogQL metric queries become
// logql(...) and logql_metric(...) SQL.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

describe('buildTelemetrySql logql', () => {
    it('emits the default limit and direction', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'logql',
                query: '{namespace="api"} |= "error"',
            }),
        ).toBe(
            "SELECT * FROM logql('{namespace=\"api\"} |= \"error\"', ${ld.parameters.__from}, ${ld.parameters.__to}, 1000, 'backward')",
        );
    });

    it('honours limit, direction and source', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'logql',
                query: '{app="worker"}',
                limit: 200,
                direction: 'forward',
                source: 'loki-production',
            }),
        ).toBe(
            "SELECT * FROM logql('{app=\"worker\"}', ${ld.parameters.__from}, ${ld.parameters.__to}, 200, 'forward', 'loki-production')",
        );
    });

    it('turns a metric query into logql_metric with the interval as step', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'logql_metric',
                query: 'sum(rate({app="api"} |= "error" [5m]))',
            }),
        ).toBe(
            "SELECT * FROM logql_metric('sum(rate({app=\"api\"} |= \"error\" [5m]))', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
        );
    });
});
