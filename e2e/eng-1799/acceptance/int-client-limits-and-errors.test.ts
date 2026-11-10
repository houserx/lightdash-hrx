/* eslint-disable */
// @ts-nocheck
// int-client-limits-and-errors: the engine's statement_timeout, max_rows (54000), access (42501)
// and audit (58000) failures surface in Lightdash as WarehouseQueryErrors with the engine's
// message, never leaking the identity token, and a timed-out query stops the source request.
import { disposeAll, federationCredentials, harness, IDENTITY_SECRET, iso, load, PROJECT_UUID, ORG_UUID, T0, track, USER_EMAIL, USER_UUID, waitFor, windowSql } from './support';

afterAll(disposeAll);

const tokenProvider = async (attrs: Record<string, string[]>, description: string | null) => {
    const { FederationIdentityService } = await load('packages/backend/src/services/FederationIdentity/FederationIdentityService.ts');
    const service = new FederationIdentityService({ userAttributesModel: { getAttributeValuesForOrgMember: async () => attrs } });
    const minted: string[] = [];
    const provider = service.createTokenProvider({
        secret: IDENTITY_SECRET,
        user: { userUuid: USER_UUID, email: USER_EMAIL, organizationUuid: ORG_UUID },
        projectUuid: PROJECT_UUID,
        audit: { source: 'investigate', description, ticket: null },
    });
    return {
        minted,
        getIdentityToken: async (ctx: any) => {
            const token = await provider(ctx);
            minted.push(token);
            return token;
        },
    };
};

const failure = async (promise: Promise<unknown>) => {
    try {
        await promise;
    } catch (error: any) {
        return error;
    }
    throw new Error('expected the query to fail');
};

describe('int-client-limits-and-errors', () => {
    it('statement timeout cancels the query and the source request', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'slow' }, value: 1 }], delayMs: 20_000 }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine, { timeoutSeconds: 2 }));
        const started = Date.now();
        const error = await failure(client.runQuery(`SELECT * FROM promql('slow', ${windowSql(5)}, '1m')`));
        expect(Date.now() - started).toBeLessThan(15_000);
        expect(error.name).toBe('WarehouseQueryError');
        expect(String(error.message)).toMatch(/timeout|cancel/i);
        await waitFor('the engine to abandon the Prometheus request', async () => prom.cancelled() > 0, 15_000);
    });

    it('max_rows overflow is a 54000 error, not truncation', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'many' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom, maxRows: 1000 }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine));
        const error = await failure(client.runQuery(`SELECT * FROM promql('many', '${iso(T0)}', '${iso(T0 + 1_999_000)}', '1s')`));
        expect(error.name).toBe('WarehouseQueryError');
        expect(error.message).toContain('result exceeds max_rows');
        const fine = await client.runQuery(`SELECT count(*) AS n FROM promql('many', '${iso(T0)}', '${iso(T0 + 999_000)}', '1s')`);
        expect(Number(fine.rows[0].n)).toBe(1000);
    });

    it('42501 names the missing claim and 58000 says the audit write failed, without the token', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');

        const denied = await tokenProvider({}, 'why not');
        const deniedClient = warehouseClientFromCredentials(federationCredentials(engine), { getIdentityToken: denied.getIdentityToken });
        const accessError = await failure(deniedClient.runQuery(`SELECT * FROM platform_query('SELECT 1')`));
        expect(accessError.name).toBe('WarehouseQueryError');
        expect(accessError.message).toContain('platform_read');
        expect(denied.minted.length).toBeGreaterThan(0);
        for (const token of denied.minted) expect(accessError.message).not.toContain(token);

        const noDescription = await tokenProvider({ platform_read: ['true'] }, null);
        const noDescriptionClient = warehouseClientFromCredentials(federationCredentials(engine), { getIdentityToken: noDescription.getIdentityToken });
        const descError = await failure(noDescriptionClient.runQuery(`SELECT * FROM platform_query('SELECT 1')`));
        expect(descError.message).toContain('audited query requires a description');

        const allowed = await tokenProvider({ platform_read: ['true'] }, 'Count widgets');
        const client = warehouseClientFromCredentials(federationCredentials(engine), { getIdentityToken: allowed.getIdentityToken });
        engine.auditStore.setFailing(true);
        const auditError = await failure(client.runQuery(`SELECT count(*) AS n FROM platform_query('SELECT id FROM widgets')`));
        engine.auditStore.setFailing(false);
        expect(auditError.name).toBe('WarehouseQueryError');
        expect(auditError.message).toContain('audit write failed');
        for (const token of allowed.minted) expect(auditError.message).not.toContain(token);
    });
});
