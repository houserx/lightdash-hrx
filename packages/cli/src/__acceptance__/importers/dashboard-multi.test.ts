/* eslint-disable */
// @ts-nocheck
// imp-dashboard-multi-file: one run imports several dashboards; dashboard and chart slugs
// stay unique across them (two dashboards with the same title get distinct slugs), and a
// second run on the same output directory gives the same files.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { grafanaDashboard, importGrafanaDashboards, panel } from './support';

const a = grafanaDashboard('Same Title', [panel('timeseries', 'Requests', { x: 0, y: 0, w: 24, h: 8 })], { uid: 'aaa' });
const b = grafanaDashboard('Same Title', [panel('timeseries', 'Requests', { x: 0, y: 0, w: 24, h: 8 })], { uid: 'bbb' });
const c = grafanaDashboard('Another', [panel('timeseries', 'Requests', { x: 0, y: 0, w: 24, h: 8 })], { uid: 'ccc' });

let run: any;
let again: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([a, b, c]);
    again = await importGrafanaDashboards([a, b, c]);
});
afterAll(async () => {
    await run?.cleanup();
    await again?.cleanup();
});

describe('several dashboards', () => {
    it('writes one dashboard per input with unique slugs', () => {
        const slugs = run.dashboards().map((d) => d.doc.slug);
        expect(slugs).toHaveLength(3);
        expect(new Set(slugs).size).toBe(3);
        expect(run.dashboards().filter((d) => d.doc.name === 'Same Title')).toHaveLength(2);
    });

    it('keeps chart slugs unique across dashboards', () => {
        const charts = run.charts();
        expect(charts).toHaveLength(3);
        expect(new Set(charts.map((c) => c.doc.slug)).size).toBe(3);
        for (const d of run.dashboards()) {
            for (const t of d.doc.tiles.filter((t) => t.type === 'sql_chart')) {
                expect(run.chartBySlug(t.properties.chartSlug)).toBeDefined();
            }
        }
    });

    it('is deterministic', () => {
        expect(again.files).toEqual(run.files);
        for (const f of run.files.filter((f) => f.endsWith('.yml'))) {
            expect(readFileSync(path.join(again.out, f), 'utf8')).toBe(readFileSync(path.join(run.out, f), 'utf8'));
        }
    });
});
