// ldq-federation-identity-not-logged: the SET hrx.identity statement and its token never appear
// in client logs or in the error a failed query raises.
import { load } from './load';
import { startPgCluster, type PgCluster } from './pgCluster';

let warehouses: any;
let cluster: PgCluster;
const captured: string[] = [];

beforeAll(async () => {
    warehouses = await load('../../index');
    cluster = await startPgCluster();
}, 120_000);

afterAll(() => {
    cluster?.stop();
});

beforeEach(() => {
    captured.length = 0;
    const capture = (...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(' '));
    };
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
        vi.spyOn(console, method).mockImplementation(capture);
    }
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('FederationWarehouseClient logging', () => {
    it('keeps the token out of logs and errors', async () => {
        const token = 'ldq-secret-token-value-not-real';
        const client = warehouses.warehouseClientFromCredentials(
            {
                type: 'postgres',
                flavor: 'federation',
                host: '127.0.0.1',
                port: cluster.port,
                user: 'postgres',
                password: 'not-a-real-password',
                dbname: 'postgres',
                schema: 'public',
                sslmode: 'disable',
                identitySigningSecret: 'test-secret-not-real',
            },
            { getIdentityToken: async () => token },
        );
        expect(client).toBeInstanceOf(warehouses.FederationWarehouseClient);
        await client.runQuery('SELECT 1 AS ldq_ok');
        let message = '';
        try {
            await client.runQuery('SELECT * FROM ldq_table_that_does_not_exist');
        } catch (error) {
            message = `${(error as Error).message} ${JSON.stringify(error)}`;
        }
        expect(message).toContain('ldq_table_that_does_not_exist');
        expect(message).not.toContain(token);
        expect(captured.join('\n')).not.toContain(token);
        // The engine-side proof that the token was really sent.
        expect(cluster.readLog()).toContain(token);
    }, 60_000);
});
