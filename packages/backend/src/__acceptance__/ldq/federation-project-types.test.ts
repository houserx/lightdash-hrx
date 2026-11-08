// ldq-federation-project-types: a federation-flavour connection works with the `none` and the
// native-git (`semanticLayer: 'lightdash'`) project types, and dbt fails clearly.
import { DbtVersionOptionLatest } from '@lightdash/common';
import { toDbtTarget } from '../../dbt/targets';
import { DbtNoneCredentialsProjectAdapter } from '../../projectAdapters/dbtNoneCredentialsProjectAdapter';
import { NativeGitProjectAdapter } from '../../projectAdapters/nativeGitProjectAdapter';
import { projectAdapterFromConfig } from '../../projectAdapters/projectAdapter';
import { load } from './load';

let warehouses: any;

beforeAll(async () => {
    warehouses = await load('@lightdash/warehouses');
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

const cachedWarehouse = {
    warehouseCatalog: undefined,
    onWarehouseCatalogChange: () => {},
};

const adapterFor = (config: unknown, client: unknown) =>
    projectAdapterFromConfig(
        config as never,
        client as never,
        cachedWarehouse,
        DbtVersionOptionLatest.LATEST,
        [],
        null,
        {
            resolve: () =>
                toDbtTarget(credentials as never, { explicitCredentials: false }),
            policy: { explicitCredentials: false },
        } as never,
    );

describe('federation connection with each project type', () => {
    it('uses a FederationWarehouseClient for the connection', () => {
        const client = warehouses.warehouseClientFromCredentials(credentials);
        expect(client).toBeInstanceOf(warehouses.FederationWarehouseClient);
    });

    it('works with the none project type', async () => {
        const client = warehouses.warehouseClientFromCredentials(credentials);
        const adapter = await adapterFor({ type: 'none' }, client);
        expect(adapter).toBeInstanceOf(DbtNoneCredentialsProjectAdapter);
        await expect(
            (adapter as any).getLightdashProjectConfig(),
        ).resolves.toBeDefined();
    });

    it('works with a native-git Lightdash semantic layer', async () => {
        const client = warehouses.warehouseClientFromCredentials(credentials);
        const adapter = await adapterFor(
            {
                type: 'github',
                authorization_method: 'personal_access_token',
                personal_access_token: 'ghp_testTokenNotReal000000000000000000',
                repository: 'example-org/ops-semantic-layer',
                branch: 'main',
                project_sub_path: '/',
                host_domain: 'github.com',
                semanticLayer: 'lightdash',
            },
            client,
        );
        expect(adapter).toBeInstanceOf(NativeGitProjectAdapter);
    });

    it('fails clearly for a dbt project', async () => {
        const client = warehouses.warehouseClientFromCredentials(credentials);
        await expect(
            adapterFor(
                { type: 'dbt', project_dir: '/tmp/ldq-not-a-dbt-project' },
                client,
            ),
        ).rejects.toThrow('dbt is not supported for the Federation Engine');
    });
});
