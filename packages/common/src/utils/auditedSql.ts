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

const AUDIT_DESCRIPTION_REQUIRED = /audited query requires a description/i;

/**
 * True when an engine error is the one an Audited Query without a description
 * fails with (SQLSTATE 42501, "audited query requires a description").
 */
export const isAuditDescriptionRequiredError = (message: string): boolean =>
    AUDIT_DESCRIPTION_REQUIRED.test(message);
