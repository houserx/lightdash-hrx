/**
 * Port of the portal's schema catalog (`refs/db-query-portal@aea73de/api/src/services/schema-catalog.service.ts`),
 * the read-only schema introspection that grounds the data assistant. Only structure is read here, never row data.
 *
 * The portal read `pg_catalog` directly. Through the Federation Engine the Platform Database catalog is only
 * `platform_tables()` and `platform_columns(table_schema, table_name)` (CONTRACTS §1.1), both Audited Queries
 * (§1.2): they need `attrs.platform_read` and an audit description, and the engine only lists what the caller may
 * read. What changed in the port (PROGRESS.md "Contract assumptions" 7 and 10):
 * - Comments, row estimates, enum values, constraints, indexes and foreign keys are not available, so entries carry
 *   `comment: null`, `approxRows: null` and kind `table`; `describeTables` lists columns only, and `findJoinPath` says
 *   that no foreign-key path can be computed instead of searching one.
 * - Entries are keyed by `schema.name` (there is no oid).
 * - The catalog is per caller: `createPlatformCatalog({ engine, audit })` caches tables and each table's columns for
 *   its own lifetime (one ask), so one user's catalog is never shown to another. The portal's 10-minute module
 *   cache and `resetCatalogCache()` are gone.
 * - `searchSchema` matches relation names, plus the columns of tables already described in this catalog. The portal
 *   searched every column in one `pg_attribute` query; here that would be one audited `platform_columns()` call per
 *   table, so columns of undescribed tables are not searched.
 * - `resolveColumn` reads the column's `data_type` from `platform_columns()`; the blob and personal-data refusals
 *   are the portal's.
 * Formatting, limits, name resolution and messages are otherwise the portal's.
 */
import type { EngineClient } from '../engine/client.js';
import type { IdentityAuditInput } from '../identity/token.js';

export interface CatalogEntry {
    schema: string;
    name: string;
    kind: 'table' | 'view' | 'materialized view';
    /** Not available through the engine: always null. */
    comment: string | null;
    /** Not available through the engine: always null. */
    approxRows: number | null;
}

export interface CatalogColumn {
    column: string;
    type: string;
    nullable: boolean;
}

export type ResolvedColumn =
    | { ok: true; relation: string; column: string; type: string }
    | { ok: false; error: string };

export interface PlatformCatalog {
    loadCatalog(): Promise<CatalogEntry[]>;
    describeTables(names: string[]): Promise<string>;
    searchSchema(query: string): Promise<string>;
    findJoinPath(fromName: string, toName: string): Promise<string>;
    resolveColumn(table: string, column: string): Promise<ResolvedColumn>;
}

export interface PlatformCatalogOptions {
    /** The engine client of the caller (one identity per catalog). */
    engine: EngineClient;
    /** The audit block sent with every catalog read (Audited Queries need a description). */
    audit: IdentityAuditInput;
}

export const PLATFORM_TABLES_SQL = 'SELECT * FROM platform_tables()';
export const PLATFORM_COLUMNS_SQL = 'SELECT * FROM platform_columns($1, $2)';

const MAX_TABLES_PER_DESCRIBE = 12;
const MAX_COLUMNS_PER_TABLE = 150;
const MAX_SEARCH_TABLES = 25;
const MAX_COLUMNS_PER_SEARCH_TABLE = 8;

/** Public-schema relations are unqualified (matching how people write SQL); others carry a schema. */
export function qualifiedName(entry: Pick<CatalogEntry, 'schema' | 'name'>): string {
    return entry.schema === 'public' ? entry.name : `${entry.schema}.${entry.name}`;
}

const entryKey = (entry: Pick<CatalogEntry, 'schema' | 'name'>): string => `${entry.schema}.${entry.name}`;

function formatRowCount(n: number | null): string {
    if (n === null) return 'row count unknown';
    if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M rows`;
    if (n >= 1_000) return `~${Math.round(n / 1_000)}K rows`;
    return `~${n} rows`;
}

/**
 * One line per relation (name, kind, size, comment) for the system prompt. If the catalog is too
 * large it sheds comments first, then truncates — the model falls back to search_schema for the rest.
 */
export function formatCatalogForPrompt(entries: CatalogEntry[], charLimit: number): string {
    const line = (e: CatalogEntry, withComment: boolean): string => {
        const comment = withComment && e.comment ? ` — ${e.comment.replace(/\s+/g, ' ').slice(0, 120)}` : '';
        return `${qualifiedName(e)} [${e.kind}, ${formatRowCount(e.approxRows)}]${comment}`;
    };
    for (const withComment of [true, false]) {
        const text = entries.map((e) => line(e, withComment)).join('\n');
        if (text.length <= charLimit) return text;
    }
    const lines: string[] = [];
    let used = 0;
    for (const e of entries) {
        const l = line(e, false);
        if (used + l.length + 1 > charLimit) break;
        lines.push(l);
        used += l.length + 1;
    }
    lines.push(`… (${entries.length - lines.length} more relations not listed — use search_schema to find them)`);
    return lines.join('\n');
}

// Matches a requested name against the catalog: `schema.table` exactly, or a bare table name in any
// schema (case-insensitive, quotes ignored). Public-schema relations win ties.
function resolveEntries(
    catalog: CatalogEntry[],
    requested: string[],
): { found: CatalogEntry[]; notFound: string[] } {
    const found = new Map<string, CatalogEntry>();
    const notFound: string[] = [];
    for (const raw of requested) {
        const wanted = raw.replace(/"/g, '').trim().toLowerCase();
        if (!wanted) continue;
        const matches = catalog.filter(
            (e) =>
                `${e.schema}.${e.name}`.toLowerCase() === wanted ||
                (!wanted.includes('.') && e.name.toLowerCase() === wanted),
        );
        const best = matches.find((e) => e.schema === 'public') ?? matches[0];
        if (best) found.set(entryKey(best), best);
        else notFound.push(raw);
    }
    return { found: [...found.values()], notFound };
}

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

// Types whose values are blobs/documents, never categorical.
const UNSAMPLEABLE_TYPES = new Set(['bytea', 'json', 'jsonb', 'xml', 'tsvector']);
// Columns that identify or describe a person (or hold secrets/free text): value samples are refused.
const SENSITIVE_COLUMN =
    /(first|last|middle|full|patient|member|subscriber|guarantor)name|dob|birth|ssn|social|phone|fax|email|address|street|zip|postal|mrn|memberid|subscriberid|password|token|secret|note|memo/;

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
// `is_nullable` is bool in §1.1; information_schema's own 'YES'/'NO' is accepted too.
const nullable = (v: unknown): boolean => v === true || v === 't' || v === 'true' || v === 'YES';

export function createPlatformCatalog(opts: PlatformCatalogOptions): PlatformCatalog {
    const { engine, audit } = opts;
    let tables: Promise<CatalogEntry[]> | undefined;
    const columnCache = new Map<string, Promise<CatalogColumn[]>>();

    async function loadCatalog(): Promise<CatalogEntry[]> {
        tables ??= (async () => {
            const { rows } = await engine.query(PLATFORM_TABLES_SQL, [], { audit });
            return rows
                .map(
                    (r): CatalogEntry => ({
                        schema: text(r.table_schema),
                        name: text(r.table_name),
                        kind: 'table',
                        comment: null,
                        approxRows: null,
                    }),
                )
                .filter((e) => e.schema !== '' && e.name !== '')
                .sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
        })();
        // A failed read is not cached, so a retry can succeed.
        tables.catch(() => {
            tables = undefined;
        });
        return tables;
    }

    function loadColumns(entry: CatalogEntry): Promise<CatalogColumn[]> {
        const key = entryKey(entry);
        let cols = columnCache.get(key);
        if (!cols) {
            cols = engine.query(PLATFORM_COLUMNS_SQL, [entry.schema, entry.name], { audit }).then(({ rows }) =>
                rows.map((r) => ({
                    column: text(r.column_name),
                    type: text(r.data_type),
                    nullable: nullable(r.is_nullable),
                })),
            );
            columnCache.set(key, cols);
            cols.catch(() => columnCache.delete(key));
        }
        return cols;
    }

    return {
        loadCatalog,

        /** Columns (type, nullability) of the requested relations: what the model needs to write correct SQL. */
        async describeTables(names) {
            const catalog = await loadCatalog();
            const requested = names.slice(0, MAX_TABLES_PER_DESCRIBE);
            const { found, notFound } = resolveEntries(catalog, requested);
            const sections: string[] = [];

            const described = await Promise.all(found.map(async (entry) => ({ entry, cols: await loadColumns(entry) })));
            for (const { entry, cols } of described) {
                const header = `${qualifiedName(entry)} (${entry.kind}, ${formatRowCount(entry.approxRows)})${
                    entry.comment ? ` — ${entry.comment.replace(/\s+/g, ' ')}` : ''
                }`;
                const lines = cols
                    .slice(0, MAX_COLUMNS_PER_TABLE)
                    .map((c) => `  "${c.column}" ${c.type}${c.nullable ? '' : ' NOT NULL'}`);
                if (cols.length > MAX_COLUMNS_PER_TABLE) {
                    lines.push(`  … ${cols.length - MAX_COLUMNS_PER_TABLE} more columns not shown`);
                }
                sections.push([header, ...lines].join('\n'));
            }

            if (notFound.length > 0) {
                sections.push(
                    `Not found (or not readable): ${notFound.join(', ')}. Use search_schema to locate the right name.`,
                );
            }
            if (names.length > MAX_TABLES_PER_DESCRIBE) {
                sections.push(
                    `Only the first ${MAX_TABLES_PER_DESCRIBE} tables were described; request the rest separately.`,
                );
            }
            return sections.join('\n\n') || 'No tables requested.';
        },

        /**
         * Relations whose name matches any keyword, and matching columns of the relations already described
         * (case-insensitive; underscores and camelCase are folded together).
         */
        async searchSchema(query) {
            const terms = [
                ...new Set(
                    query
                        .toLowerCase()
                        .split(/[^a-z0-9]+/)
                        .filter((t) => t.length >= 2),
                ),
            ].slice(0, 6);
            if (terms.length === 0) return 'Provide at least one keyword (2+ letters).';

            const catalog = await loadCatalog();
            const fold = (s: string): string => s.toLowerCase().replace(/_/g, '');
            const tableHits = new Map<string, Set<string>>();
            for (const e of catalog) {
                const haystack = fold(`${qualifiedName(e)} ${e.comment ?? ''}`);
                if (terms.some((t) => haystack.includes(t))) tableHits.set(entryKey(e), new Set());
            }
            for (const e of catalog) {
                const cached = columnCache.get(entryKey(e));
                if (!cached) continue;
                const cols = await cached.catch(() => [] as CatalogColumn[]);
                for (const c of cols) {
                    if (!terms.some((t) => fold(c.column).includes(t))) continue;
                    const set = tableHits.get(entryKey(e)) ?? new Set<string>();
                    set.add(`"${c.column}" ${c.type}`);
                    tableHits.set(entryKey(e), set);
                }
            }

            const byKey = new Map(catalog.map((e) => [entryKey(e), e]));
            const ranked = [...tableHits.entries()]
                .map(([key, cols]) => ({ entry: byKey.get(key), cols: [...cols] }))
                .filter((x): x is { entry: CatalogEntry; cols: string[] } => !!x.entry)
                .sort((a, b) => b.cols.length - a.cols.length)
                .slice(0, MAX_SEARCH_TABLES);
            if (ranked.length === 0) return `No tables or columns matched: ${terms.join(', ')}.`;

            return ranked
                .map(({ entry, cols }) => {
                    const shown = cols.slice(0, MAX_COLUMNS_PER_SEARCH_TABLE).join(', ');
                    const more =
                        cols.length > MAX_COLUMNS_PER_SEARCH_TABLE
                            ? `, +${cols.length - MAX_COLUMNS_PER_SEARCH_TABLE} more`
                            : '';
                    return `${qualifiedName(entry)} [${entry.kind}]${cols.length ? ` matching columns: ${shown}${more}` : ' (matched by name/comment)'}`;
                })
                .join('\n');
        },

        /** Foreign keys are not visible through the engine, so this resolves both names and points at describe_tables. */
        async findJoinPath(fromName, toName) {
            const catalog = await loadCatalog();
            const from = resolveEntries(catalog, [fromName]);
            const to = resolveEntries(catalog, [toName]);
            const missing = [...from.notFound, ...to.notFound];
            const a = from.found[0];
            const b = to.found[0];
            if (!a || !b) {
                return `Not found (or not readable): ${missing.join(', ')}. Use search_schema to locate the right name.`;
            }
            if (entryKey(a) === entryKey(b)) return `${qualifiedName(a)} is the same table; no join is needed.`;
            return `Foreign keys are not visible through the Federation Engine, so no join path between ${qualifiedName(a)} and ${qualifiedName(b)} can be computed. They may still join by naming convention (e.g. a "<table>Id" column) — compare their columns with describe_tables.`;
        },

        /**
         * Validates `table.column` against the catalog and returns safely quoted identifiers for building a
         * value-sampling query. Refuses blob types and columns that look like personal data.
         */
        async resolveColumn(table, column) {
            const catalog = await loadCatalog();
            const { found, notFound } = resolveEntries(catalog, [table]);
            const entry = found[0];
            if (!entry) {
                return {
                    ok: false,
                    error: `Not found (or not readable): ${notFound.join(', ') || table}. Use search_schema to locate the right name.`,
                };
            }
            const wanted = column.replace(/"/g, '').trim();
            const rows = (await loadColumns(entry)).filter((c) => c.column.toLowerCase() === wanted.toLowerCase());
            const col = rows.find((r) => r.column === wanted) ?? rows[0];
            if (!col) {
                return {
                    ok: false,
                    error: `Column "${wanted}" not found on ${qualifiedName(entry)}. Use describe_tables for its columns.`,
                };
            }
            if (UNSAMPLEABLE_TYPES.has(col.type.toLowerCase())) {
                return { ok: false, error: `Values of ${col.type} columns can't be sampled.` };
            }
            if (SENSITIVE_COLUMN.test(col.column.toLowerCase().replace(/_/g, ''))) {
                return {
                    ok: false,
                    error: `"${col.column}" looks like it holds personal data, so its values are not sampled. Use counts or aggregates instead.`,
                };
            }
            return {
                ok: true,
                relation: `${quoteIdent(entry.schema)}.${quoteIdent(entry.name)}`,
                column: quoteIdent(col.column),
                type: col.type,
            };
        },
    };
}
