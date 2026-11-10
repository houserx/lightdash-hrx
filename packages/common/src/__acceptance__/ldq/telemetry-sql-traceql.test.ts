// ldq-investigate-sql-traceql: TraceQL searches become traceql(...) SQL, and a trace id
// lookup becomes trace(...) SQL.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

describe('buildTelemetrySql traceql and trace', () => {
    it('emits the default limit of 20', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'traceql',
                query: '{ resource.service.name = "api" && duration > 2s }',
            }),
        ).toBe(
            "SELECT * FROM traceql('{ resource.service.name = \"api\" && duration > 2s }', ${ld.parameters.__from}, ${ld.parameters.__to}, 20)",
        );
    });

    it('honours limit and source', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'traceql',
                query: '{ status = error }',
                limit: 50,
                source: 'tempo-production',
            }),
        ).toBe(
            "SELECT * FROM traceql('{ status = error }', ${ld.parameters.__from}, ${ld.parameters.__to}, 50, 'tempo-production')",
        );
    });

    it('looks up one trace by id', () => {
        expect(
            common.buildTelemetrySql({
                kind: 'trace',
                traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            }),
        ).toBe(
            "SELECT * FROM trace('4bf92f3577b34da6a3ce929d0e0e4736')",
        );
    });
});
