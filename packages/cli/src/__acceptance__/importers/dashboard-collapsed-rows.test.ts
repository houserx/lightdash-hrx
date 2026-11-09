/* eslint-disable */
// @ts-nocheck
// imp-dashboard-collapsed-rows: a collapsed Grafana row (its panels nested inside it) becomes a
// dashboard tab holding those panels; the panels outside collapsed rows go on a first tab. With
// --no-tabs the collapsed rows become headings instead, with their panels expanded below.
import { grafanaDashboard, importGrafanaDashboards, overlaps, panel, tileByTitle } from './support';

const dashboardJson = grafanaDashboard('Collapsed Rows', [
    panel('timeseries', 'Overview chart', { x: 0, y: 0, w: 24, h: 8 }),
    {
        id: 20,
        type: 'row',
        title: 'Database',
        collapsed: true,
        gridPos: { x: 0, y: 8, w: 24, h: 1 },
        panels: [
            panel('timeseries', 'Connections', { x: 0, y: 9, w: 12, h: 8 }),
            panel('timeseries', 'Replica lag', { x: 12, y: 9, w: 12, h: 8 }),
        ],
    },
    {
        id: 30,
        type: 'row',
        title: 'Queues',
        collapsed: true,
        gridPos: { x: 0, y: 9, w: 24, h: 1 },
        panels: [panel('stat', 'Queue depth', { x: 0, y: 10, w: 8, h: 4 })],
    },
]);

let run: any;
let noTabs: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([dashboardJson]);
    noTabs = await importGrafanaDashboards([dashboardJson], ['--no-tabs']);
});
afterAll(async () => {
    await run?.cleanup();
    await noTabs?.cleanup();
});

describe('collapsed rows', () => {
    it('become tabs holding their panels', () => {
        const dashboard = run.dashboards()[0].doc;
        expect(dashboard.tabs.length).toBe(3);
        const tabByName = Object.fromEntries(dashboard.tabs.map((t) => [t.name, t]));
        expect(tabByName.Database).toBeDefined();
        expect(tabByName.Queues).toBeDefined();
        expect(dashboard.tabs[0].name).not.toBe('Database');
        expect(dashboard.tabs.map((t) => t.order)).toEqual([0, 1, 2]);
        const tab = (title) => tileByTitle(dashboard, title).tabSlug;
        expect(tab('Connections')).toBe(tabByName.Database.slug);
        expect(tab('Replica lag')).toBe(tabByName.Database.slug);
        expect(tab('Queue depth')).toBe(tabByName.Queues.slug);
        expect(tab('Overview chart')).toBe(dashboard.tabs[0].slug);
        // Every tile is on a tab, and tiles on one tab don't overlap.
        for (const t of dashboard.tiles) expect(typeof t.tabSlug).toBe('string');
        for (let i = 0; i < dashboard.tiles.length; i += 1)
            for (let j = i + 1; j < dashboard.tiles.length; j += 1)
                expect(overlaps(dashboard.tiles[i], dashboard.tiles[j])).toBe(false);
    });

    it('become headings with --no-tabs', () => {
        const dashboard = noTabs.dashboards()[0].doc;
        expect(dashboard.tabs).toEqual([]);
        const headings = dashboard.tiles.filter((t) => t.type === 'heading').map((t) => t.properties.text);
        expect(headings).toEqual(['Database', 'Queues']);
        const y = (title) => tileByTitle(dashboard, title).y;
        const heading = (text) => dashboard.tiles.find((t) => t.type === 'heading' && t.properties.text === text);
        expect(heading('Database').y).toBeLessThan(y('Connections'));
        expect(y('Connections')).toBeLessThan(heading('Queues').y);
        expect(heading('Queues').y).toBeLessThan(y('Queue depth'));
        expect(noTabs.charts()).toHaveLength(4);
    });
});
