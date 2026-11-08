import { buildTelemetrySql } from './telemetrySql';

describe('buildTelemetrySql', () => {
    describe('promql', () => {
        it('passes the reserved time parameters as start, end and step', () => {
            expect(buildTelemetrySql({ kind: 'promql', query: 'up' })).toBe(
                "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
            );
        });

        it('keeps double quotes and braces in the query as they are', () => {
            expect(
                buildTelemetrySql({
                    kind: 'promql',
                    query: 'rate(http_requests_total{job="api"}[5m])',
                }),
            ).toBe(
                'SELECT * FROM promql(\'rate(http_requests_total{job="api"}[5m])\', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})',
            );
        });

        it('appends a named source as a string literal', () => {
            expect(
                buildTelemetrySql({
                    kind: 'promql',
                    query: 'up',
                    source: 'prometheus-production',
                }),
            ).toBe(
                "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}, 'prometheus-production')",
            );
        });

        it('leaves out an empty source so the engine default applies', () => {
            expect(
                buildTelemetrySql({ kind: 'promql', query: 'up', source: '' }),
            ).toBe(
                "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
            );
        });

        it('doubles single quotes in the query and the source', () => {
            expect(
                buildTelemetrySql({
                    kind: 'promql',
                    query: "label_replace(up, 'x', 'y', '', '')",
                    source: "o'brien",
                }),
            ).toBe(
                "SELECT * FROM promql('label_replace(up, ''x'', ''y'', '''', '''')', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval}, 'o''brien')",
            );
        });
    });
});
