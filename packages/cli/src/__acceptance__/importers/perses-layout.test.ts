/* eslint-disable */
// @ts-nocheck
// imp-perses-layout: Perses Grid layouts (24 columns) map onto Lightdash's 36-column grid; an
// open grid with a title becomes a heading above its panels, and a collapsed grid becomes a tab.
import path from 'node:path';
import { PERSES, importPerses, overlaps, tileByTitle } from './support';

let run: any;
let flat: any;
beforeAll(async () => {
    run = await importPerses([path.join(PERSES, 'node-overview.yaml')]);
    flat = await importPerses([path.join(PERSES, 'api-latency.json')]);
});
afterAll(async () => {
    await run?.cleanup();
    await flat?.cleanup();
});

describe('Perses layouts', () => {
    it('scales the grid', () => {
        const p = tileByTitle(flat.dashboards()[0].doc, 'Request latency p50 and p99');
        expect(p).toMatchObject({ x: 0, w: 36 });
        const d = run.dashboards()[0].doc;
        expect(tileByTitle(d, 'CPU usage')).toMatchObject({ x: 0, w: 18 });
        expect(tileByTitle(d, 'Targets up')).toMatchObject({ x: 18, w: 9 });
        expect(tileByTitle(d, 'Memory used')).toMatchObject({ x: 27, w: 9 });
    });

    it('turns a collapsed grid into a tab and an open one into a heading', () => {
        const d = run.dashboards()[0].doc;
        const details = d.tabs.find((t) => t.name === 'Details');
        expect(details).toBeDefined();
        for (const title of ['Scrape durations', 'Errors by instance']) expect(tileByTitle(d, title).tabSlug).toBe(details.slug);
        const overviewTab = tileByTitle(d, 'CPU usage').tabSlug;
        expect(overviewTab).not.toBe(details.slug);
        const heading = d.tiles.find((t) => t.type === 'heading' && t.properties.text === 'Overview');
        expect(heading).toBeDefined();
        expect(heading.y).toBeLessThan(tileByTitle(d, 'CPU usage').y + 1);
        for (let i = 0; i < d.tiles.length; i += 1)
            for (let j = i + 1; j < d.tiles.length; j += 1) expect(overlaps(d.tiles[i], d.tiles[j])).toBe(false);
    });
});
