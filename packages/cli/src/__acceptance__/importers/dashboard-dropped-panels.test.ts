/* eslint-disable */
// @ts-nocheck
// imp-dashboard-dropped-panels: panel types the mapping drops (alertlist, dashlist, news) and
// panel options it drops are not imported, and each one is a structured warning, never a
// silent drop. Per-panel time overrides are warnings too.
import { grafanaDashboard, importGrafanaDashboards, panel } from './support';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Dropped Things', [
            panel('alertlist', 'Firing alerts', { x: 0, y: 0, w: 8, h: 6 }, { targets: [], options: { maxItems: 10 } }),
            panel('dashlist', 'Other dashboards', { x: 8, y: 0, w: 8, h: 6 }, { targets: [] }),
            panel('news', 'Grafana blog', { x: 16, y: 0, w: 8, h: 6 }, { targets: [], options: { feedUrl: 'https://example.test/feed' } }),
            panel('timeseries', 'Styled lines', { x: 0, y: 6, w: 24, h: 8 }, {
                timeFrom: '24h',
                timeShift: '1d',
                fieldConfig: {
                    defaults: { custom: { lineWidth: 3, gradientMode: 'opacity' } },
                    overrides: [],
                },
                options: { tooltip: { mode: 'single' } },
            }),
        ]),
    ]);
});
afterAll(() => run?.cleanup());

describe('dropped panels and options', () => {
    it('imports no tile for a dropped panel type', () => {
        const dashboard = run.dashboards()[0].doc;
        const titles = dashboard.tiles.map((t) => t.properties?.title ?? t.properties?.text);
        for (const title of ['Firing alerts', 'Other dashboards', 'Grafana blog']) {
            expect(titles).not.toContain(title);
        }
        expect(run.charts()).toHaveLength(1);
    });

    it('warns once per dropped panel, with the mapping reason', () => {
        const summary = run.summary();
        expect(summary.warnings.byCode['panel-dropped']).toBe(3);
        const report = run.report(run.dashboards()[0].doc.slug);
        expect(report).toContain('Firing alerts');
        expect(report).toContain('ADR 0001');
    });

    it('warns about each dropped option the panel sets', () => {
        const report = run.report(run.dashboards()[0].doc.slug);
        expect(run.summary().warnings.byCode['option-dropped']).toBeGreaterThanOrEqual(3);
        for (const option of [
            'fieldConfig.defaults.custom.lineWidth',
            'fieldConfig.defaults.custom.gradientMode',
            'options.tooltip.mode',
        ]) {
            expect(report).toContain(option);
        }
    });

    it('warns about per-panel time overrides', () => {
        const report = run.report(run.dashboards()[0].doc.slug);
        expect(report).toContain('timeFrom');
        expect(report).toContain('timeShift');
    });
});
