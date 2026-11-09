/* eslint-disable */
// @ts-nocheck
// int-fix-query-path-identity: Lightdash's own query path sends the user's identity. A SQL Runner
// query through the async query path on the Operations Project carries SET hrx.identity with a
// token minted from the user's attributes, so the engine runs an Audited Query as that user with
// the description and ticket given with the query, and refuses it once the attribute is gone.
import { disposeAll, harness, runAsyncQuery, track } from './support';

afterAll(disposeAll);

describe('int-fix-query-path-identity', () => {
    it('Audited Queries from the SQL Runner run as the Lightdash user', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const lightdash = track(await h.startLightdash({ engine }));

        await lightdash.setUserAttributes({ platform_read: 'true' });
        const ok = await runAsyncQuery(lightdash, 'sql', {
            sql: "SELECT n FROM platform_query('SELECT count(*) AS n FROM widgets')",
            audit: { description: 'Count synthetic widgets from the SQL Runner', ticket: 'ENG-1799' },
        });
        expect(ok.error).toBeNull();
        expect(Number(ok.rows[0].n)).toBe(200);
        const items = engine.auditStore.items();
        expect(items.length).toBeGreaterThanOrEqual(1);
        const item = items.find((i) => i.description === 'Count synthetic widgets from the SQL Runner');
        expect(item).toMatchObject({ executedBySub: lightdash.userUuid, executedByEmail: lightdash.userEmail, linearTicketId: 'ENG-1799', action: 'query', status: 'success' });

        await lightdash.setUserAttributes({ platform_read: 'false' });
        const refused = await runAsyncQuery(lightdash, 'sql', {
            sql: "SELECT n FROM platform_query('SELECT count(*) AS n FROM widgets')",
            audit: { description: 'Should be refused now' },
        });
        expect(refused.status).toBe('error');
        expect(String(refused.error)).toContain('platform_read');
    });
});
