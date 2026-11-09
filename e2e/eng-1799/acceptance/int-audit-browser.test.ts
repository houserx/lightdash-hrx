/* eslint-disable */
// @ts-nocheck
// int-audit-browser: the Lightdash audit browser (FederationService.listAudit, behind
// GET /api/v2/projects/{uuid}/federation/audit) pages through the engine's GET /v1/audit over the
// fake audit store by ticket, user and month, newest first, 25 per page; without platform_read it
// is refused before the engine is asked.
import { buildAccount, buildFederationService, disposeAll, harness, mintBackendToken, pgRun, PROJECT_UUID, setIdentity, track } from './support';

afterAll(disposeAll);

describe('int-audit-browser', () => {
    it('lists audited executions by ticket, user and month', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const { account, email } = await buildAccount();

        const run = async (ticket: string, who: string) => {
            const token = await mintBackendToken({ email: who, attrs: { platform_read: true }, audit: { description: `audit browser check ${ticket}`, ticket, source: 'investigate' } });
            const r = await pgRun(engine, [setIdentity(token), `SELECT count(*) AS n FROM platform_query('SELECT 1 AS x')`]);
            expect(r.error).toBeUndefined();
        };
        for (let i = 0; i < 27; i++) await run('ENG-9', email);
        await run('ENG-10', 'someone.else@example.test');

        const service = await buildFederationService(engine, { platform_read: ['true'] });
        const page1 = await service.listAudit(account, PROJECT_UUID, { ticket: 'ENG-9' });
        expect(page1.items).toHaveLength(25);
        expect(page1.nextCursor).toBeTruthy();
        const times = page1.items.map((i) => i.createdAt);
        expect([...times].sort().reverse()).toEqual(times);
        const page2 = await service.listAudit(account, PROJECT_UUID, { ticket: 'ENG-9', cursor: page1.nextCursor });
        expect(page2.items).toHaveLength(2);
        expect(page2.nextCursor ?? null).toBeNull();
        expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(27);

        const byUser = await service.listAudit(account, PROJECT_UUID, { user: 'someone.else@example.test' });
        expect(byUser.items.map((i) => i.linearTicketId)).toEqual(['ENG-10']);

        const month = new Date().toISOString().slice(0, 7);
        const byMonth = await service.listAudit(account, PROJECT_UUID, { month });
        expect(byMonth.items).toHaveLength(25);

        const denied = await buildFederationService(engine, {});
        const before = engine.auditStore.requests?.length;
        await expect(denied.listAudit(account, PROJECT_UUID, { ticket: 'ENG-9' })).rejects.toMatchObject({ statusCode: 403 });
        if (before !== undefined) expect(engine.auditStore.requests.length).toBe(before);
    });
});
