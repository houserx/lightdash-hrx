import { describe, expect, it } from 'vitest';
import { InMemoryAskMemoryStore, noteId } from './ask-memory-store.js';

const base = {
    database: 'platform',
    kind: 'gotcha' as const,
    topic: 'soft deletes',
    insight: 'Filter deleted_at IS NULL.',
    tables: ['orders'],
    createdByEmail: 'a@example.test',
};

const clock = (start: string) => {
    let t = Date.parse(start);
    return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
};

describe('InMemoryAskMemoryStore', () => {
    it('keeps the first sqlTemplate when a re-upsert has none, and the first author', async () => {
        const store = new InMemoryAskMemoryStore();
        await store.upsertNote({ ...base, sqlTemplate: 'SELECT 1' });
        const b = await store.upsertNote({ ...base, createdByEmail: 'b@example.test' });
        expect(b.sqlTemplate).toBe('SELECT 1');
        expect(b.createdByEmail).toBe('a@example.test');
        const c = await store.upsertNote({ ...base, sqlTemplate: 'SELECT 2' });
        expect(c.sqlTemplate).toBe('SELECT 2');
        expect(c.confirmations).toBe(3);
    });

    it('never un-hides a note on re-upsert', async () => {
        const store = new InMemoryAskMemoryStore();
        const n = await store.upsertNote(base);
        await store.voteNote(n.id, 'v1', false);
        await store.voteNote(n.id, 'v2', false);
        expect((await store.upsertNote(base)).status).toBe('hidden');
    });

    it('stays active while ups keep pace with downs', async () => {
        const store = new InMemoryAskMemoryStore();
        const n = await store.upsertNote(base);
        await store.voteNote(n.id, 'v1', true);
        await store.voteNote(n.id, 'v2', false);
        expect((await store.voteNote(n.id, 'v3', false))?.status).toBe('hidden');
        const m = await store.upsertNote({ ...base, topic: 'other' });
        await store.voteNote(m.id, 'v1', true);
        await store.voteNote(m.id, 'v2', true);
        await store.voteNote(m.id, 'v3', false);
        expect((await store.voteNote(m.id, 'v4', false))?.status).toBe('active');
    });

    it('returns copies, never the stored item', async () => {
        const store = new InMemoryAskMemoryStore();
        const n = await store.upsertNote(base);
        n.tables.push('mutated');
        n.uses = 99;
        const got = await store.getNote(n.id);
        expect(got?.tables).toEqual(['orders']);
        expect(got?.uses).toBe(0);
    });

    it('voting on a missing note returns null; a deleted note forgets its voters', async () => {
        const store = new InMemoryAskMemoryStore();
        expect(await store.voteNote(noteId('platform', 'gotcha', 'none'), 'v1', true)).toBeNull();
        const n = await store.upsertNote(base);
        await store.voteNote(n.id, 'v1', true);
        await store.deleteNote(n.id);
        await store.upsertNote(base);
        expect((await store.voteNote(n.id, 'v1', true))?.upvotes).toBe(1);
    });

    it('lists newest first and drops notes past their TTL; touch and votes push the TTL', async () => {
        const c = clock('2026-01-01T00:00:00Z');
        const store = new InMemoryAskMemoryStore({ ttlDays: 1, now: c.now });
        const a = await store.upsertNote(base);
        c.advance(1000);
        const b = await store.upsertNote({ ...base, topic: 'newer' });
        expect((await store.listNotes('platform')).map((n) => n.id)).toEqual([b.id, a.id]);
        expect(b.expiresAt).toBe(Math.floor(c.now().getTime() / 1000) + 86_400);
        c.advance(43_200_000);
        await store.touchNotes([a.id]);
        c.advance(43_200_000);
        expect(await store.getNote(b.id)).toBeUndefined();
        expect((await store.getNote(a.id))?.uses).toBe(1);
        expect(await store.listNotes('platform')).toHaveLength(1);
    });
});
