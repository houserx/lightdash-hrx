/**
 * Ask's shared "team memory" table, kept in the shape of the portal's DynamoDB `ask-memory` item
 * (db-query-portal `api/src/dynamo/askMemory.ts` at aea73de) behind the `AskMemoryStore` interface.
 *
 * The types, `noteId`, `shouldHide` and every update rule are the portal's. `InMemoryAskMemoryStore`
 * reproduces the semantics of the portal's DynamoDB update expressions (if_not_exists, ADD,
 * condition checks, ReturnValues ALL_NEW) on a Map; a DynamoDB-backed store can implement the same
 * interface later.
 */
import { createHash } from 'node:crypto';

export type MemoryKind = 'table_hint' | 'definition' | 'gotcha' | 'query_pattern';
export const MEMORY_KINDS: readonly MemoryKind[] = ['table_hint', 'definition', 'gotcha', 'query_pattern'];

/** Portal `AI_ASK_MEMORY_TTL_DAYS` default. */
export const DEFAULT_ASK_MEMORY_TTL_DAYS = 120;

/**
 * A reusable lesson about HOW an answer was found (where a concept lives, what a value means, a
 * proven query shape). Never row data. One item per (database, kind, topic).
 */
export interface MemoryNote {
    id: string;
    database: string;
    kind: MemoryKind;
    topic: string;
    insight: string;
    tables: string[];
    /** Literal-scrubbed SQL shape from a query that ran successfully. */
    sqlTemplate?: string;
    /** Hidden notes are kept (so a bad lesson isn't re-learned) but never shown to the model. */
    status: 'active' | 'hidden';
    createdAt: string;
    updatedAt: string;
    lastUsedAt: string;
    createdByEmail: string;
    /** Times an independent ask re-derived this lesson. */
    confirmations: number;
    /** Times it was recalled into an answered ask. */
    uses: number;
    upvotes: number;
    downvotes: number;
    /** DynamoDB TTL (epoch seconds), pushed forward every time the note is used or voted on. */
    expiresAt: number;
}

export interface UpsertNoteInput {
    database: string;
    kind: MemoryKind;
    topic: string;
    insight: string;
    tables: string[];
    sqlTemplate?: string;
    createdByEmail: string;
}

export interface ListNotesOptions {
    includeHidden?: boolean;
}

/** The portal's askMemory.ts functions, as a store. */
export interface AskMemoryStore {
    /**
     * Creates the note, or refreshes an existing one (latest wording wins, confirmations +1). A
     * hidden note stays hidden. Returns the stored item.
     */
    upsertNote(input: UpsertNoteInput): Promise<MemoryNote>;
    /** Notes for one database, newest first (by updatedAt). Hidden notes only when asked for. */
    listNotes(database: string, opts?: ListNotesOptions): Promise<MemoryNote[]>;
    getNote(id: string): Promise<MemoryNote | undefined>;
    /** Marks notes as used by an answered ask (best-effort per note; a deleted note is skipped). */
    touchNotes(ids: string[]): Promise<void>;
    /**
     * Records one vote. Each voter id counts once per note. Returns the updated note, or null when
     * the note is gone or this voter already voted.
     */
    voteNote(id: string, voterId: string, helpful: boolean): Promise<MemoryNote | null>;
    deleteNote(id: string): Promise<void>;
}

/** Stable key so re-learning the same lesson merges instead of duplicating. */
export function noteId(database: string, kind: MemoryKind, topic: string): string {
    const normalized = topic
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    return createHash('sha256').update(`${database}\n${kind}\n${normalized}`).digest('hex').slice(0, 32);
}

/** Hide once clearly distrusted: at least two downvotes and more downs than ups. */
export function shouldHide(note: Pick<MemoryNote, 'upvotes' | 'downvotes'>): boolean {
    return note.downvotes >= 2 && note.downvotes > note.upvotes;
}

export interface InMemoryAskMemoryStoreOptions {
    /** Days until a note expires unless used or voted on. Default 120 (the portal's). */
    ttlDays?: number;
    /** Clock, for tests. */
    now?: () => Date;
}

const copy = (note: MemoryNote): MemoryNote => ({ ...note, tables: [...note.tables] });

/**
 * In-process `AskMemoryStore` for tests and single-instance use. Items are copied in and out, as a
 * table would. Expired items (expiresAt in the past) are dropped on read, as DynamoDB TTL would
 * eventually do.
 */
export class InMemoryAskMemoryStore implements AskMemoryStore {
    private readonly items = new Map<string, MemoryNote>();

    /** The portal item's `voters` string set, kept apart so notes never carry voter ids. */
    private readonly voters = new Map<string, Set<string>>();

    private readonly ttlDays: number;

    private readonly now: () => Date;

    constructor(opts: InMemoryAskMemoryStoreOptions = {}) {
        this.ttlDays = opts.ttlDays ?? DEFAULT_ASK_MEMORY_TTL_DAYS;
        this.now = opts.now ?? (() => new Date());
    }

    async upsertNote(input: UpsertNoteInput): Promise<MemoryNote> {
        const now = this.now().toISOString();
        const id = noteId(input.database, input.kind, input.topic);
        const existing = this.live(id);
        const note: MemoryNote = {
            id,
            database: input.database,
            kind: input.kind,
            topic: input.topic,
            insight: input.insight,
            tables: [...input.tables],
            updatedAt: now,
            lastUsedAt: now,
            expiresAt: this.ttlFromNow(),
            createdAt: existing?.createdAt ?? now,
            createdByEmail: existing?.createdByEmail ?? input.createdByEmail,
            status: existing?.status ?? 'active',
            uses: existing?.uses ?? 0,
            upvotes: existing?.upvotes ?? 0,
            downvotes: existing?.downvotes ?? 0,
            confirmations: (existing?.confirmations ?? 0) + 1,
        };
        const sqlTemplate = input.sqlTemplate || existing?.sqlTemplate;
        if (sqlTemplate) note.sqlTemplate = sqlTemplate;
        this.items.set(id, note);
        return copy(note);
    }

    async listNotes(database: string, opts: ListNotesOptions = {}): Promise<MemoryNote[]> {
        const notes: MemoryNote[] = [];
        for (const id of [...this.items.keys()]) {
            const note = this.live(id);
            if (note && note.database === database && (opts.includeHidden || note.status === 'active')) {
                notes.push(copy(note));
            }
        }
        return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    async getNote(id: string): Promise<MemoryNote | undefined> {
        const note = this.live(id);
        return note ? copy(note) : undefined;
    }

    async touchNotes(ids: string[]): Promise<void> {
        const now = this.now().toISOString();
        for (const id of ids) {
            const note = this.live(id);
            if (note) {
                note.lastUsedAt = now;
                note.expiresAt = this.ttlFromNow();
                note.uses += 1;
            }
        }
    }

    async voteNote(id: string, voterId: string, helpful: boolean): Promise<MemoryNote | null> {
        const note = this.live(id);
        if (!note) return null;
        const voters = this.voters.get(id) ?? new Set<string>();
        if (voters.has(voterId)) return null;
        voters.add(voterId);
        this.voters.set(id, voters);
        if (helpful) note.upvotes += 1;
        else note.downvotes += 1;
        note.expiresAt = this.ttlFromNow();
        if (note.status === 'active' && shouldHide(note)) note.status = 'hidden';
        return copy(note);
    }

    async deleteNote(id: string): Promise<void> {
        this.items.delete(id);
        this.voters.delete(id);
    }

    private ttlFromNow(): number {
        return Math.floor(this.now().getTime() / 1000) + this.ttlDays * 86_400;
    }

    /** The stored item, unless its TTL has passed (then it is removed, as DynamoDB TTL would). */
    private live(id: string): MemoryNote | undefined {
        const note = this.items.get(id);
        if (!note) return undefined;
        if (note.expiresAt * 1000 <= this.now().getTime()) {
            this.items.delete(id);
            this.voters.delete(id);
            return undefined;
        }
        return note;
    }
}
