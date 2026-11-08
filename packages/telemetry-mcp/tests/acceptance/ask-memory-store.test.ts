import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { api } from './helpers/harness';

// The memory store keeps the portal's DynamoDB `ask-memory` item shape (api/src/dynamo/askMemory.ts)
// behind an interface; InMemoryAskMemoryStore is the test implementation exported by the package.

const input = {
    database: 'platform',
    kind: 'definition',
    topic: 'Active order status',
    insight: 'Orders count as active when status is open or processing.',
    tables: ['orders'],
    createdByEmail: 'analyst@example.test',
};

const expectedId = crypto
    .createHash('sha256')
    .update('platform\ndefinition\nactive order status')
    .digest('hex')
    .slice(0, 32);

describe('InMemoryAskMemoryStore (DynamoDB table shape)', () => {
    it('is exported by the package', () => {
        expect(typeof api.InMemoryAskMemoryStore).toBe('function');
    });

    it('creates a note keyed by the portal noteId with every table attribute', async () => {
        const store = new api.InMemoryAskMemoryStore();
        const n = await store.upsertNote(input);
        expect(n.id).toBe(expectedId);
        expect(n).toMatchObject({
            database: 'platform',
            kind: 'definition',
            topic: 'Active order status',
            insight: input.insight,
            tables: ['orders'],
            status: 'active',
            createdByEmail: 'analyst@example.test',
            confirmations: 1,
            uses: 0,
            upvotes: 0,
            downvotes: 0,
        });
        for (const k of ['createdAt', 'updatedAt', 'lastUsedAt']) expect(Number.isNaN(Date.parse(n[k]))).toBe(false);
        expect(n.expiresAt).toBeGreaterThan(Date.now() / 1000);
    });

    it('merges a re-learned lesson: same id, latest wording, confirmations + 1, createdAt kept', async () => {
        const store = new api.InMemoryAskMemoryStore();
        const a = await store.upsertNote(input);
        const b = await store.upsertNote({ ...input, topic: 'active  ORDER status!', insight: 'Active means open or processing.' });
        expect(b.id).toBe(a.id);
        expect(b.confirmations).toBe(2);
        expect(b.insight).toBe('Active means open or processing.');
        expect(b.createdAt).toBe(a.createdAt);
        expect(await store.listNotes('platform')).toHaveLength(1);
        expect(await store.listNotes('other-db')).toHaveLength(0);
    });

    it('counts each voter once and hides a note with >= 2 downvotes and more downs than ups', async () => {
        const store = new api.InMemoryAskMemoryStore();
        const n = await store.upsertNote(input);
        expect(await store.voteNote(n.id, 'voter-1', false)).toBeTruthy();
        expect(await store.voteNote(n.id, 'voter-1', false)).toBeNull();
        const hidden = await store.voteNote(n.id, 'voter-2', false);
        expect(hidden.status).toBe('hidden');
        expect(await store.listNotes('platform')).toHaveLength(0);
        expect(await store.listNotes('platform', { includeHidden: true })).toHaveLength(1);
    });

    it('touches, gets and deletes notes', async () => {
        const store = new api.InMemoryAskMemoryStore();
        const n = await store.upsertNote(input);
        await store.touchNotes([n.id, 'f'.repeat(32)]);
        expect((await store.getNote(n.id)).uses).toBe(1);
        await store.deleteNote(n.id);
        expect(await store.getNote(n.id)).toBeUndefined();
    });
});
