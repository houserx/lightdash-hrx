import {
    buildPlatformColumnsSql,
    buildPlatformQuerySql,
    isAuditDescriptionRequiredError,
    isAuditedSql,
    PLATFORM_TABLES_SQL,
} from './auditedSql';

describe('isAuditedSql', () => {
    it('ignores platform_* text inside string literals and comments', () => {
        expect(isAuditedSql("SELECT 'platform_query(1)' AS note")).toBe(false);
        expect(isAuditedSql('-- platform_tables()\nSELECT 1')).toBe(false);
        expect(isAuditedSql('/* platform_explain(x) */ SELECT 1')).toBe(false);
    });

    it('detects a call after a literal with an escaped quote', () => {
        expect(
            isAuditedSql("SELECT 'it''s' AS a, * FROM platform_tables()"),
        ).toBe(true);
    });

    it('detects a quoted function name and ignores longer names', () => {
        expect(isAuditedSql('SELECT * FROM "platform_tables"()')).toBe(true);
        expect(isAuditedSql('SELECT my_platform_query(1)')).toBe(false);
        expect(isAuditedSql('SELECT platform_queryx(1)')).toBe(false);
    });
});

describe('isAuditDescriptionRequiredError', () => {
    it('does not treat other 42501 errors as the description error', () => {
        expect(
            isAuditDescriptionRequiredError(
                'permission denied for table orders (SQLSTATE 42501)',
            ),
        ).toBe(false);
    });
});

describe('buildPlatformQuerySql', () => {
    it('doubles single quotes and is itself an Audited Query', () => {
        const sql = buildPlatformQuerySql("select 'it''s'");
        expect(sql).toBe("SELECT * FROM platform_query('select ''it''''s''')");
        expect(isAuditedSql(sql)).toBe(true);
    });
});

describe('Platform Database schema SQL', () => {
    it('lists tables through platform_tables() as an Audited Query', () => {
        expect(PLATFORM_TABLES_SQL).toBe(
            'SELECT table_schema, table_name FROM platform_tables()',
        );
        expect(isAuditedSql(PLATFORM_TABLES_SQL)).toBe(true);
    });

    it("lists one table's columns, doubling quotes in both names", () => {
        const sql = buildPlatformColumnsSql("o'ps", "it's");
        expect(sql).toBe(
            "SELECT column_name, data_type, is_nullable FROM platform_columns('o''ps', 'it''s')",
        );
        expect(isAuditedSql(sql)).toBe(true);
    });
});
