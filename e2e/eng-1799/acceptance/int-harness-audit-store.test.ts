/* eslint-disable */
// @ts-nocheck
// int-harness-audit-store: the fake audit store (DynamoDB executions table + S3 Object Lock
// bucket, the stores the engine line's audit writer uses) records every Audited Query, and when it
// fails the engine fails the query with 58000.
import { disposeAll, harness, mintBackendToken, pgRun, setIdentity, track } from './support';

afterAll(disposeAll);

describe('int-harness-audit-store', () => {
    it('captures one DynamoDB item and one S3 object per Audited Query, and can fail on demand', async () => {
        const h = await harness();
        const auditStore = track(await h.startFakeAuditStore());
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform, auditStore }));
        expect(engine.auditStore).toBe(auditStore);

        const token = await mintBackendToken({ attrs: { platform_read: true }, audit: { description: 'Count widgets for the harness', ticket: 'ENG-1799', source: 'investigate' } });
        const ok = await pgRun(engine, [setIdentity(token), `SELECT count(*) AS n FROM platform_query('SELECT id FROM widgets')`]);
        expect(ok.error).toBeUndefined();

        const items = auditStore.items();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            sql: expect.stringContaining('platform_query'),
            mode: 'read',
            description: 'Count widgets for the harness',
            database: 'platform',
            linearTicketId: 'ENG-1799',
            status: 'success',
        });
        const objects = auditStore.objects();
        expect(objects).toHaveLength(1);
        expect(objects[0].key).toBe(`executions/${items[0].createdAt}/${items[0].id}.json`);
        expect(JSON.parse(objects[0].body)).toEqual(items[0]);

        auditStore.setFailing(true);
        const failed = await pgRun(engine, [setIdentity(token), `SELECT count(*) AS n FROM platform_query('SELECT id FROM widgets')`]);
        expect(failed.error?.code).toBe('58000');
        expect(failed.error?.message).toContain('audit write failed');
        expect(failed.rows).toHaveLength(0);
        auditStore.setFailing(false);
    });
});
