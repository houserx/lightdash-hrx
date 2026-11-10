/**
 * Port of the portal's past-query examples for Ask
 * (`refs/db-query-portal@aea73de/api/src/services/example-queries.service.ts`).
 *
 * Teammates' successful, non-empty read queries are the best evidence of how this schema is really joined and
 * filtered. They are scrubbed of literals (and dropped if still sensitive) before the model ever sees them, and never
 * include result data.
 *
 * The filters, scrubbing, ranking, limits and text are the portal's. What changed in the port:
 * - Past executions come from the engine audit browser (`GET /v1/audit`, CONTRACTS §1.3) through the injected
 *   `AuditBrowser`, which sends the caller's identity token, instead of the portal's DynamoDB `listExecutions`.
 *   §1.3 has only `ticket`, `user`, `month` and `cursor` filters, so the portal's `from`/`to`/`pageSize`/
 *   `excludeScheduler` are not sent: pages are followed by `nextCursor` (still at most 5), records whose `createdAt`
 *   is older than the 90-day lookback are skipped, and scheduler runs are `action: 'assertion'`, which `usable`
 *   already drops.
 * - The module-level cache becomes per-service state: `createExampleQueries({ audit, ... })` returns
 *   `findExampleQueries` and `resetExamplesCache`. The audit browser acts as one caller, so build one service per
 *   caller; cached examples must never be served to someone the engine did not let read them.
 * - Sentry capture becomes the optional `onError(err, where)` callback. The clock is the injected `now`.
 * - The engine audits a Platform Database read as the statement it ran, `SELECT * FROM platform_query('<sql>')`
 *   (CONTRACTS §1.1), where the portal recorded `<sql>` itself. Such a record is unwrapped to `<sql>` before the
 *   portal's filters and scrubbing, so its tables and literals are seen; any other platform_* call (catalog,
 *   explain) is not an example.
 * - Each example also shows the purpose its newest run was audited with (`description`), unless that text looks
 *   sensitive, so the model can tell what the query was for.
 */
import type { AuditBrowser, Execution } from '../engine/audit.js';
import { looksSensitive, scrubSql } from './ask-memory.service.js';

const LOOKBACK_DAYS = 90;
const MAX_PAGES = 5;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SQL_CHARS = 1200;
const MAX_RAW_SQL_CHARS = 6000;
const DEFAULT_LIMIT = 4;
const MAX_PURPOSE_CHARS = 200;

interface Example {
    sql: string;
    /** The audit description of the newest run whose description does not look sensitive. */
    purpose?: string;
    tables: string[];
    uses: number;
    users: Set<string>;
}

export interface ExampleQueriesOptions {
    /** The engine audit browser, acting as the caller. */
    audit: AuditBrowser;
    /** Epoch ms. Default `Date.now`. */
    now?: () => number;
    /** Called when past executions cannot be read (the portal's Sentry capture). */
    onError?: (err: unknown, where: string) => void;
}

export interface ExampleQueries {
    /** Past queries (literals removed) most relevant to the keywords, formatted for the model. */
    findExampleQueries(database: string, keywords: string, limit?: number): Promise<string>;
    /** Drop cached examples. */
    resetExamplesCache(): void;
}

function tablesIn(sql: string): string[] {
    const out = new Set<string>();
    for (const m of sql.matchAll(/\b(?:from|join)\s+("?[\w]+"?(?:\."?[\w]+"?)?)/gi)) {
        out.add((m[1] ?? '').replace(/"/g, '').toLowerCase());
    }
    return [...out];
}

const keywordsOf = (text: string): string[] => [
    ...new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length >= 3)
            .map((t) => t.replace(/s$/, '')),
    ),
];

/** `SELECT * FROM platform_query('<sql>')`, the statement the engine audits for a Platform Database read. */
const PLATFORM_QUERY_CALL = /^\s*select\s+\*\s+from\s+platform_query\s*\(\s*'((?:[^']|'')*)'\s*\)\s*;?\s*$/i;

/** A call of any other engine platform_* function: the catalog or explain, never an example. */
const OTHER_PLATFORM_CALL = /^\s*select\s+\*\s+from\s+platform_\w+\s*\(/i;

/** The statement a teammate wrote: the audited SQL, unwrapped from `platform_query('...')`; undefined for no SQL. */
function statementOf(sql: unknown): string | undefined {
    if (typeof sql !== 'string') return undefined;
    const call = PLATFORM_QUERY_CALL.exec(sql);
    if (call) return (call[1] ?? '').replace(/''/g, "'");
    return OTHER_PLATFORM_CALL.test(sql) ? undefined : sql;
}

function usable(e: Execution, database: string, sql: string | undefined): sql is string {
    return (
        e.action === 'query' &&
        e.status === 'success' &&
        e.mode === 'read' &&
        e.database === database &&
        (e.rowCount === null || e.rowCount > 0) &&
        typeof sql === 'string' &&
        sql.length <= MAX_RAW_SQL_CHARS &&
        /^\s*(?:--[^\n]*\n\s*)*(select|with)\b/i.test(sql)
    );
}

/** The record's description, when it is text that is safe to show the model. */
function purposeOf(e: Execution): string | undefined {
    const text = typeof e.description === 'string' ? e.description.replace(/\s+/g, ' ').trim() : '';
    return text && !looksSensitive(text) ? text.slice(0, MAX_PURPOSE_CHARS) : undefined;
}

/** True when the record says it was created before `fromMs`. A record without a readable `createdAt` is kept. */
function olderThan(e: Execution, fromMs: number): boolean {
    const at = typeof e.createdAt === 'string' ? Date.parse(e.createdAt) : Number.NaN;
    return Number.isFinite(at) && at < fromMs;
}

export function createExampleQueries({ audit, now = Date.now, onError }: ExampleQueriesOptions): ExampleQueries {
    const cache = new Map<string, { examples: Example[]; expiresAt: number }>();

    async function loadExamples(database: string): Promise<Example[]> {
        const cached = cache.get(database);
        if (cached && cached.expiresAt > now()) return cached.examples;

        const byShape = new Map<string, Example>();
        const fromMs = now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const result = await audit.list(cursor === undefined ? {} : { cursor });
            for (const e of result.items) {
                const statement = statementOf(e.sql);
                if (!usable(e, database, statement) || olderThan(e, fromMs)) continue;
                const sql = scrubSql(statement);
                if (!sql || sql.length > MAX_SQL_CHARS || looksSensitive(sql)) continue;
                const key = sql.toLowerCase();
                const existing = byShape.get(key);
                if (existing) {
                    existing.uses += 1;
                    existing.users.add(e.executedBySub);
                    existing.purpose ??= purposeOf(e);
                } else {
                    byShape.set(key, {
                        sql,
                        purpose: purposeOf(e),
                        tables: tablesIn(sql),
                        uses: 1,
                        users: new Set([e.executedBySub]),
                    });
                }
            }
            cursor = result.nextCursor ?? undefined;
            if (!cursor) break;
        }
        const examples = [...byShape.values()];
        cache.set(database, { examples, expiresAt: now() + CACHE_TTL_MS });
        return examples;
    }

    return {
        async findExampleQueries(database, keywords, limit = DEFAULT_LIMIT) {
            let examples: Example[];
            try {
                examples = await loadExamples(database);
            } catch (err) {
                onError?.(err, 'askData.examples');
                return 'Past-query examples are unavailable right now.';
            }
            const terms = keywordsOf(keywords);
            if (terms.length === 0) return 'Provide at least one keyword (3+ letters).';

            const ranked = examples
                .map((e) => {
                    const haystack = e.sql.toLowerCase();
                    const tableText = e.tables.join(' ');
                    const score = terms.reduce(
                        (sum, t) => sum + (tableText.includes(t) ? 2 : 0) + (haystack.includes(t) ? 1 : 0),
                        0,
                    );
                    return { e, score: score + Math.min(1, Math.log10(e.uses + e.users.size)) };
                })
                .filter((x) => x.score >= 2)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit);
            if (ranked.length === 0) return 'No similar past queries found.';

            return [
                'Past queries from teammates (literal values removed; verify columns with describe_tables before reusing):',
                ...ranked.map(
                    ({ e }, i) =>
                        `Example ${i + 1} — run ${e.uses}× by ${e.users.size} ${e.users.size === 1 ? 'person' : 'people'}; tables: ${e.tables.join(', ') || 'n/a'}${e.purpose ? `\nPurpose: ${e.purpose}` : ''}\n${e.sql}`,
                ),
            ].join('\n\n');
        },
        resetExamplesCache() {
            cache.clear();
        },
    };
}
