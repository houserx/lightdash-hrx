/* eslint-disable */
// @ts-nocheck
// int-client-catalog: FederationWarehouseClient lists the engine's catalog (the allowlisted Ops
// Marts) and their fields through information_schema only, the way Lightdash's catalog and SQL
// Runner sidebar call it.
import { OPS_MART_TABLES } from './fixtures';
import { disposeAll, federationCredentials, harness, load, track } from './support';

afterAll(disposeAll);

describe('int-client-catalog', () => {
    it('getAllTables, getFields and getCatalog return the Ops Marts with Lightdash field types', async () => {
        const h = await harness();
        const bigquery = track(await h.startFakeBigQuery({ tables: OPS_MART_TABLES }));
        const engine = track(await h.startEngine({ bigquery }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine));

        const tables = await client.getAllTables();
        const opsMarts = tables.filter((t) => t.database === 'ops_marts').map((t) => `${t.schema}.${t.table}`).sort();
        expect(opsMarts).toEqual(['ops_marts.fills_hourly', 'ops_marts.queue_depth']);

        const fields = await client.getFields('fills_hourly', 'ops_marts', 'ops_marts');
        expect(fields).toEqual({ ops_marts: { ops_marts: { fills_hourly: { hour: 'timestamp', site: 'string', fills: 'number' } } } });

        const catalog = await client.getCatalog([
            { database: 'ops_marts', schema: 'ops_marts', table: 'fills_hourly' },
            { database: 'ops_marts', schema: 'ops_marts', table: 'queue_depth' },
        ]);
        expect(catalog.ops_marts.ops_marts.queue_depth).toEqual({ at: 'timestamp', depth: 'number' });
        expect(catalog.ops_marts.ops_marts.fills_hourly.site).toBe('string');

        // Lightdash can preview an Ops Mart through the client.
        const preview = await client.runQuery('SELECT site, fills FROM ops_marts.ops_marts.fills_hourly ORDER BY hour LIMIT 10');
        expect(preview.rows.map((r) => Number(r.fills))).toEqual([12, 15]);
    });
});
