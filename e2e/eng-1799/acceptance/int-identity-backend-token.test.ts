/* eslint-disable */
// @ts-nocheck
// int-identity-backend-token: a token minted by the Lightdash backend's minting code is accepted
// by the engine on SET hrx.identity, the Audited Query lands in the audit store with the token's
// subject, email, description and ticket, and the backend's own verifier agrees with the engine.
import { disposeAll, harness, IDENTITY_SECRET, load, mintBackendToken, pgRun, setIdentity, track, USER_EMAIL, USER_UUID } from './support';

afterAll(disposeAll);

describe('int-identity-backend-token', () => {
    it('the engine accepts backend tokens and audits with their claims', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const { verifyIdentityToken } = await load('packages/backend/src/services/FederationIdentity/identityToken.ts');

        const token = await mintBackendToken({
            attrs: { platform_read: true },
            audit: { description: 'Investigate a stuck refill queue', ticket: 'ENG-4242', source: 'investigate' },
            ttlSeconds: 300,
        });
        expect(() => verifyIdentityToken(token, { secret: IDENTITY_SECRET, now: new Date() })).not.toThrow();

        const result = await pgRun(engine, [setIdentity(token), `SELECT count(*) AS n FROM platform_query('SELECT id FROM widgets WHERE qty = 0')`]);
        expect(result.error).toBeUndefined();
        expect(Number(result.rows[0].n)).toBeGreaterThan(0);

        const [item] = engine.auditStore.items();
        expect(item).toMatchObject({
            executedBySub: USER_UUID,
            executedByEmail: USER_EMAIL,
            description: 'Investigate a stuck refill queue',
            linearTicketId: 'ENG-4242',
            database: 'platform',
            action: 'query',
            mode: 'read',
            status: 'success',
        });

        // The identity stays on the session until the next SET (§3: Lightdash re-sends it per query).
        const again = await pgRun(engine, [setIdentity(token), `SELECT 1 AS one`, `SELECT count(*) AS n FROM platform_query('SELECT 1 AS x')`]);
        expect(again.error).toBeUndefined();
    });
});
