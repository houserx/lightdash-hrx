/* eslint-disable */
// @ts-nocheck
// imp-dashboard-layout: Grafana's 24-column gridPos maps onto Lightdash's 36-column grid:
// x and w scale by 36/24, the vertical order is kept, and no two tiles overlap.
import { grafanaDashboard, importGrafanaDashboards, overlaps, panel, tileByTitle } from './support';

const POSITIONS = {
    'Left half': { x: 0, y: 0, w: 12, h: 8 },
    'Right half': { x: 12, y: 0, w: 12, h: 8 },
    'Third A': { x: 0, y: 8, w: 8, h: 6 },
    'Third B': { x: 8, y: 8, w: 8, h: 6 },
    'Third C': { x: 16, y: 8, w: 8, h: 6 },
    'Full width': { x: 0, y: 14, w: 24, h: 10 },
    'Odd width': { x: 3, y: 24, w: 5, h: 3 },
};

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard(
            'Layout Grid',
            Object.entries(POSITIONS).map(([title, gridPos]) => panel('timeseries', title, gridPos)),
        ),
    ]);
});
afterAll(() => run?.cleanup());

describe('grid layout', () => {
    it('scales x and w from 24 to 36 columns', () => {
        const dashboard = run.dashboards()[0].doc;
        for (const [title, pos] of Object.entries(POSITIONS)) {
            const tile = tileByTitle(dashboard, title);
            expect(tile, title).toBeDefined();
            expect(tile.x).toBe(Math.round((pos.x * 36) / 24));
            expect(tile.w).toBe(Math.max(1, Math.round((pos.w * 36) / 24)));
            expect(tile.x + tile.w).toBeLessThanOrEqual(36);
            expect(tile.h).toBeGreaterThanOrEqual(1);
        }
    });

    it('keeps rows in order and heights in proportion', () => {
        const dashboard = run.dashboards()[0].doc;
        const y = (t) => tileByTitle(dashboard, t).y;
        const h = (t) => tileByTitle(dashboard, t).h;
        expect(y('Left half')).toBe(y('Right half'));
        expect(y('Third A')).toBe(y('Third C'));
        expect(y('Left half')).toBeLessThan(y('Third A'));
        expect(y('Third A')).toBeLessThan(y('Full width'));
        expect(y('Full width')).toBeLessThan(y('Odd width'));
        expect(h('Full width')).toBeGreaterThan(h('Left half'));
        expect(h('Left half')).toBeGreaterThan(h('Third A'));
        // The next row starts where the row above ends.
        expect(y('Third A')).toBe(y('Left half') + h('Left half'));
    });

    it('never overlaps tiles', () => {
        const tiles = run.dashboards()[0].doc.tiles;
        for (let i = 0; i < tiles.length; i += 1) {
            for (let j = i + 1; j < tiles.length; j += 1) {
                expect(overlaps(tiles[i], tiles[j])).toBe(false);
            }
        }
    });
});
