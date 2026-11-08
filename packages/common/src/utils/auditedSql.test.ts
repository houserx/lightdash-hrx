import { isAuditDescriptionRequiredError, isAuditedSql } from './auditedSql';

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
