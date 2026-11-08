// Investigate asks for an Audited Query description before running SQL that
// touches the Platform Database (CONTRACTS §2, §6). The platform_* table
// functions are the ones the engine audits on SQL alone; Restricted Telemetry
// depends on source configuration the client does not see, so it is caught by
// the engine error instead.

const PLATFORM_FUNCTION =
    /(?<![\w$])"?platform_(?:query|explain|tables|columns)"?\s*\(/i;

/** Remove string literals and comments so their text cannot look like a call. */
const stripLiteralsAndComments = (sql: string): string =>
    sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');

/**
 * True when the SQL calls platform_query, platform_explain, platform_tables or
 * platform_columns, so the engine treats it as an Audited Query.
 * Function names match case-insensitively; text inside string literals and
 * comments is ignored, and a column such as `platform_name` does not count.
 */
export const isAuditedSql = (sql: string): boolean =>
    PLATFORM_FUNCTION.test(stripLiteralsAndComments(sql));

/** Quotes a value as a SQL string literal, doubling single quotes. */
const sqlStringLiteral = (value: string): string =>
    `'${value.replace(/'/g, "''")}'`;

/**
 * Wraps a Platform Database statement in `platform_query(sql)` (CONTRACTS §1.1). The statement
 * is passed as one SQL string literal with single quotes doubled; it takes no source argument.
 */
export const buildPlatformQuerySql = (statement: string): string =>
    `SELECT * FROM platform_query(${sqlStringLiteral(statement)})`;

/**
 * Lists the Platform Database tables the schema browser shows (CONTRACTS §1.1,
 * `platform_tables()`). The engine audits it like any platform_* call.
 */
export const PLATFORM_TABLES_SQL =
    'SELECT table_schema, table_name FROM platform_tables()';

/**
 * Lists the columns of one Platform Database table (CONTRACTS §1.1,
 * `platform_columns(table_schema, table_name)`). Both names are passed as SQL
 * string literals with single quotes doubled.
 */
export const buildPlatformColumnsSql = (
    tableSchema: string,
    tableName: string,
): string =>
    `SELECT column_name, data_type, is_nullable FROM platform_columns(${sqlStringLiteral(
        tableSchema,
    )}, ${sqlStringLiteral(tableName)})`;

const AUDIT_DESCRIPTION_REQUIRED = /audited query requires a description/i;

/**
 * True when an engine error is the one an Audited Query without a description
 * fails with (SQLSTATE 42501, "audited query requires a description").
 */
export const isAuditDescriptionRequiredError = (message: string): boolean =>
    AUDIT_DESCRIPTION_REQUIRED.test(message);
