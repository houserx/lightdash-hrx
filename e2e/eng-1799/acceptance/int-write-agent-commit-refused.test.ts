/* eslint-disable */
// @ts-nocheck
// int-write-agent-commit-refused: an AI agent may Preview but never commit. Inside an agent
// execution context the backend refuses a commit before calling the engine, while a Preview runs
// with an agent identity (audited as ai_ask); and the engine itself refuses a commit carrying an
// agent identity token minted by the backend, even with a valid confirmation token.
import { buildAccount, buildFederationService, disposeAll, harness, httpJson, IDENTITY_SECRET, load, mintBackendToken, PROJECT_UUID, track } from './support';

afterAll(disposeAll);

const STATEMENT = 'DELETE FROM widgets WHERE id = 200';

describe('int-write-agent-commit-refused', () => {
    it('refuses agent commits in Lightdash and in the engine', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const { account, userUuid, email, organizationUuid } = await buildAccount();
        const service = await buildFederationService(engine, { platform_write: ['true'] });
        const { agentExecutionContext } = await load('packages/backend/src/services/AiAccessService/agentExecutionContext.ts');
        const { mintWriteConfirmationToken } = await load('packages/backend/src/services/FederationService/writeConfirmationToken.ts');
        const asAgent = <T>(fn: () => Promise<T>) => agentExecutionContext.run({ agentUuid: 'agent-e2e', threadUuid: 'thread-e2e', promptUuid: 'prompt-e2e' } as any, fn);
        const rows = async () => (await platform.query('SELECT count(*)::int AS n FROM public.widgets WHERE id = 200'))[0].n;

        const { confirmationToken } = await service.createWriteConfirmation(account, PROJECT_UUID, STATEMENT);
        let refused: any;
        try {
            await asAgent(() => service.write(account, PROJECT_UUID, { statement: STATEMENT, mode: 'commit', confirmationToken, description: 'agent cleanup' }));
        } catch (error) {
            refused = error;
        }
        expect(refused?.statusCode).toBe(403);
        expect(await rows()).toBe(1);
        expect(engine.auditStore.items()).toHaveLength(0);

        const preview = await asAgent(() => service.write(account, PROJECT_UUID, { statement: STATEMENT, mode: 'preview', confirmationToken, description: 'agent preview' }));
        expect(preview.preview).toBe(true);
        expect(await rows()).toBe(1);
        expect(engine.auditStore.items().at(-1)).toMatchObject({ action: 'ai_ask', preview: true });

        // Straight to the engine with a backend-minted agent identity and a fresh, valid confirmation.
        const agentBearer = await mintBackendToken({ sub: userUuid, email, org: organizationUuid, agent: true, attrs: { platform_write: true }, audit: { source: 'write_mode', description: 'agent commit' } });
        const { token } = mintWriteConfirmationToken({ statement: STATEMENT, userUuid, projectUuid: PROJECT_UUID, secret: IDENTITY_SECRET });
        const direct = await httpJson('POST', `${engine.httpUrl}/v1/write`, {
            headers: { Authorization: `Bearer ${agentBearer}` },
            body: { statement: STATEMENT, mode: 'commit', confirmation_token: token, description: 'agent commit', ticket: null },
        });
        expect(direct.status).toBe(403);
        expect(direct.json.error).toMatch(/agent/);
        expect(await rows()).toBe(1);
    });
});
