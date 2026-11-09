/* eslint-disable */
// @ts-nocheck
// int-identity-refused-tokens: tampered, expired, wrongly signed and over-long tokens from the
// backend's minting code count as no claims in the engine (42501 on Audited Queries), while
// ordinary telemetry still works; the backend's verifier rejects the same tokens.
import { disposeAll, harness, IDENTITY_SECRET, load, mintBackendToken, pgRun, setIdentity, tamper, track, windowSql } from './support';

afterAll(disposeAll);

const audited = `SELECT count(*) AS n FROM platform_query('SELECT id FROM widgets')`;

describe('int-identity-refused-tokens', () => {
    it('refuses bad tokens for Audited Queries and still serves ordinary telemetry', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up' }, value: 1 }] }));
        const engine = track(await h.startEngine({ platform, prometheus: prom }));
        const { verifyIdentityToken } = await load('packages/backend/src/services/FederationIdentity/identityToken.ts');
        const audit = { description: 'Refused token check', source: 'investigate' };

        const good = await mintBackendToken({ attrs: { platform_read: true }, audit });
        expect((await pgRun(engine, [setIdentity(good), audited])).error).toBeUndefined();

        const tampered = tamper(await mintBackendToken({ attrs: { platform_read: false }, audit }), (p) => {
            p.attrs.platform_read = true;
        });
        const expired = await mintBackendToken({ attrs: { platform_read: true }, audit, now: new Date(Date.now() - 600_000), ttlSeconds: 300 });
        const wrongSecret = await mintBackendToken({ attrs: { platform_read: true }, audit, secret: 'another-secret-not-real' });
        const future = await mintBackendToken({ attrs: { platform_read: true }, audit, now: new Date(Date.now() + 120_000) });

        for (const [name, token] of Object.entries({ tampered, expired, wrongSecret, future })) {
            const result = await pgRun(engine, [setIdentity(token), audited]);
            expect(result.error?.code, name).toBe('42501');
            expect(result.error?.message, name).toContain('platform_read');
            expect(() => verifyIdentityToken(token, { secret: IDENTITY_SECRET, now: new Date() }), name).toThrow();
            const telemetry = await pgRun(engine, [setIdentity(token), `SELECT count(*) AS n FROM promql('up', ${windowSql(1)}, '1m')`]);
            expect(telemetry.error, name).toBeUndefined();
        }
        // Only the good token's query was audited.
        expect(engine.auditStore.items()).toHaveLength(1);
    });
});
