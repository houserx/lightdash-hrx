import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SOURCES, startHarness, type Harness } from './helpers/harness';

let h: Harness;
beforeAll(async () => {
    h = await startHarness();
    h.engine.on(/information_schema\.tables/i, {
        columns: [
            { name: 'table_catalog', type: 'text' },
            { name: 'table_schema', type: 'text' },
            { name: 'table_name', type: 'text' },
        ],
        rows: [
            ['ops_marts', 'ops', 'fills_hourly'],
            ['ops_marts', 'ops', 'queue_depth'],
        ],
    });
}, 30_000);
afterAll(async () => {
    await h?.close();
});

describe('list_sources', () => {
    it('lists every configured Telemetry Source with kind, default and restricted flags', async () => {
        const r = await h.call('list_sources', {});
        expect(r.isError, r.text).toBe(false);
        const sources = r.structured.sources as { name: string; kind: string; default: boolean; restricted: boolean }[];
        expect(sources.map((s) => s.name).sort()).toEqual(DEFAULT_SOURCES.map((s) => s.name).sort());
        for (const want of DEFAULT_SOURCES) {
            const got = sources.find((s) => s.name === want.name);
            expect(got).toMatchObject({
                kind: want.kind,
                default: want.default === true,
                restricted: want.restricted === true,
            });
        }
    });

    it('lists the Ops Marts the engine catalog exposes, as catalog.schema.table', async () => {
        const r = await h.call('list_sources', {});
        expect(r.isError, r.text).toBe(false);
        expect([...r.structured.opsMarts].sort()).toEqual(['ops_marts.ops.fills_hourly', 'ops_marts.ops.queue_depth']);
        const catalogQueries = h.engine.dataQueries().filter((q) => /information_schema\.tables/i.test(q.sql));
        expect(catalogQueries.length).toBeGreaterThan(0);
        expect(catalogQueries.every((q) => !/\bpg_/i.test(q.sql))).toBe(true);
    });

    it('declares an input schema and a description', async () => {
        const tool = (await h.listTools()).find((t) => t.name === 'list_sources');
        expect(tool).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema?.type).toBe('object');
    });
});
