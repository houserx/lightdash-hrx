import { describe, expect, it } from 'vitest';
import { InMemoryAskMemoryStore, noteId, shouldHide, type UpsertNoteInput } from './ask-memory-store.js';

// Port of the portal's memory-table tests (api/src/dynamo/askMemory.test.ts at aea73de), run against the
// in-memory store. The portal mocked `ddb.send` and inspected the DynamoDB requests; here each case drives the
// store and checks the behaviour those requests produce.

describe('noteId', () => {
    it('is stable across wording/case/punctuation of the topic, and scoped by database and kind', () => {
        const a = noteId('platform', 'definition', 'Open  Orders!');
        expect(noteId('platform', 'definition', 'open orders')).toBe(a);
        expect(noteId('other', 'definition', 'open orders')).not.toBe(a);
        expect(noteId('platform', 'gotcha', 'open orders')).not.toBe(a);
        expect(a).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('shouldHide', () => {
    it.each([
        [0, 1, false],
        [0, 2, true],
        [2, 2, false],
        [1, 3, true],
    ])('upvotes=%i downvotes=%i -> %s', (upvotes, downvotes, expected) => {
        expect(shouldHide({ upvotes, downvotes })).toBe(expected);
    });
});

const base: UpsertNoteInput = {
    database: 'platform',
    kind: 'gotcha',
    topic: 'soft deletes',
    insight: 'Filter deleted_at IS NULL.',
    tables: ['orders'],
    createdByEmail: 'a@b.com',
};

describe('voteNote', () => {
    it('returns null when the note is gone or this voter already voted', async () => {
        const store = new InMemoryAskMemoryStore();
        expect(await store.voteNote('a'.repeat(32), 'auth0|1', true)).toBeNull();
        const n = await store.upsertNote(base);
        expect(await store.voteNote(n.id, 'auth0|1', true)).not.toBeNull();
        expect(await store.voteNote(n.id, 'auth0|1', true)).toBeNull();
        expect((await store.getNote(n.id))?.upvotes).toBe(1);
    });

    it('hides a note once the downvote threshold is crossed', async () => {
        const store = new InMemoryAskMemoryStore();
        const n = await store.upsertNote(base);
        await store.voteNote(n.id, 'auth0|2', false);
        const note = await store.voteNote(n.id, 'auth0|1', false);
        expect(note).toMatchObject({ status: 'hidden', upvotes: 0, downvotes: 2 });
        expect(await store.listNotes('platform')).toEqual([]);
    });

    it('leaves a note active below the threshold', async () => {
        const store = new InMemoryAskMemoryStore();
        const n = await store.upsertNote(base);
        await store.voteNote(n.id, 'auth0|2', true);
        const note = await store.voteNote(n.id, 'auth0|1', false);
        expect(note).toMatchObject({ status: 'active', upvotes: 1, downvotes: 1 });
    });
});

describe('upsertNote', () => {
    it('merges by stable id, never un-hides, and only sets sqlTemplate when provided', async () => {
        const store = new InMemoryAskMemoryStore();
        const without = await store.upsertNote(base);
        expect(without.id).toBe(noteId('platform', 'gotcha', 'soft deletes'));
        expect(without).toMatchObject({ status: 'active', confirmations: 1 });
        expect(without).not.toHaveProperty('sqlTemplate');

        await store.voteNote(without.id, 'v1', false);
        await store.voteNote(without.id, 'v2', false);
        const withSql = await store.upsertNote({ ...base, topic: 'Soft deletes!', sqlTemplate: 'SELECT 1' });
        expect(withSql.id).toBe(without.id);
        expect(withSql).toMatchObject({ status: 'hidden', confirmations: 2, sqlTemplate: 'SELECT 1' });
        expect(await store.listNotes('platform', { includeHidden: true })).toHaveLength(1);
    });
});

describe('listNotes', () => {
    it('returns only that database, newest first (the portal paged a scan)', async () => {
        let now = new Date('2026-01-01T00:00:00Z');
        const store = new InMemoryAskMemoryStore({ now: () => now });
        const a = await store.upsertNote({ ...base, topic: 'note a' });
        now = new Date('2026-02-01T00:00:00Z');
        const b = await store.upsertNote({ ...base, topic: 'note b' });
        await store.upsertNote({ ...base, database: 'other', topic: 'note c' });
        const notes = await store.listNotes('platform');
        expect(notes.map((n) => n.id)).toEqual([b.id, a.id]);
    });
});
