/* eslint-disable */
// @ts-nocheck
// int-client-streaming: a large promql() result streams to Lightdash through
// FederationWarehouseClient.streamQuery in several batches (pg cursors over the extended
// protocol), with every row delivered once and in order.
import { disposeAll, federationCredentials, harness, iso, load, T0, track } from './support';

afterAll(disposeAll);

describe('int-client-streaming', () => {
    it('streams 30000 rows in batches', async () => {
        const h = await harness();
        const prom = track(await h.startFakePrometheus({ series: [{ labels: { __name__: 'big', shard: 'a' }, value: 1 }] }));
        const engine = track(await h.startEngine({ prometheus: prom }));
        const { warehouseClientFromCredentials } = await load('packages/warehouses/src/index.ts');
        const client = warehouseClientFromCredentials(federationCredentials(engine));

        // [T0, T0 + 29999 s] at 1 s: 30000 points.
        const sql = `SELECT timestamp, value FROM promql('big', '${iso(T0)}', '${iso(T0 + 29_999_000)}', '1s') ORDER BY timestamp`;
        const batches: number[] = [];
        let first: any;
        let last: any;
        await client.streamQuery(
            sql,
            async ({ rows }) => {
                batches.push(rows.length);
                if (!first && rows.length) first = rows[0];
                if (rows.length) last = rows[rows.length - 1];
            },
            { tags: {}, timezone: 'UTC' },
        );
        expect(batches.reduce((a, b) => a + b, 0)).toBe(30000);
        expect(batches.filter((n) => n > 0).length).toBeGreaterThan(1);
        expect(new Date(first.timestamp).toISOString()).toBe(iso(T0));
        expect(new Date(last.timestamp).toISOString()).toBe(iso(T0 + 29_999_000));
    });
});
