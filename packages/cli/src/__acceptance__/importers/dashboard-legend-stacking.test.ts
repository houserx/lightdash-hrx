/* eslint-disable */
// @ts-nocheck
// imp-dashboard-legend-stacking: legend placement and visibility, stacking, series colours
// and value mappings map as far as the SQL chart kind supports, with warnings otherwise.
import { chartTiles, grafanaDashboard, importGrafanaDashboards, panel } from './support';

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard('Legend And Stacking', [
            panel('timeseries', 'Stacked right legend', { x: 0, y: 0, w: 12, h: 8 }, {
                fieldConfig: { defaults: { custom: { stacking: { mode: 'normal', group: 'A' } } }, overrides: [] },
                options: { legend: { displayMode: 'list', placement: 'right', showLegend: true } },
            }),
            panel('barchart', 'Percent stacked bars', { x: 12, y: 0, w: 12, h: 8 }, {
                options: { stacking: 'percent', legend: { showLegend: true, placement: 'bottom', displayMode: 'list' } },
            }),
            panel('graph', 'Legacy stacked graph', { x: 0, y: 8, w: 12, h: 8 }, {
                stack: true,
                legend: { show: false },
            }),
            panel('table', 'Status table', { x: 12, y: 8, w: 12, h: 8 }, {
                fieldConfig: {
                    defaults: {
                        mappings: [{ type: 'value', options: { '0': { text: 'Down', color: 'red' }, '1': { text: 'Up', color: 'green' } } }],
                    },
                    overrides: [],
                },
            }),
        ]),
    ]);
});
afterAll(() => run?.cleanup());

const chart = (title) =>
    chartTiles(run, run.dashboards()[0].doc).find((t) => t.tile.properties.title === title).chart;

describe('legend, stacking and value mappings', () => {
    it('stacks normal stacking and places the legend', () => {
        const c = chart('Stacked right legend');
        const stack = c.config.display?.stack ?? c.config.fieldConfig?.stack;
        expect([true, 'stack']).toContain(stack);
        expect(c.config.display.legend.position).toBe('right');
    });

    it('keeps percent stacking as 100% stacking', () => {
        const c = chart('Percent stacked bars');
        expect(c.chartKind).toBe('vertical_bar');
        const stack = c.config.display?.stack ?? c.config.fieldConfig?.stack;
        expect(stack).toBe('stack100');
    });

    it('reads the legacy graph stack flag', () => {
        const c = chart('Legacy stacked graph');
        const stack = c.config.display?.stack ?? c.config.fieldConfig?.stack;
        expect([true, 'stack']).toContain(stack);
    });

    it('warns that SQL tables cannot apply value mappings', () => {
        const report = run.report(run.dashboards()[0].doc.slug);
        const lines = report.split('\n').filter((l) => l.includes('Status table'));
        expect(lines.join('\n')).toContain('fieldConfig.defaults.mappings');
    });
});
