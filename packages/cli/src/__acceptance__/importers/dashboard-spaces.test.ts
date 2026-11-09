/* eslint-disable */
// @ts-nocheck
// imp-dashboard-spaces: imported dashboards and charts go to the space given with --space
// (default `operations`); with --dashboards-tf (grafana_dashboards.tf) each dashboard goes to
// the space named after its Grafana folder.
import path from 'node:path';
import { GRAFANA_CONFIG, TF, generateSlug, grafanaDashboard, importGrafanaDashboards, panel } from './support';

let byDefault: any;
let explicit: any;
let byFolder: any;
beforeAll(async () => {
    const synthetic = grafanaDashboard('Space Check', [panel('timeseries', 'One', { x: 0, y: 0, w: 24, h: 8 })]);
    byDefault = await importGrafanaDashboards([synthetic]);
    explicit = await importGrafanaDashboards([synthetic], ['--space', 'grafana-migration']);
    byFolder = await importGrafanaDashboards(
        [
            path.join(GRAFANA_CONFIG, 'rds/pg_cron.json'),
            path.join(GRAFANA_CONFIG, 'bcp-dr/dr-replication-production.json'),
            path.join(GRAFANA_CONFIG, 'golden-signals.json'),
        ],
        ['--dashboards-tf', path.join(TF, 'grafana_dashboards.tf'), '--space', 'general'],
    );
});
afterAll(async () => {
    for (const r of [byDefault, explicit, byFolder]) await r?.cleanup();
});

describe('spaces', () => {
    it('defaults to the operations space', () => {
        expect(byDefault.dashboards()[0].doc.spaceSlug).toBe('operations');
        for (const c of byDefault.charts()) expect(c.doc.spaceSlug).toBe('operations');
    });

    it('uses --space', () => {
        expect(explicit.dashboards()[0].doc.spaceSlug).toBe('grafana-migration');
        for (const c of explicit.charts()) expect(c.doc.spaceSlug).toBe('grafana-migration');
    });

    it('follows the Grafana folder with --dashboards-tf', () => {
        const spaces = byFolder.dashboards().map((d) => d.doc.spaceSlug).sort();
        expect(spaces).toEqual([generateSlug('BCP/DR'), 'general', generateSlug('RDS')].sort());
        for (const d of byFolder.dashboards()) {
            const slugs = d.doc.tiles.filter((t) => t.type === 'sql_chart').map((t) => t.properties.chartSlug);
            for (const slug of slugs) expect(byFolder.chartBySlug(slug).spaceSlug).toBe(d.doc.spaceSlug);
        }
    });
});
