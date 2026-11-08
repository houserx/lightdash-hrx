// ldq-federation-warehouse-client: warehouseClientFromCredentials returns
// FederationWarehouseClient (a PostgresWarehouseClient) for flavor 'federation' only.
import { load } from './load';

let warehouses: any;

beforeAll(async () => {
    warehouses = await load('../../index');
}, 120_000);

const credentials = {
    type: 'postgres',
    flavor: 'federation',
    host: '127.0.0.1',
    port: 5433,
    user: 'lightdash-operations',
    password: 'test-password-not-real',
    dbname: 'operations',
    schema: 'public',
    sslmode: 'disable',
    identitySigningSecret: 'test-secret-not-real',
    httpBaseUrl: 'http://127.0.0.1:8088',
};

describe('warehouseClientFromCredentials', () => {
    it('returns a FederationWarehouseClient for the federation flavour', () => {
        const client = warehouses.warehouseClientFromCredentials(credentials);
        expect(warehouses.FederationWarehouseClient).toBeDefined();
        expect(client).toBeInstanceOf(warehouses.FederationWarehouseClient);
        expect(client).toBeInstanceOf(warehouses.PostgresWarehouseClient);
    });

    it('keeps Postgres for the postgres flavour and for no flavour', () => {
        const explicit = warehouses.warehouseClientFromCredentials({
            ...credentials,
            flavor: 'postgres',
        });
        const { flavor, ...withoutFlavor } = credentials;
        expect(flavor).toBe('federation');
        const implicit = warehouses.warehouseClientFromCredentials(withoutFlavor);
        for (const client of [explicit, implicit]) {
            expect(client).toBeInstanceOf(warehouses.PostgresWarehouseClient);
            expect(client).not.toBeInstanceOf(
                warehouses.FederationWarehouseClient,
            );
        }
    });

    it('keeps the Postgres SQL dialect', () => {
        const client = warehouses.warehouseClientFromCredentials(credentials);
        expect(client.getAdapterType()).toBe('postgres');
        expect(client.getStringQuoteChar()).toBe("'");
        expect(client.credentials.type).toBe('postgres');
    });
});
