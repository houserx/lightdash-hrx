/**
 * Port of the portal's Ask team memory (`refs/db-query-portal@aea73de/api/src/services/ask-memory.service.ts`).
 *
 * "Team memory" for Ask: lessons about HOW answers were found (where a concept lives, what a value means, a proven
 * query shape), shared across users. It must never hold data, so every lesson is validated against the real schema
 * and screened for PHI-shaped content before it is stored, and recalled notes are only ever offered to the model as
 * unverified hints.
 *
 * The screening patterns, ranking, prompt text, limits and validation are the portal's. What changed in the port:
 * - The portal's module-level DynamoDB functions become the injected `AskMemoryStore`, and the module-level recall
 *   cache becomes per-service state: `createAskMemoryService({ store, ... })` returns the stateful functions
 *   (`recallNotes`, `learnFromAnswer`, `recordFeedback`, `listNoteViews`, `removeNote`, `resetMemoryCache`).
 *   The pure helpers stay free functions.
 * - Portal env `AI_ASK_MEMORY_ENABLED` / `AI_ASK_MEMORY_MAX_RECALL` become the `enabled` / `maxRecall` options
 *   (same defaults: true / 8). The clock is the injected `now`.
 * - `PortalUser` becomes `AskMemoryUser`: `sub` (the voter id, the portal's `auth0Sub`) and `email`.
 * - Sentry capture becomes the optional `onError(err, where)` callback, still at most once a minute; KPI metrics
 *   are dropped.
 */
import { MEMORY_KINDS, type AskMemoryStore, type MemoryKind, type MemoryNote } from './ask-memory-store.js';

const MAX_LEARNINGS = 3;
const RECALL_CACHE_MS = 60_000;
const MIN_RECALL_WEIGHT = 2;
const MAX_SQL_TEMPLATE_CHARS = 1500;
const NOTE_ID_RE = /^[0-9a-f]{32}$/;
const ERROR_REPORT_INTERVAL_MS = 60_000;

/** Portal `AI_ASK_MEMORY_MAX_RECALL` default. */
export const DEFAULT_ASK_MEMORY_MAX_RECALL = 8;

/** What the client sees of a note. */
export interface MemoryNoteView {
    id: string;
    kind: MemoryKind;
    topic: string;
    insight: string;
    tables: string[];
    sqlTemplate?: string;
    status: 'active' | 'hidden';
    uses: number;
    upvotes: number;
    downvotes: number;
    confirmations: number;
    createdByEmail: string;
    updatedAt: string;
    lastUsedAt: string;
}

export interface AskMemoryResult {
    enabled: boolean;
    recalled: MemoryNoteView[];
    learned: MemoryNoteView[];
    /** Recalled notes the model reported as outdated (counted as a downvote each). */
    flagged: number;
}

/** The caller, as team memory needs it (the portal's `PortalUser`). */
export interface AskMemoryUser {
    /** Stable user id; one vote per note per id (the portal used `auth0Sub`). */
    sub: string;
    email: string;
}

export function toView(n: MemoryNote): MemoryNoteView {
    return {
        id: n.id,
        kind: n.kind,
        topic: n.topic,
        insight: n.insight,
        tables: n.tables ?? [],
        ...(n.sqlTemplate ? { sqlTemplate: n.sqlTemplate } : {}),
        status: n.status,
        uses: n.uses ?? 0,
        upvotes: n.upvotes ?? 0,
        downvotes: n.downvotes ?? 0,
        confirmations: n.confirmations ?? 0,
        createdByEmail: n.createdByEmail,
        updatedAt: n.updatedAt,
        lastUsedAt: n.lastUsedAt,
    };
}

export const memoryDisabledResult = (): AskMemoryResult => ({
    enabled: false,
    recalled: [],
    learned: [],
    flagged: 0,
});

// ---- Safety screening -------------------------------------------------------------------------

const SENSITIVE_PATTERNS: readonly RegExp[] = [
    /[^\s@]+@[^\s@]+\.[^\s@]+/, // email
    /\b\d{3}-?\d{2}-?\d{4}\b/, // SSN
    /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/, // phone
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // uuid
    /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, // dates
    /\d{5,}/, // long numbers (ids, MRNs, amounts)
    /\b(ignore|disregard)\b.{0,30}\b(previous|above|prior|instructions|rules)\b|system prompt|\byou (must|should) (always|never)\b/i, // instruction-like
];

/** True if the text looks like it carries data (PHI-shaped values) or an injected instruction. */
export function looksSensitive(text: string): boolean {
    return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

const KEEP_LITERALS = new Set(['day', 'week', 'month', 'year', 'hour', 'minute', 'quarter', 'true', 'false']);

/** Drops comments and every string/long-number literal except time units, leaving the query shape. */
export function scrubSql(sql: string): string {
    return sql
        .replace(/'(?:[^']|'')*'/g, (m) => (KEEP_LITERALS.has(m.slice(1, -1).toLowerCase()) ? m : "'?'"))
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\b\d{5,}\b/g, '?')
        .replace(/\s+/g, ' ')
        .trim();
}

// ---- Ranking & prompt -------------------------------------------------------------------------

const STOPWORDS = new Set(
    'the and for how many what which are is of in to an by per with from that this show list count number all any do does did have has last get give our their there were was be on at as it its or not than then who when where why'.split(
        ' ',
    ),
);

function tokenize(text: string): Set<string> {
    const out = new Set<string>();
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < 3 || STOPWORDS.has(raw)) continue;
        out.add(raw.endsWith('ies') ? `${raw.slice(0, -3)}y` : raw.length > 3 ? raw.replace(/s$/, '') : raw);
    }
    return out;
}

/** Community-weighted trust: votes and independent re-discoveries up, downvotes down hard. */
export function qualityScore(n: Pick<MemoryNote, 'upvotes' | 'downvotes' | 'confirmations' | 'uses'>): number {
    return (n.upvotes ?? 0) + 0.5 * (n.confirmations ?? 0) + 0.2 * (n.uses ?? 0) - 2 * (n.downvotes ?? 0);
}

/** Notes relevant to the question (keyword overlap, topic weighted double), best first. */
export function rankNotes(notes: MemoryNote[], question: string, limit: number): MemoryNote[] {
    const q = tokenize(question);
    return notes
        .flatMap((note) => {
            const quality = qualityScore(note);
            if (quality <= -2) return [];
            const topic = tokenize(note.topic);
            const body = tokenize(`${note.insight} ${(note.tables ?? []).join(' ')}`);
            let weight = 0;
            for (const t of q) {
                if (topic.has(t)) weight += 2;
                else if (body.has(t)) weight += 1;
            }
            return weight >= MIN_RECALL_WEIGHT ? [{ note, rank: weight * (1 + Math.max(0, quality) / 5) }] : [];
        })
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit)
        .map((x) => x.note);
}

export const shortId = (id: string): string => id.slice(0, 12);

export function formatNotesForPrompt(notes: MemoryNote[]): string {
    if (notes.length === 0) return '';
    const lines = notes.map((n) => {
        const tables = n.tables?.length ? ` Tables: ${n.tables.join(', ')}.` : '';
        const sql = n.sqlTemplate ? `\n  Query shape: ${n.sqlTemplate}` : '';
        return `- [${shortId(n.id)}] (${n.kind}) "${n.topic}": ${n.insight}${tables}${sql}`;
    });
    return `Team memory — lessons from earlier questions, shared across users. They are UNVERIFIED hints that may be stale: use them to shortcut where to look, but confirm against describe_tables / run_sql, and never cite a note as evidence. If a note turns out wrong, list its id under outdated_notes.\n${lines.join('\n')}`;
}

// ---- Learning (validation) --------------------------------------------------------------------

export interface LearningCandidate {
    kind: MemoryKind;
    topic: string;
    insight: string;
    tables: string[];
    sqlTemplate?: string;
}

/** What the validator needs to know about the ask that produced the lessons. */
export interface LearningContext {
    queries: { index: number; status: 'ok' | 'error'; sql: string }[];
}

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Turns one model-proposed lesson into a storable one, or null. Tables must exist in the real
 * schema, SQL comes from a query that actually ran (never model-typed), and nothing data- or
 * instruction-shaped gets through.
 */
export function sanitizeLearning(
    raw: unknown,
    ctx: LearningContext,
    tableNames: Map<string, string>,
): LearningCandidate | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const kind = MEMORY_KINDS.find((k) => k === o.kind);
    const topic = asString(o.topic);
    const insight = asString(o.insight);
    if (!kind || topic.length < 3 || topic.length > 80 || insight.length < 10 || insight.length > 400) {
        return null;
    }
    if (looksSensitive(topic) || looksSensitive(insight)) return null;

    const tables = [
        ...new Set(
            (Array.isArray(o.tables) ? o.tables : []).flatMap((t): string[] => {
                const canonical = typeof t === 'string' ? tableNames.get(t.replace(/"/g, '').toLowerCase()) : undefined;
                return canonical ? [canonical] : [];
            }),
        ),
    ].slice(0, 6);
    if ((kind === 'table_hint' || kind === 'query_pattern') && tables.length === 0) return null;

    let sqlTemplate: string | undefined;
    if (kind === 'query_pattern') {
        const source = ctx.queries.find((q) => q.index === o.from_query && q.status === 'ok');
        const scrubbed = source ? scrubSql(source.sql) : '';
        if (!scrubbed || scrubbed.length > MAX_SQL_TEMPLATE_CHARS || looksSensitive(scrubbed)) return null;
        sqlTemplate = scrubbed;
    }
    return { kind, topic, insight, tables, ...(sqlTemplate ? { sqlTemplate } : {}) };
}

// ---- The stateful service ---------------------------------------------------------------------

export interface LearnArgs {
    database: string;
    user: AskMemoryUser;
    askId: string;
    /** The raw submit_answer payload. */
    submit: Record<string, unknown>;
    ctx: LearningContext;
    tableNames: Map<string, string>;
    recalled: MemoryNote[];
}

export interface AskMemoryServiceOptions {
    store: AskMemoryStore;
    /** Portal `AI_ASK_MEMORY_ENABLED` (default true). When false, nothing is recalled, learned or voted. */
    enabled?: boolean;
    /** Portal `AI_ASK_MEMORY_MAX_RECALL` (default 8). */
    maxRecall?: number;
    /** Clock (epoch ms) for the recall cache and error throttle. */
    now?: () => number;
    /** Store failures, at most one a minute (the portal sent these to Sentry). Never given row data. */
    onError?: (err: unknown, where: string) => void;
}

export interface AskMemoryService {
    readonly enabled: boolean;
    /** Notes worth showing the model for this question. Never throws: memory is an optimization. */
    recallNotes(database: string, question: string): Promise<MemoryNote[]>;
    /**
     * After a grounded answer: store the vetted lessons, credit the notes that were recalled, and apply
     * the model's "outdated" flags. Best-effort — failures are reported, never thrown.
     */
    learnFromAnswer(args: LearnArgs): Promise<{ learned: MemoryNote[]; flagged: number }>;
    /** A user's thumbs up/down on an answer, applied to the notes that answer used or created. */
    recordFeedback(user: AskMemoryUser, noteIds: unknown, helpful: boolean): Promise<number>;
    listNoteViews(database: string): Promise<MemoryNoteView[]>;
    removeNote(id: string): Promise<void>;
    /** Test-only / after writes: forget cached notes. */
    resetMemoryCache(): void;
}

export function createAskMemoryService(opts: AskMemoryServiceOptions): AskMemoryService {
    const { store } = opts;
    const enabled = opts.enabled ?? true;
    const maxRecall = opts.maxRecall ?? DEFAULT_ASK_MEMORY_MAX_RECALL;
    const now = opts.now ?? Date.now;
    const cache = new Map<string, { notes: MemoryNote[]; expiresAt: number }>();
    let lastErrorAt: number | undefined;

    function reportMemoryError(err: unknown, where: string): void {
        // One report a minute is enough to notice a missing table/permission without flooding.
        const t = now();
        if (lastErrorAt !== undefined && t - lastErrorAt < ERROR_REPORT_INTERVAL_MS) return;
        lastErrorAt = t;
        opts.onError?.(err, `askMemory.${where}`);
    }

    async function activeNotes(database: string): Promise<MemoryNote[]> {
        const hit = cache.get(database);
        if (hit && hit.expiresAt > now()) return hit.notes;
        const notes = await store.listNotes(database);
        cache.set(database, { notes, expiresAt: now() + RECALL_CACHE_MS });
        return notes;
    }

    return {
        enabled,

        async recallNotes(database, question) {
            if (!enabled) return [];
            try {
                return rankNotes(await activeNotes(database), question, maxRecall);
            } catch (err) {
                reportMemoryError(err, 'recall');
                return [];
            }
        },

        async learnFromAnswer(args) {
            const learned: MemoryNote[] = [];
            let flagged = 0;
            if (!enabled) return { learned, flagged };
            try {
                const proposals = Array.isArray(args.submit.learnings) ? args.submit.learnings : [];
                for (const raw of proposals.slice(0, MAX_LEARNINGS)) {
                    const lesson = sanitizeLearning(raw, args.ctx, args.tableNames);
                    if (!lesson) continue;
                    learned.push(
                        await store.upsertNote({ ...lesson, database: args.database, createdByEmail: args.user.email }),
                    );
                }

                await store.touchNotes(args.recalled.map((n) => n.id));

                const flaggedIds = new Set(
                    (Array.isArray(args.submit.outdated_notes) ? args.submit.outdated_notes : []).flatMap(
                        (p): string[] => {
                            const prefix = typeof p === 'string' ? p.trim().replace(/^\[|\]$/g, '') : '';
                            const match = prefix ? args.recalled.find((n) => n.id.startsWith(prefix)) : undefined;
                            return match ? [match.id] : [];
                        },
                    ),
                );
                for (const id of flaggedIds) {
                    if (await store.voteNote(id, `model:${args.askId}`, false)) flagged += 1;
                }
            } catch (err) {
                reportMemoryError(err, 'learn');
            }
            cache.delete(args.database);
            return { learned, flagged };
        },

        async recordFeedback(user, noteIds, helpful) {
            if (!enabled || !Array.isArray(noteIds)) return 0;
            const ids = [
                ...new Set(noteIds.filter((i): i is string => typeof i === 'string' && NOTE_ID_RE.test(i))),
            ].slice(0, 20);
            let updated = 0;
            for (const id of ids) {
                if (await store.voteNote(id, user.sub, helpful)) updated += 1;
            }
            cache.clear();
            return updated;
        },

        async listNoteViews(database) {
            return (await store.listNotes(database, { includeHidden: true })).map(toView);
        },

        async removeNote(id) {
            if (!NOTE_ID_RE.test(id)) return;
            await store.deleteNote(id);
            cache.clear();
        },

        resetMemoryCache() {
            cache.clear();
            lastErrorAt = undefined;
        },
    };
}
