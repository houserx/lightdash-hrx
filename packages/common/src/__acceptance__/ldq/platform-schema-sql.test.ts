// ldq-platform-schema-sql: the schema browser reads platform_tables() and
// platform_columns(schema, table); Investigate wraps Platform Database SQL in platform_query.
import { load } from './load';

let common: any;

beforeAll(async () => {
    common = await load('../../index');
}, 120_000);

describe('Platform Database SQL helpers', () => {
    it('lists tables', () => {
        expect(common.PLATFORM_TABLES_SQL).toBe(
            'SELECT table_schema, table_name FROM platform_tables()',
        );
    });

    it('lists the columns of one table, escaping quotes', () => {
        expect(common.buildPlatformColumnsSql('public', 'orders')).toBe(
            "SELECT column_name, data_type, is_nullable FROM platform_columns('public', 'orders')",
        );
        expect(common.buildPlatformColumnsSql('public', "o'brien")).toBe(
            "SELECT column_name, data_type, is_nullable FROM platform_columns('public', 'o''brien')",
        );
    });

    it('wraps Platform Database SQL for execution', () => {
        expect(
            common.buildPlatformQuerySql(
                "select id from orders where status = 'open'",
            ),
        ).toBe(
            "SELECT * FROM platform_query('select id from orders where status = ''open''')",
        );
    });
});
