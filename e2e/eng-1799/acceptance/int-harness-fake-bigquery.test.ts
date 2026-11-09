/* eslint-disable */
// @ts-nocheck
// int-harness-fake-bigquery: a fake BigQuery API serves synthetic Ops Mart tables; the real engine
// lists the allowlisted ones in information_schema (catalog ops_marts) and reads their rows.
import { OPS_MART_TABLES } from './fixtures';
import { disposeAll, harness, pgRun, track } from './support';

afterAll(disposeAll);

describe('int-harness-fake-bigquery', () => {
    it('Ops Marts appear in the catalog and can be read', async () => {
        const h = await harness();
        const bigquery = track(await h.startFakeBigQuery({ tables: OPS_MART_TABLES }));
        const engine = track(await h.startEngine({ bigquery }));

        const tables = await pgRun(engine, [
            `SELECT table_catalog, table_schema, table_name FROM information_schema.tables WHERE table_catalog = 'ops_marts' AND table_schema <> 'information_schema' ORDER BY table_name`,
        ]);
        expect(tables.error).toBeUndefined();
        expect(tables.rows).toEqual([
            { table_catalog: 'ops_marts', table_schema: 'ops_marts', table_name: 'fills_hourly' },
            { table_catalog: 'ops_marts', table_schema: 'ops_marts', table_name: 'queue_depth' },
        ]);

        const rows = await pgRun(engine, [`SELECT site, fills FROM ops_marts.ops_marts.fills_hourly ORDER BY hour`]);
        expect(rows.error).toBeUndefined();
        expect(rows.rows.map((r) => [r.site, Number(r.fills)])).toEqual([
            ['site-a', 12],
            ['site-a', 15],
        ]);
        expect(bigquery.requests.length).toBeGreaterThan(0);
    });
});
