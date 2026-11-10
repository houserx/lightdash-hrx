/* eslint-disable */
// @ts-nocheck
// int-write-preview: Write Mode Preview through the Lightdash backend (FederationService, the
// service behind POST /api/v2/projects/{uuid}/write) against the real engine returns the rows the
// statement would change and rolls back: the Platform Database is unchanged, and the token is spent.
import { buildAccount, buildFederationService, disposeAll, harness, PROJECT_UUID, track } from './support';

afterAll(disposeAll);

const STATEMENT = 'UPDATE widgets SET qty = 99 WHERE id IN (7, 8) RETURNING id, qty';

describe('int-write-preview', () => {
    it('previews and rolls back', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const { account } = await buildAccount();
        const service = await buildFederationService(engine, { platform_write: ['true'] });
        const before = await platform.query('SELECT id, qty FROM public.widgets WHERE id IN (7, 8) ORDER BY id');

        const { confirmationToken } = await service.createWriteConfirmation(account, PROJECT_UUID, STATEMENT);
        const result = await service.write(account, PROJECT_UUID, {
            statement: STATEMENT,
            mode: 'preview',
            confirmationToken,
            description: 'Preview a synthetic quantity fix',
            ticket: 'ENG-1799',
        });
        expect(result.preview).toBe(true);
        expect(result.rows_affected).toBe(2);
        expect(result.returning).toEqual([
            { id: 7, qty: 99 },
            { id: 8, qty: 99 },
        ]);
        expect(typeof result.audit_id).toBe('string');

        expect(await platform.query('SELECT id, qty FROM public.widgets WHERE id IN (7, 8) ORDER BY id')).toEqual(before);
        const item = engine.auditStore.items().find((i) => i.id === result.audit_id);
        expect(item).toMatchObject({ mode: 'write', preview: true, sql: STATEMENT, status: 'success', rowCount: 2 });
    });
});
