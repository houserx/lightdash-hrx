/* eslint-disable */
// @ts-nocheck
// int-identity-claims-scope: the engine restricts a valid backend token to what its claims allow:
// platform_explain alone permits platform_explain() but not platform_query()/platform_tables();
// a system identity (sys = true) with platform_read reads and is audited as an assertion.
import { disposeAll, harness, mintBackendToken, pgRun, setIdentity, track } from './support';

afterAll(disposeAll);

describe('int-identity-claims-scope', () => {
    it('grants exactly what the claims say', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const audit = { description: 'Claim scope check', source: 'investigate' };

        const explainOnly = await mintBackendToken({ attrs: { platform_explain: true }, audit });
        expect((await pgRun(engine, [setIdentity(explainOnly), `SELECT plan FROM platform_explain('SELECT * FROM widgets')`])).error).toBeUndefined();
        const q = await pgRun(engine, [setIdentity(explainOnly), `SELECT * FROM platform_query('SELECT 1')`]);
        expect(q.error?.code).toBe('42501');
        expect(q.error?.message).toContain('platform_read');
        expect((await pgRun(engine, [setIdentity(explainOnly), `SELECT * FROM platform_tables()`])).error?.code).toBe('42501');

        const system = await mintBackendToken({
            sub: 'system:alert-evaluator',
            sys: true,
            attrs: { platform_read: true },
            audit: { description: 'Synthetic alert rule', source: 'alert_rule', resource_uuid: '0f6c1f7e-9999-4c4c-8a8a-000000000009' },
        });
        expect((await pgRun(engine, [setIdentity(system), `SELECT count(*) AS n FROM platform_query('SELECT id FROM widgets')`])).error).toBeUndefined();
        const last = engine.auditStore.items().at(-1);
        expect(last).toMatchObject({ executedBySub: 'system:alert-evaluator', action: 'assertion', description: 'Synthetic alert rule' });
    });
});
