// ldq-federation-identity-set: FederationWarehouseClient sends SET hrx.identity = '<token>'
// immediately before each query, on the connection that runs it (CONTRACTS §3, §4.1).
// Runs against a throwaway Postgres that logs every statement.
import { load } from './load';
import { loggedStatements, startPgCluster, type PgCluster } from './pgCluster';

let warehouses: any;
let cluster: PgCluster;

beforeAll(async () => {
    warehouses = await load('../../index');
    cluster = await startPgCluster();
}, 120_000);

afterAll(() => {
    cluster?.stop();
});

const credentials = (flavor?: 'federation' | 'postgres') => ({
    type: 'postgres',
    ...(flavor ? { flavor } : {}),
    host: '127.0.0.1',
    port: cluster.port,
    user: 'postgres',
    password: 'not-a-real-password',
    dbname: 'postgres',
    schema: 'public',
    sslmode: 'disable',
    identitySigningSecret: 'test-secret-not-real',
    httpBaseUrl: 'http://127.0.0.1:1',
});

const identityBefore = (statements: string[], marker: string) => {
    const index = statements.findIndex((s) => s.includes(marker));
    expect(index).toBeGreaterThan(-1);
    const previous = statements
        .slice(0, index)
        .reverse()
        .find((s) => /^SET hrx\.identity/i.test(s));
    return previous;
};

describe('FederationWarehouseClient identity', () => {
    it('sets a fresh identity token before every query', async () => {
        let n = 0;
        const contexts: unknown[] = [];
        const client = warehouses.warehouseClientFromCredentials(
            credentials('federation'),
            {
                getIdentityToken: async (context: unknown) => {
                    contexts.push(context);
                    n += 1;
                    return `ldq-token-${n}`;
                },
            },
        );
        await client.runQuery('SELECT 101 AS ldq_marker_one');
        await client.runQuery('SELECT 102 AS ldq_marker_two');
        const rows: unknown[] = [];
        await client.streamQuery(
            'SELECT 103 AS ldq_marker_three',
            (chunk: { rows: unknown[] }) => {
                rows.push(...chunk.rows);
            },
            { tags: {} },
        );
        expect(rows).toEqual([{ ldq_marker_three: 103 }]);

        const statements = loggedStatements(cluster.readLog());
        expect(identityBefore(statements, 'ldq_marker_one')).toBe(
            "SET hrx.identity = 'ldq-token-1'",
        );
        expect(identityBefore(statements, 'ldq_marker_two')).toBe(
            "SET hrx.identity = 'ldq-token-2'",
        );
        expect(identityBefore(statements, 'ldq_marker_three')).toBe(
            "SET hrx.identity = 'ldq-token-3'",
        );
        expect(contexts).toHaveLength(3);
        expect(contexts[0]).toMatchObject({ agent: false });
    }, 60_000);

    it('tells the token provider about agent sessions', async () => {
        const contexts: any[] = [];
        const client = warehouses.warehouseClientFromCredentials(
            credentials('federation'),
            {
                agentSession: true,
                getIdentityToken: async (context: unknown) => {
                    contexts.push(context);
                    return 'ldq-agent-token';
                },
            },
        );
        await client.runQuery('SELECT 104 AS ldq_marker_agent');
        expect(contexts[0]).toMatchObject({ agent: true });
        const statements = loggedStatements(cluster.readLog());
        expect(identityBefore(statements, 'ldq_marker_agent')).toBe(
            "SET hrx.identity = 'ldq-agent-token'",
        );
    }, 60_000);

    it('never sends an identity on plain Postgres connections', async () => {
        const provider = vi.fn(async () => 'ldq-should-not-appear');
        const client = warehouses.warehouseClientFromCredentials(
            credentials('postgres'),
            { getIdentityToken: provider },
        );
        await client.runQuery('SELECT 105 AS ldq_marker_plain');
        expect(provider).not.toHaveBeenCalled();
        expect(cluster.readLog()).not.toContain('ldq-should-not-appear');
    }, 60_000);
});
