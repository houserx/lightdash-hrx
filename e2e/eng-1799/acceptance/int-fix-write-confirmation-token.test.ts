/* eslint-disable */
// @ts-nocheck
// int-fix-write-confirmation-token: a Write Mode confirmation token issued by the Lightdash backend
// (POST .../write/confirmations, FederationService.createWriteConfirmation) is one the engine
// accepts: its test-mode verify endpoint says valid for the bound statement, user and project, and
// invalid for another statement, user or project.
import { buildAccount, buildFederationService, disposeAll, harness, httpJson, mintBackendToken, PROJECT_UUID, track } from './support';

afterAll(disposeAll);

const STATEMENT = 'UPDATE widgets SET qty = 6 WHERE id = 3';

describe('int-fix-write-confirmation-token', () => {
    it('the engine accepts backend-issued confirmation tokens, bound to statement, user and project', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform, testMode: true }));
        const { account, userUuid, email, organizationUuid } = await buildAccount();
        const service = await buildFederationService(engine, { platform_write: ['true'], platform_read: ['true'] });

        const { confirmationToken, expiresAt } = await service.createWriteConfirmation(account, PROJECT_UUID, STATEMENT);
        expect(typeof confirmationToken).toBe('string');
        expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);

        const bearer = await mintBackendToken({ sub: userUuid, email, org: organizationUuid, attrs: { platform_write: true }, audit: { source: 'write_mode', description: 'verify' } });
        const verify = (statement: string, token = bearer) =>
            httpJson('POST', `${engine.httpUrl}/v1/write/confirmations/verify`, {
                headers: { Authorization: `Bearer ${token}` },
                body: { statement, confirmation_token: confirmationToken },
            });

        const ok = await verify(STATEMENT);
        expect(ok.status).toBe(200);
        expect(ok.json).toEqual({ valid: true });

        expect((await verify(`${STATEMENT} AND qty = 1`)).json).toEqual({ valid: false });
        const otherUser = await mintBackendToken({ sub: '0f6c1f7e-4444-4c4c-8a8a-000000000004', attrs: { platform_write: true }, audit: { source: 'write_mode', description: 'verify' } });
        expect((await verify(STATEMENT, otherUser)).json).toEqual({ valid: false });
        const otherProject = await mintBackendToken({ sub: userUuid, project: '0f6c1f7e-5555-4c4c-8a8a-000000000005', attrs: { platform_write: true }, audit: { source: 'write_mode', description: 'verify' } });
        expect((await verify(STATEMENT, otherProject)).json).toEqual({ valid: false });
    });
});
