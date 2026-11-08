// ldq-federation-catalog: FederationWarehouseClient reads its catalog from information_schema
// only (the engine emulates no pg_catalog), and skips the pg_matviews version gating.
import { Client } from 'pg';
import { load } from './load';
import { startPgCluster, type PgCluster } from './pgCluster';

let warehouses: any;
let cluster: PgCluster;

beforeAll(async () => {
    warehouses = await load('../../index');
    cluster = await startPgCluster();
    const admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await admin.query('CREATE SCHEMA telemetry');
    await admin.query(
        'CREATE TABLE telemetry.fills_hourly (hour timestamptz, fills int8, region text)',
    );
    await admin.query(
        'CREATE MATERIALIZED VIEW telemetry.ldq_matview AS SELECT 1 AS x',
    );
    await admin.end();
}, 120_000);

afterAll(() => {
    cluster?.stop();
});

// A relation in pg_catalog, not the string literal 'pg_catalog' in a schema filter.
const catalogQueries =
    /\bpg_catalog\.|\bpg_(matviews|class|namespace|attribute|type|index|tables|views)\b/i;

describe('FederationWarehouseClient catalog', () => {
    it('lists tables and fields through information_schema only', async () => {
        const client = warehouses.warehouseClientFromCredentials(
            {
                type: 'postgres',
                flavor: 'federation',
                host: '127.0.0.1',
                port: cluster.port,
                user: 'postgres',
                password: 'not-a-real-password',
                dbname: 'postgres',
                schema: 'telemetry',
                sslmode: 'disable',
                identitySigningSecret: 'test-secret-not-real',
            },
            { getIdentityToken: async () => 'ldq-catalog-token' },
        );
        await client.runQuery('SELECT 0 AS ldq_catalog_start');
        const before = cluster.readLog().length;

        const tables = await client.getAllTables();
        expect(tables).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    database: 'postgres',
                    schema: 'telemetry',
                    table: 'fills_hourly',
                }),
            ]),
        );
        expect(
            tables.find((t: { table: string }) => t.table === 'ldq_matview'),
        ).toBeUndefined();

        const expectedFields = {
            postgres: {
                telemetry: {
                    fills_hourly: {
                        hour: 'timestamp',
                        fills: 'number',
                        region: 'string',
                    },
                },
            },
        };
        expect(
            await client.getFields('fills_hourly', 'telemetry', 'postgres'),
        ).toMatchObject(expectedFields);
        expect(
            await client.getCatalog([
                {
                    database: 'postgres',
                    schema: 'telemetry',
                    table: 'fills_hourly',
                },
            ]),
        ).toMatchObject(expectedFields);

        const sent = cluster.readLog().slice(before);
        expect(sent).toContain('information_schema');
        expect(sent).not.toMatch(catalogQueries);
    }, 60_000);
});
