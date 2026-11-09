/* eslint-disable */
// @ts-nocheck
// imp-dashboard-panel-kinds: each Grafana panel type lands where the viz line's panel mapping
// module (getGrafanaPanelMapping) says, on the closest SQL chart kind; where the SQL chart
// cannot be the mapped Lightdash chart type, the import says so with a chart-kind-fallback
// warning that names the intended type.
import { getGrafanaPanelMapping } from '@lightdash/common';
import {
    chartTiles,
    grafanaDashboard,
    importGrafanaDashboards,
    LOKI_DS,
    panel,
} from './support';

const PANELS = [
    ['timeseries', 'line'],
    ['graph', 'line'],
    ['barchart', 'vertical_bar'],
    ['piechart', 'pie'],
    ['table', 'table'],
    ['table-old', 'table'],
    ['stat', 'big_number'],
    ['gauge', 'big_number'],
    ['bargauge', null],
    ['logs', 'table'],
];

let run: any;
beforeAll(async () => {
    run = await importGrafanaDashboards([
        grafanaDashboard(
            'Panel Kinds',
            [
                ...PANELS.map(([type], i) =>
                    panel(type, `Panel ${type}`, { x: (i % 2) * 12, y: Math.floor(i / 2) * 8, w: 12, h: 8 },
                        type === 'logs'
                            ? { datasource: LOKI_DS, targets: [{ refId: 'A', datasource: LOKI_DS, expr: '{app="api"} |= "error"' }] }
                            : {}),
                ),
                panel('graph', 'Graph with bars', { x: 0, y: 48, w: 12, h: 8 }, { bars: true, lines: false }),
                panel('timeseries', 'Timeseries with bars', { x: 12, y: 48, w: 12, h: 8 }, {
                    fieldConfig: { defaults: { custom: { drawStyle: 'bars' } }, overrides: [] },
                }),
            ],
        ),
    ]);
});
afterAll(() => run?.cleanup());

const chartFor = (title: string) => {
    const dashboard = run.dashboards()[0].doc;
    return chartTiles(run, dashboard).find((t) => t.tile.properties.title === title)?.chart;
};

describe('panel types', () => {
    it('maps every chart panel type to a SQL chart kind', () => {
        for (const [type, kind] of PANELS) {
            const chart = chartFor(`Panel ${type}`);
            expect(chart, type).toBeDefined();
            if (kind) expect(chart.chartKind, type).toBe(kind);
            expect(chart.config.type).toBe(chart.chartKind);
        }
    });

    it('draws bars for bar-style graph and timeseries panels', () => {
        expect(chartFor('Graph with bars').chartKind).toBe('vertical_bar');
        expect(chartFor('Timeseries with bars').chartKind).toBe('vertical_bar');
    });

    it('warns when the mapped chart type is not available for SQL charts', () => {
        const report = run.report(run.dashboards()[0].doc.slug);
        const summary = run.summary();
        expect(summary.warnings.byCode['chart-kind-fallback']).toBeGreaterThanOrEqual(4);
        // The warning names the type the mapping module wanted.
        for (const type of ['gauge', 'stat', 'logs', 'bargauge']) {
            const mapping = getGrafanaPanelMapping(type);
            const wanted = mapping.registrySlug ?? mapping.chartType;
            expect(report).toContain(`Panel ${type}`);
            expect(report.toLowerCase()).toContain(String(wanted).toLowerCase());
        }
    });
});
