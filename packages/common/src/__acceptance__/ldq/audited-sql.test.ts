// ldq-investigate-audited-sql-detection: SQL that touches the Platform Database needs an
// Audited Query description up front.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

describe('isAuditedSql', () => {
    it('is true for every platform_* table function', () => {
        expect(
            common.isAuditedSql(
                "SELECT * FROM platform_query('select id from orders limit 5')",
            ),
        ).toBe(true);
        expect(
            common.isAuditedSql(
                "select plan from PLATFORM_EXPLAIN('select 1')",
            ),
        ).toBe(true);
        expect(common.isAuditedSql('SELECT * FROM platform_tables()')).toBe(
            true,
        );
        expect(
            common.isAuditedSql(
                "SELECT * FROM platform_columns ('public', 'orders')",
            ),
        ).toBe(true);
    });

    it('is false for ordinary telemetry and Ops Marts', () => {
        expect(
            common.isAuditedSql(
                "SELECT * FROM promql('up', ${ld.parameters.__from}, ${ld.parameters.__to}, ${ld.parameters.__interval})",
            ),
        ).toBe(false);
        expect(
            common.isAuditedSql('SELECT * FROM ops_marts.ops.fills_hourly'),
        ).toBe(false);
        expect(
            common.isAuditedSql('SELECT platform_name FROM ops_marts.ops.x'),
        ).toBe(false);
    });

    it('recognises the engine error that asks for a description', () => {
        expect(
            common.isAuditDescriptionRequiredError(
                'ERROR: audited query requires a description (SQLSTATE 42501)',
            ),
        ).toBe(true);
        expect(
            common.isAuditDescriptionRequiredError(
                'missing claim telemetry_restricted',
            ),
        ).toBe(false);
    });
});
