/* eslint-disable */
// @ts-nocheck
// int-write-commit-once: a Write Mode commit through the Lightdash backend applies once; reusing
// its confirmation token is refused with 409 by the engine and that status reaches Lightdash's
// caller; a fresh token for the same statement works again.
import { buildAccount, buildFederationService, disposeAll, harness, PROJECT_UUID, track } from './support';

afterAll(disposeAll);

const STATEMENT = 'UPDATE widgets SET qty = qty + 1 WHERE id = 11';

describe('int-write-commit-once', () => {
    it('commits once and refuses a reused token with 409', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const { account } = await buildAccount();
        const service = await buildFederationService(engine, { platform_write: ['true'] });
        const qty = async () => (await platform.query('SELECT qty FROM public.widgets WHERE id = 11'))[0].qty;
        const start = await qty();

        const { confirmationToken } = await service.createWriteConfirmation(account, PROJECT_UUID, STATEMENT);
        const body = { statement: STATEMENT, mode: 'commit', confirmationToken, description: 'Synthetic quantity bump', ticket: 'ENG-1799' };
        const first = await service.write(account, PROJECT_UUID, body);
        expect(first.preview).toBe(false);
        expect(first.rows_affected).toBe(1);
        expect(first.returning).toBeNull();
        expect(await qty()).toBe(start + 1);

        let reused: any;
        try {
            await service.write(account, PROJECT_UUID, body);
        } catch (error) {
            reused = error;
        }
        expect(reused).toBeDefined();
        expect(reused.statusCode).toBe(409);
        expect(await qty()).toBe(start + 1);

        const fresh = await service.createWriteConfirmation(account, PROJECT_UUID, STATEMENT);
        await service.write(account, PROJECT_UUID, { ...body, confirmationToken: fresh.confirmationToken });
        expect(await qty()).toBe(start + 2);
        expect(engine.auditStore.items().filter((i) => i.mode === 'write' && i.status === 'success')).toHaveLength(2);
    });
});
