/* eslint-disable */
// @ts-nocheck
// int-client-connect: Lightdash's warehouseClientFromCredentials gives a FederationWarehouseClient
// for a federation-flavour Postgres connection, and it connects to, tests and queries the real engine.
import { disposeAll, federationCredentials, harness, load, track } from './support';

afterAll(disposeAll);

describe('int-client-connect', () => {
    it('connects, passes test(), and runs a query with Postgres-shaped results', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'up', instance: 'db-1' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const { warehouseClientFromCredentials, FederationWarehouseClient } = await load('packages/warehouses/src/index.ts');

        const client = warehouseClientFromCredentials(federationCredentials(engine));
        expect(client).toBeInstanceOf(FederationWarehouseClient);
        await client.test();

        const results = await client.runQuery(`SELECT 1 AS one, 'synthetic' AS word, now() AS at`);
        expect(results.rows).toHaveLength(1);
        expect(Number(results.rows[0].one)).toBe(1);
        expect(results.rows[0].word).toBe('synthetic');
        expect(Object.keys(results.fields)).toEqual(['one', 'word', 'at']);
        expect(results.fields.at.type).toBe('timestamp');
        expect(results.fields.word.type).toBe('string');
        expect(results.fields.one.type).toBe('number');

        const plain = warehouseClientFromCredentials({ ...federationCredentials(engine), flavor: 'postgres' });
        expect(plain).not.toBeInstanceOf(FederationWarehouseClient);
    });
});
