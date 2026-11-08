// ldq-investigate-sql-promql: a PromQL query becomes CONTRACTS §1.1 table-function SQL
// over the reserved time parameters.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

describe('buildTelemetrySql promql', () => {
    it('uses the reserved parameters for start, end and step', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'promql',
                query: 'sum(rate(http_requests_total{job="api"}[5m])) by (status)',
            }),
        ).toBe(
            'SELECT * FROM promql(\'sum(rate(http_requests_total{job="api"}[5m])) by (status)\', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})',
        );
    });

    it('appends a named source', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'promql',
                query: 'up',
                source: 'prometheus-production',
            }),
        ).toBe(
            "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}, 'prometheus-production')",
        );
    });

    it('escapes single quotes in the query', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'promql',
                query: "label_replace(up, 'x', 'y', '', '')",
            }),
        ).toBe(
            "SELECT * FROM promql('label_replace(up, ''x'', ''y'', '''', '''')', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
        );
    });
});
