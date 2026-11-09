/* eslint-disable */
// @ts-nocheck
// int-client-platform-functions: with an identity token provider from the backend's
// FederationIdentityService (user attributes -> claims), FederationWarehouseClient sends
// SET hrx.identity before each query and runs platform_query(), platform_explain(),
// platform_tables() and platform_columns() against the real engine.
import { WIDGET_COUNT } from './fixtures';
import { disposeAll, federationCredentials, harness, IDENTITY_SECRET, load, PROJECT_UUID, track, USER_EMAIL, USER_UUID, ORG_UUID } from './support';

afterAll(disposeAll);

describe('int-client-platform-functions', () => {
    it('runs every Platform Database function as the user, audited with the description', async () => {
        const h = await harness();
        const platform = track(await h.startPlatformDatabase());
        const engine = track(await h.startEngine({ platform }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const { FederationIdentityService } = await load('packages/backend/src/services/FederationIdentity/FederationIdentityService.ts');

        const identity = new FederationIdentityService({
            userAttributesModel: { getAttributeValuesForOrgMember: async () => ({ platform_read: ['true'] }) },
        });
        const getIdentityToken = identity.createTokenProvider({
            secret: IDENTITY_SECRET,
            user: { userUuid: USER_UUID, email: USER_EMAIL, organizationUuid: ORG_UUID },
            projectUuid: PROJECT_UUID,
            audit: { source: 'investigate', description: 'Platform Database schema browser', ticket: null },
        });
        const client = warehouseClientFromCredentials(federationCredentials(engine), { getIdentityToken });

        const count = await client.runQuery(`SELECT count(*) AS n FROM platform_query('SELECT id FROM widgets')`);
        expect(Number(count.rows[0].n)).toBe(WIDGET_COUNT);

        const tables = await client.runQuery('SELECT table_schema, table_name FROM platform_tables()');
        expect(tables.rows).toContainEqual({ table_schema: 'public', table_name: 'widgets' });

        const columns = await client.runQuery(`SELECT column_name, data_type, is_nullable FROM platform_columns('public', 'widgets')`);
        expect(columns.rows.map((r) => r.column_name)).toEqual(['id', 'name', 'qty']);
        expect(columns.rows[1].is_nullable).toBe(false);

        const plan = await client.runQuery(`SELECT plan FROM platform_explain('SELECT * FROM widgets WHERE qty > 3')`);
        const planJson = typeof plan.rows[0].plan === 'string' ? JSON.parse(plan.rows[0].plan) : plan.rows[0].plan;
        expect(JSON.stringify(planJson)).toContain('widgets');

        const items = engine.auditStore.items();
        expect(items.length).toBeGreaterThanOrEqual(4);
        for (const item of items) {
            expect(item.executedBySub).toBe(USER_UUID);
            expect(item.executedByEmail).toBe(USER_EMAIL);
            expect(item.description).toBe('Platform Database schema browser');
            expect(item.action).toBe('query');
        }
    });
});
