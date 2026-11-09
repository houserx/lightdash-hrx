/* eslint-disable */
// @ts-nocheck
// imp-dashboard-rows: an expanded Grafana row becomes a full-width heading tile with the row
// title, above the panels it holds.
import { grafanaDashboard, importGrafanaDashboards, panel, tileByTitle } from './support';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Rows As Headings', [
            panel('timeseries', 'Before any row', { x: 0, y: 0, w: 24, h: 6 }),
            { id: 2, type: 'row', title: 'Traffic', collapsed: false, gridPos: { x: 0, y: 6, w: 24, h: 1 }, panels: [] },
            panel('timeseries', 'Requests', { x: 0, y: 7, w: 12, h: 8 }),
            panel('timeseries', 'Latency', { x: 12, y: 7, w: 12, h: 8 }),
            { id: 5, type: 'row', title: 'Errors', collapsed: false, gridPos: { x: 0, y: 15, w: 24, h: 1 }, panels: [] },
            panel('stat', 'Error ratio', { x: 0, y: 16, w: 8, h: 4 }),
        ]),
    ]);
});
afterAll(() => run?.cleanup());

describe('row panels', () => {
    it('become heading tiles with the row title', () => {
        const dashboard = run.dashboards()[0].doc;
        const headings = dashboard.tiles.filter((t) => t.type === 'heading');
        expect(headings.map((h) => h.properties.text)).toEqual(['Traffic', 'Errors']);
        for (const h of headings) {
            expect(h.x).toBe(0);
            expect(h.w).toBe(36);
        }
        // Expanded rows don't need tabs.
        expect(dashboard.tabs).toEqual([]);
    });

    it('sit above the panels they hold and below the ones before them', () => {
        const dashboard = run.dashboards()[0].doc;
        const traffic = dashboard.tiles.find((t) => t.type === 'heading' && t.properties.text === 'Traffic');
        const errors = dashboard.tiles.find((t) => t.type === 'heading' && t.properties.text === 'Errors');
        const y = (title) => tileByTitle(dashboard, title).y;
        expect(y('Before any row')).toBeLessThan(traffic.y);
        expect(traffic.y + traffic.h).toBeLessThanOrEqual(y('Requests'));
        expect(y('Latency')).toBe(y('Requests'));
        expect(y('Requests')).toBeLessThan(errors.y);
        expect(errors.y + errors.h).toBeLessThanOrEqual(y('Error ratio'));
    });
});
